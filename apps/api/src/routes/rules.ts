import { evaluateRule, type RuleEvaluation } from "@tracker/analytics";
import {
  DECISION_LABEL,
  MEDIA_ACTIONS,
  RULE_ACTIONS,
  RULE_LEVELS,
  RULE_METRICS,
  RULE_OPS,
  RULE_PERIODS,
  RULE_PERIOD_LABEL,
  RULE_PRESETS,
  RULE_SCHEDULES,
  isValidHhMm,
  localDateOf,
  validateRuleDefinition,
  zonedWallTimeToUtc,
  type RuleDefinition,
} from "@tracker/domain";
import type { PoolClient } from "@tracker/db";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppDeps, OrgInfo } from "../context";
import { badRequest, conflict, notFound } from "../lib/errors";
import { audit, orgSystemTx, orgTx } from "../lib/org-tx";
import { assertPermission, assertProjectAccess } from "../services/auth";

/**
 * Regras e automações (R26, R23-11). Criar/editar/simular exige `rules.activate`; ativar também exige MFA nos perfis
 * sensíveis e, para ações de mídia, `media.execute` — que hoje ficam indisponíveis (sem conector de gestão).
 * Ativação só depois de uma simulação da versão atual nas últimas 24 h (R26-12).
 */

const decimal = z.string().trim().max(20).regex(/^-?\d*(\.\d+)?$/, "número decimal com ponto");
const condition: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ metric: z.enum(Object.keys(RULE_METRICS) as [string, ...string[]]), op: z.enum(RULE_OPS), value: z.string().trim().max(40) }).strict(),
    z.object({ op: z.enum(["and", "or"]), items: z.array(condition).min(1).max(10) }).strict(),
  ]),
);
const action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("notify") }).strict(),
  z.object({ type: z.literal("webhook"), subscription_id: z.string().uuid() }).strict(),
  z.object({ type: z.literal("tag"), tag: z.string().trim().min(1).max(40) }).strict(),
  z.object({ type: z.literal("pause") }).strict(),
  z.object({ type: z.literal("activate") }).strict(),
  z.object({ type: z.literal("budget"), mode: z.enum(["percent", "absolute"]), value: decimal, min: decimal.optional(), max: decimal.optional() }).strict(),
  z.object({ type: z.literal("duplicate") }).strict(),
]);
export const ruleDefinitionSchema = z
  .object({
    level: z.enum(RULE_LEVELS),
    currency: z.string().regex(/^[A-Z]{3}$/),
    scope: z
      .object({
        project_ids: z.array(z.string().uuid()).max(50).default([]),
        network: z.string().max(20).nullable().default(null),
        name_contains: z.string().trim().max(120).nullable().default(null),
        entity_ids: z.array(z.string().trim().min(1).max(64)).max(200).default([]),
      })
      .strict(),
    evaluation: z
      .object({
        period: z.enum(RULE_PERIODS),
        attribution_policy: z.string().regex(/^[a-z0-9_-]{1,40}$/).default("default"),
        conversion_delay_hours: z.number().int().min(0).max(72).default(0),
        min_spend: decimal.nullable().default(null),
        min_orders: decimal.nullable().default(null),
        min_impressions: decimal.nullable().default(null),
        min_age_days: z.number().int().min(0).max(60).default(3),
        require_fresh_spend: z.boolean().default(true),
      })
      .strict(),
    condition: z.object({ op: z.enum(["and", "or"]), items: z.array(condition).min(1).max(10) }).strict(),
    actions: z.array(action).min(1).max(5),
    limits: z
      .object({
        cooldown_minutes: z.number().int().min(15).max(7 * 1440),
        max_actions_per_day: z.number().int().min(1).max(500),
        max_budget_change_pct: z.number().min(1).max(100).nullable().default(20),
        budget_ceiling: decimal.nullable().default(null),
      })
      .strict(),
    schedule: z
      .object({
        every_minutes: z.number().int().refine((v) => (RULE_SCHEDULES as readonly number[]).includes(v), "frequência inválida"),
        active_hours: z.object({ start: z.string().refine(isValidHhMm), end: z.string().refine(isValidHhMm) }).strict().nullable().default(null),
      })
      .strict(),
    conflict: z.enum(["skip", "override"]).default("skip"),
  })
  .strict();

function parseDefinition(raw: unknown): RuleDefinition {
  const def = ruleDefinitionSchema.parse(raw) as RuleDefinition;
  const errors = validateRuleDefinition(def);
  if (errors.length) throw badRequest("invalid_rule", errors.join("; "), { errors });
  return def;
}

async function checkScope(c: PoolClient, org: OrgInfo, def: RuleDefinition) {
  for (const p of def.scope.project_ids) assertProjectAccess(org, p);
  // Membro restrito a projetos só cria regras dentro deles (não avalia dados de outros projetos).
  if (org.projectIds && !def.scope.project_ids.length) throw badRequest("project_scope_required", "Selecione os projetos da regra (seu acesso é restrito a projetos)");
  if (def.scope.project_ids.length) {
    const n = (await c.query("select count(*)::int as n from public.projects where id = any($1)", [def.scope.project_ids])).rows[0].n;
    if (n !== new Set(def.scope.project_ids).size) throw badRequest("invalid_project", "Projeto inexistente no escopo");
  }
  const policy = (await c.query("select 1 from public.attribution_policies where policy_key = $1 and is_active limit 1", [def.evaluation.attribution_policy])).rows[0];
  if (!policy) throw badRequest("invalid_policy", `Política de atribuição inexistente: ${def.evaluation.attribution_policy}`);
  for (const a of def.actions) {
    if (a.type !== "webhook") continue;
    const s = (await c.query("select status, events from public.webhook_subscriptions where id = $1", [a.subscription_id])).rows[0];
    if (!s) throw badRequest("invalid_subscription", "Assinatura de webhook inexistente");
    if (!s.events.includes("rule.triggered")) throw badRequest("invalid_subscription", 'A assinatura precisa do evento "rule.triggered"');
  }
}

function serializeEval(ev: RuleEvaluation) {
  return {
    as_of: ev.asOf.toISOString(),
    window: ev.window,
    freshness: ev.freshness,
    truncated: ev.truncated,
    notes: ev.notes,
    entities: ev.entities.map((e) => ({ level: e.level, id: e.id, name: e.name, metrics: e.metrics, decision: e.decision.kind, decision_label: DECISION_LABEL[e.decision.kind], explanation: e.decision.explanation, evaluation: e.decision.evaluation })),
  };
}

export const ruleRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.get("/rules/catalog", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      const cur = req.org!.currency;
      return {
        metrics: Object.entries(RULE_METRICS).map(([key, m]) => ({ key, ...m })),
        actions: RULE_ACTIONS.map((t) => ({
          type: t,
          label: { notify: "Notificar", webhook: "Chamar webhook", tag: "Adicionar tag interna", pause: "Pausar na rede", activate: "Ativar na rede", budget: "Ajustar orçamento", duplicate: "Duplicar" }[t],
          availability: MEDIA_ACTIONS.has(t) ? "planned" : "active",
          unavailable_reason: MEDIA_ACTIONS.has(t) ? "Gestão de campanhas pela API da rede depende do app Meta aprovado (DEP-META-APP); só simulação" : null,
        })),
        periods: RULE_PERIODS.map((p) => ({ key: p, label: RULE_PERIOD_LABEL[p] })),
        schedules: RULE_SCHEDULES,
        levels: RULE_LEVELS,
        presets: RULE_PRESETS.map((p) => ({ key: p.key, name: p.name, description: p.description, required: p.required, definition: p.definition(cur) })),
        notes: ["Exemplos vêm desligados e sem limites prontos: preencha com os números do seu negócio.", "Simulação verifica a lógica com dados atuais/históricos; não prova que a regra aumentaria o lucro."],
      };
    });

    app.get("/rules", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      return orgTx(deps, req, async (c) => ({
        rules: (
          await c.query(
            `select r.id, r.name, r.description, r.status, r.status_reason, r.current_version, r.preset_key, r.last_run_at, r.next_run_at, r.activated_at, r.created_at,
                    v.definition->>'level' as level, v.definition->'actions' as actions,
                    (select json_build_object('id', x.id, 'status', x.status, 'mode', x.mode, 'summary', x.summary, 'skip_reason', x.skip_reason, 'started_at', x.started_at)
                       from public.rule_runs x where x.rule_id = r.id order by x.started_at desc limit 1) as last_run
               from public.rules r join public.rule_versions v on v.rule_id = r.id and v.version = r.current_version
              order by r.created_at desc`,
          )
        ).rows,
      }));
    });

    app.post("/rules", async (req, reply) => {
      assertPermission(req.auth, req.org, "rules.activate");
      const b = z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(500).optional(), definition: z.unknown(), preset_key: z.string().max(60).optional() }).parse(req.body);
      const def = parseDefinition(b.definition);
      return orgTx(deps, req, async (c, { auth, org }) => {
        await checkScope(c, org, def);
        const r = (await c.query("insert into public.rules (organization_id, name, description, preset_key, created_by) values ($1, $2, $3, $4, $5) returning id", [org.id, b.name, b.description ?? null, b.preset_key ?? null, auth.userId])).rows[0];
        await c.query("insert into public.rule_versions (organization_id, rule_id, version, definition, created_by) values ($1, $2, 1, $3, $4)", [org.id, r.id, JSON.stringify(def), auth.userId]);
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "rule.created", targetType: "rule", targetId: r.id, requestId: req.id });
        reply.status(201);
        return { id: r.id, version: 1, status: "draft" };
      });
    });

    app.get("/rules/:id", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return orgTx(deps, req, async (c) => {
        const r = (await c.query("select * from public.rules where id = $1", [id])).rows[0];
        if (!r) throw notFound("Regra não encontrada");
        const versions = (await c.query("select version, definition, created_by, created_at from public.rule_versions where rule_id = $1 order by version desc", [id])).rows;
        const lastSim = (await c.query("select id, started_at from public.rule_runs where rule_id = $1 and version = $2 and trigger = 'simulation' order by started_at desc limit 1", [id, r.current_version])).rows[0] ?? null;
        return { rule: r, definition: versions[0]?.definition, versions, last_simulation: lastSim };
      });
    });

    app.put("/rules/:id", async (req) => {
      assertPermission(req.auth, req.org, "rules.activate");
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const b = z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().trim().max(500).nullable().optional(), definition: z.unknown().optional() }).parse(req.body);
      const def = b.definition === undefined ? null : parseDefinition(b.definition);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const r = (await c.query("select id, status, current_version from public.rules where id = $1 for update", [id])).rows[0];
        if (!r) throw notFound("Regra não encontrada");
        let version = r.current_version as number;
        let status = r.status as string;
        if (def) {
          await checkScope(c, org, def);
          version++;
          await c.query("insert into public.rule_versions (organization_id, rule_id, version, definition, created_by) values ($1, $2, $3, $4, $5)", [org.id, id, version, JSON.stringify(def), auth.userId]);
          // Versão nova de regra ativa volta a só simular até ser simulada e ativada de novo.
          if (status === "active") status = "simulate";
        }
        await c.query("update public.rules set name = coalesce($2, name), description = case when $3::boolean then $4 else description end, current_version = $5, status = $6 where id = $1", [
          id, b.name ?? null, b.description !== undefined, b.description ?? null, version, status,
        ]);
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "rule.updated", targetType: "rule", targetId: id, details: { version }, requestId: req.id });
        return { id, version, status };
      });
    });

    app.delete("/rules/:id", async (req) => {
      assertPermission(req.auth, req.org, "rules.activate", { sensitive: true });
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const r = await c.query("delete from public.rules where id = $1", [id]);
        if (!r.rowCount) throw notFound("Regra não encontrada");
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "rule.deleted", targetType: "rule", targetId: id, requestId: req.id });
        return { ok: true };
      });
    });

    // Simulação sem escrita externa (R26-04): agora e, opcionalmente, ao fim de cada um dos N dias anteriores.
    const simulate = async (c: PoolClient, org: OrgInfo, def: RuleDefinition, ruleId: string | null, days: number) => {
      const o = (await c.query("select settings from public.organizations where id = $1", [org.id])).rows[0];
      const zero = o?.settings?.cost_policy?.declared_zero ?? [];
      const now = deps.now();
      const points: Date[] = [now];
      const today = localDateOf(now, org.timezone);
      for (let d = 1; d <= days; d++) {
        const t = new Date(`${today}T12:00:00Z`);
        t.setUTCDate(t.getUTCDate() - d);
        const [y, m, dd] = t.toISOString().slice(0, 10).split("-").map(Number);
        points.push(new Date(zonedWallTimeToUtc({ year: y!, month: m!, day: dd!, hour: 23, minute: 59, second: 59 }, org.timezone).getTime()));
      }
      const out = [];
      for (const at of points) out.push(await evaluateRule(c, { organizationId: org.id, ruleId, definition: def, mode: "simulate", now: at, timezone: org.timezone, declaredZeroCosts: zero }));
      return out;
    };

    app.post("/rules/simulate", async (req) => {
      assertPermission(req.auth, req.org, "rules.activate");
      const b = z.object({ definition: z.unknown(), days: z.number().int().min(0).max(14).default(0) }).parse(req.body);
      const def = parseDefinition(b.definition);
      return orgTx(deps, req, async (c, { org }) => {
        await checkScope(c, org, def);
        const evs = await simulate(c, org, def, null, b.days);
        return { saved: false, evaluations: evs.map(serializeEval), notes: ["Simulação não executa nenhuma ação.", "Resultado histórico verifica a lógica; não prova efeito causal."] };
      });
    });

    app.post("/rules/:id/simulate", async (req) => {
      assertPermission(req.auth, req.org, "rules.activate");
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const b = z.object({ days: z.number().int().min(0).max(14).default(0) }).parse(req.body ?? {});
      return orgSystemTx(deps, req, async (c, { auth, org }) => {
        const r = (await c.query("select id, current_version from public.rules where id = $1", [id])).rows[0];
        if (!r) throw notFound("Regra não encontrada");
        const def = (await c.query("select definition from public.rule_versions where rule_id = $1 and version = $2", [id, r.current_version])).rows[0].definition as RuleDefinition;
        for (const p of def.scope.project_ids) assertProjectAccess(org, p);
        const evs = await simulate(c, org, def, id, b.days);
        const runs = [];
        for (const ev of evs) {
          const summary: Record<string, number> = {};
          for (const e of ev.entities) summary[e.decision.kind] = (summary[e.decision.kind] ?? 0) + 1;
          const run = (
            await c.query(
              `insert into public.rule_runs (organization_id, rule_id, version, trigger, mode, status, as_of, window_from, window_to, context, summary, created_by, finished_at)
               values ($1, $2, $3, 'simulation', 'simulate', 'ok', $4, $5, $6, $7, $8, $9, now()) returning id`,
              [org.id, id, r.current_version, ev.asOf, ev.window.from, ev.window.to, JSON.stringify({ freshness: ev.freshness, notes: ev.notes, truncated: ev.truncated }), JSON.stringify(summary), auth.userId],
            )
          ).rows[0].id;
          for (const e of ev.entities) {
            await c.query(
              "insert into public.rule_decisions (organization_id, run_id, entity_level, entity_id, entity_name, decision, explanation, metrics, evaluation) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
              [org.id, run, e.level, e.id, e.name.slice(0, 300), e.decision.kind, e.decision.explanation.slice(0, 4000), JSON.stringify(e.metrics), JSON.stringify(e.decision.evaluation)],
            );
          }
          runs.push(run);
        }
        return { saved: true, run_ids: runs, version: r.current_version, evaluations: evs.map(serializeEval), notes: ["Simulação não executa nenhuma ação.", "Resultado histórico verifica a lógica; não prova efeito causal."] };
      });
    });

    // Avaliação agendada sem execução ("sombra"): mostra o que a regra faria ao longo do tempo.
    app.post("/rules/:id/shadow", async (req) => {
      assertPermission(req.auth, req.org, "rules.activate");
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const r = await c.query("update public.rules set status = 'simulate', status_reason = null, next_run_at = $2 where id = $1 returning id", [id, deps.now()]);
        if (!r.rowCount) throw notFound("Regra não encontrada");
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "rule.shadow", targetType: "rule", targetId: id, requestId: req.id });
        return { status: "simulate" };
      });
    });

    app.post("/rules/:id/activate", async (req) => {
      assertPermission(req.auth, req.org, "rules.activate", { sensitive: true });
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const r = (await c.query("select id, current_version from public.rules where id = $1 for update", [id])).rows[0];
        if (!r) throw notFound("Regra não encontrada");
        const def = (await c.query("select definition from public.rule_versions where rule_id = $1 and version = $2", [id, r.current_version])).rows[0].definition as RuleDefinition;
        const media = def.actions.filter((a) => MEDIA_ACTIONS.has(a.type)).map((a) => a.type);
        if (media.length) {
          if (!org.permissions.has("media.execute")) throw badRequest("permission_denied", "Ações de mídia exigem a permissão media.execute");
          throw conflict("capability_unavailable", `Ações ${media.join(", ")} dependem da gestão de campanhas pela API da rede (DEP-META-APP). Remova-as para ativar ou mantenha a regra em simulação.`);
        }
        const sim = (await c.query("select 1 from public.rule_runs where rule_id = $1 and version = $2 and trigger = 'simulation' and started_at > $3::timestamptz - interval '24 hours' limit 1", [id, r.current_version, deps.now()])).rows[0];
        if (!sim) throw conflict("simulation_required", "Simule a versão atual da regra antes de ativar (simulação nas últimas 24 h)");
        await c.query("update public.rules set status = 'active', status_reason = null, consecutive_failures = 0, activated_by = $2, activated_at = $3, next_run_at = $3 where id = $1", [id, auth.userId, deps.now()]);
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "rule.activated", targetType: "rule", targetId: id, details: { version: r.current_version }, requestId: req.id });
        return { status: "active", version: r.current_version };
      });
    });

    app.post("/rules/:id/pause", async (req) => {
      assertPermission(req.auth, req.org, "rules.activate");
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const b = z.object({ reason: z.string().trim().max(200).optional() }).parse(req.body ?? {});
      return orgTx(deps, req, async (c, { auth, org }) => {
        const r = await c.query("update public.rules set status = 'paused', status_reason = $2 where id = $1 returning id", [id, b.reason ?? "Pausada manualmente"]);
        if (!r.rowCount) throw notFound("Regra não encontrada");
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "rule.paused", targetType: "rule", targetId: id, requestId: req.id });
        return { status: "paused" };
      });
    });

    app.get("/rules/:id/runs", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(req.query);
      return orgTx(deps, req, async (c) => ({
        runs: (await c.query("select id, version, trigger, mode, status, skip_reason, as_of, window_from, window_to, summary, context, started_at, finished_at from public.rule_runs where rule_id = $1 order by started_at desc limit $2", [id, q.limit])).rows,
        actions: (await c.query("select id, run_id, entity_level, entity_id, action_type, status, detail, executed_at from public.rule_actions where rule_id = $1 order by executed_at desc limit 100", [id])).rows,
      }));
    });

    app.get("/rule-runs/:id", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return orgTx(deps, req, async (c) => {
        const run = (await c.query("select * from public.rule_runs where id = $1", [id])).rows[0];
        if (!run) throw notFound("Execução não encontrada");
        const decisions = (await c.query("select entity_level, entity_id, entity_name, decision, explanation, metrics, evaluation, actions from public.rule_decisions where run_id = $1 order by id limit 500", [id])).rows;
        return { run, decisions: decisions.map((d) => ({ ...d, decision_label: DECISION_LABEL[d.decision as keyof typeof DECISION_LABEL] ?? d.decision })) };
      });
    });

    // Reversão limitada (R26-12): só a tag interna é desfeita; notificação e webhook já entregues não têm volta.
    app.post("/rule-actions/:id/undo", async (req) => {
      assertPermission(req.auth, req.org, "rules.activate");
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return orgSystemTx(deps, req, async (c, { auth, org }) => {
        const a = (await c.query("select a.*, r.current_version from public.rule_actions a join public.rules r on r.id = a.rule_id where a.id = $1", [id])).rows[0];
        if (!a) throw notFound("Ação não encontrada");
        if (a.action_type !== "tag" || a.status !== "executed") throw badRequest("not_reversible", "Só a ação de tag interna pode ser desfeita; notificações e webhooks entregues não têm volta");
        const def = (await c.query("select definition from public.rule_versions where rule_id = $1 and version = $2", [a.rule_id, a.version])).rows[0].definition as RuleDefinition;
        const tag = def.actions.find((x) => x.type === "tag") as { tag: string } | undefined;
        if (tag) await c.query("delete from public.entity_tags where entity_level = $1 and entity_id = $2 and tag = $3 and rule_id = $4", [a.entity_level, a.entity_id, tag.tag, a.rule_id]);
        await c.query("update public.rule_actions set detail = coalesce(detail, '') || ' · desfeita' where id = $1", [id]);
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "rule_action.undone", targetType: "rule_action", targetId: id, requestId: req.id });
        return { ok: true };
      });
    });

    // Paradas de emergência (R26-11): organização e projeto aqui; sistema por RULES_KILL_SWITCH no ambiente.
    app.get("/rules/kill-switch", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      return orgTx(deps, req, async (c) => ({
        system: process.env.RULES_KILL_SWITCH === "true",
        organization: Boolean((await c.query("select settings->'rules_paused' as p from public.organizations")).rows[0]?.p),
        projects: (await c.query("select project_id, reason, paused_at from public.rule_project_pauses")).rows,
      }));
    });

    app.put("/rules/kill-switch", async (req) => {
      assertPermission(req.auth, req.org, "rules.activate");
      const b = z.object({ organization: z.boolean().optional(), project_id: z.string().uuid().optional(), project_paused: z.boolean().optional(), reason: z.string().trim().max(200).optional() }).strict().parse(req.body);
      return orgTx(deps, req, async (c, { auth, org }) => {
        if (b.organization !== undefined) {
          await c.query("update public.organizations set settings = jsonb_set(settings, '{rules_paused}', to_jsonb($2::boolean)) where id = $1", [org.id, b.organization]);
        }
        if (b.project_id) {
          assertProjectAccess(org, b.project_id);
          if (b.project_paused) await c.query("insert into public.rule_project_pauses (organization_id, project_id, reason, paused_by) values ($1, $2, $3, $4) on conflict (organization_id, project_id) do nothing", [org.id, b.project_id, b.reason ?? null, auth.userId]);
          else await c.query("delete from public.rule_project_pauses where project_id = $1", [b.project_id]);
        }
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "rules.kill_switch", details: b, requestId: req.id });
        return { ok: true };
      });
    });
  };
