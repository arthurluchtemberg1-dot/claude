import { evaluateRule, type EvaluatedEntity } from "@tracker/analytics";
import type { PoolClient } from "@tracker/db";
import { DECISION_LABEL, MEDIA_ACTIONS, inQuietHours, isRole, roleHas, type RuleAction, type RuleDefinition } from "@tracker/domain";
import { OUTBOUND_API_VERSION } from "./webhooks-out";
import { notify } from "./notifications";

/**
 * Execução de regras no worker (R26). Cada execução roda numa transação com lock da regra (sem execuções
 * concorrentes da mesma regra) e registra versão, contexto, decisões e ações. Ações:
 * - notify, webhook (assinatura escolhida) e tag interna: executadas;
 * - pausar/ativar/orçamento/duplicar: dependem do conector de gestão da rede, ainda indisponível — registradas como
 *   "skipped_capability" com o motivo (nunca simuladas como se tivessem ocorrido).
 * Travas: parada do sistema/organização/projeto, relógio, permissão de quem ativou, horário de atuação,
 * cooldown, teto diário, conflito, dados atrasados e circuit breaker por falhas consecutivas (R26-06..R26-11).
 */

export interface RuleRunDeps {
  /** RULES_KILL_SWITCH=true: nenhuma regra executa ações (simulações continuam). */
  systemKillSwitch: boolean;
  maxConsecutiveFailures?: number;
}

const MEDIA_UNAVAILABLE = "Gestão de campanhas pela API da rede ainda não disponível (DEP-META-APP); ação não executada";

/** Enfileira as regras vencidas da organização (chamado no ciclo do agendador). */
export async function scheduleDueRules(c: PoolClient, orgId: string, now: Date): Promise<number> {
  const due = (
    await c.query("select id, next_run_at from public.rules where organization_id = $1 and status in ('simulate', 'active') and (next_run_at is null or next_run_at <= $2)", [orgId, now])
  ).rows;
  let n = 0;
  for (const r of due) {
    const res = await c.query("insert into public.outbox (organization_id, topic, payload, dedup_key, priority, max_attempts) values ($1, 'rules.run', $2, $3, 6, 3) on conflict do nothing returning id", [
      orgId, JSON.stringify({ rule_id: r.id }), `rule:${r.id}:${r.next_run_at ? new Date(r.next_run_at).toISOString() : "first"}`,
    ]);
    n += res.rowCount ?? 0;
  }
  return n;
}

async function finishSkipped(c: PoolClient, orgId: string, rule: { id: string; current_version: number }, def: RuleDefinition, mode: string, reason: string, now: Date) {
  await c.query("insert into public.rule_runs (organization_id, rule_id, version, trigger, mode, status, skip_reason, as_of, finished_at) values ($1, $2, $3, 'schedule', $4, 'skipped', $5, $6, $6)", [
    orgId, rule.id, rule.current_version, mode, reason, now,
  ]);
  await c.query("update public.rules set last_run_at = $2, next_run_at = $2::timestamptz + make_interval(mins => $3) where id = $1", [rule.id, now, def.schedule.every_minutes]);
  return { status: "skipped" as const, reason };
}

export async function runRuleJob(c: PoolClient, deps: RuleRunDeps, orgId: string, ruleId: string, now: Date) {
  const rule = (await c.query("select * from public.rules where organization_id = $1 and id = $2 for update", [orgId, ruleId])).rows[0];
  if (!rule || !["simulate", "active"].includes(rule.status)) return { status: "skipped" as const, reason: "regra inexistente ou parada" };
  const def = (await c.query("select definition from public.rule_versions where organization_id = $1 and rule_id = $2 and version = $3", [orgId, ruleId, rule.current_version])).rows[0]?.definition as RuleDefinition;
  const org = (await c.query("select timezone, settings, is_demo from public.organizations where id = $1", [orgId])).rows[0];
  const mode: "simulate" | "execute" = rule.status === "active" ? "execute" : "simulate";

  if (mode === "execute") {
    if (deps.systemKillSwitch) return finishSkipped(c, orgId, rule, def, mode, "Parada de emergência do sistema ativa (RULES_KILL_SWITCH)", now);
    if (org.settings?.rules_paused) return finishSkipped(c, orgId, rule, def, mode, "Regras pausadas para toda a organização", now);
    // Relógio (circuit breaker): o horário do worker precisa bater com o do banco.
    const skew = Number((await c.query("select abs(extract(epoch from (now() - $1::timestamptz))) as s", [now])).rows[0].s);
    if (skew > 120) return finishSkipped(c, orgId, rule, def, mode, `Relógio do worker diverge do banco em ${Math.round(skew)} s; execução suspensa até corrigir`, now);
    // Permissão de quem ativou continua válida (perfil pode ter mudado ou o membro saído).
    const m = rule.activated_by ? (await c.query("select role from public.memberships where organization_id = $1 and user_id = $2 and status = 'active'", [orgId, rule.activated_by])).rows[0] : null;
    const needsMedia = def.actions.some((a) => MEDIA_ACTIONS.has(a.type));
    if (!m || !isRole(m.role) || !roleHas(m.role, "rules.activate") || (needsMedia && !roleHas(m.role, "media.execute"))) {
      const reason = "Quem ativou a regra não tem mais permissão para executá-la";
      await c.query("update public.rules set status = 'suspended', status_reason = $2 where id = $1", [ruleId, reason]);
      await notify(c, orgId, { kind: "rule.triggered", projectId: null, semanticKey: `rule.suspended:${ruleId}:${now.toISOString()}`, title: `Regra suspensa: ${rule.name}`, body: reason, link: `/automacao/${ruleId}`, onlyUnrestricted: true }, now);
      return finishSkipped(c, orgId, rule, def, mode, reason, now);
    }
  }
  if (def.schedule.active_hours && !inQuietHours(now, org.timezone, def.schedule.active_hours.start, def.schedule.active_hours.end)) {
    return finishSkipped(c, orgId, rule, def, mode, `Fora do horário de atuação (${def.schedule.active_hours.start}–${def.schedule.active_hours.end})`, now);
  }
  const paused = (await c.query("select project_id from public.rule_project_pauses where organization_id = $1", [orgId])).rows.map((r) => r.project_id as string);
  const ev = await evaluateRule(c, {
    organizationId: orgId,
    ruleId,
    definition: def,
    mode,
    now,
    timezone: org.timezone,
    declaredZeroCosts: org.settings?.cost_policy?.declared_zero ?? [],
    pausedProjectIds: mode === "execute" ? paused : [],
  });
  const summary: Record<string, number> = {};
  for (const e of ev.entities) summary[e.decision.kind] = (summary[e.decision.kind] ?? 0) + 1;
  const run = (
    await c.query(
      `insert into public.rule_runs (organization_id, rule_id, version, trigger, mode, status, as_of, window_from, window_to, context, summary)
       values ($1, $2, $3, 'schedule', $4, 'ok', $5, $6, $7, $8, $9) returning id`,
      [orgId, ruleId, rule.current_version, mode, ev.asOf, ev.window.from, ev.window.to, JSON.stringify({ freshness: ev.freshness, notes: ev.notes, truncated: ev.truncated, entities: ev.entities.length }), JSON.stringify(summary)],
    )
  ).rows[0].id as string;

  let failures = 0;
  for (const e of ev.entities) {
    const results = e.decision.kind === "execute" ? await executeActions(c, orgId, rule, def, run, e, now) : [];
    failures += results.filter((r) => r.status === "failed").length;
    await c.query(
      `insert into public.rule_decisions (organization_id, run_id, entity_level, entity_id, entity_name, decision, explanation, metrics, evaluation, actions)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [orgId, run, e.level, e.id, e.name.slice(0, 300), e.decision.kind, e.decision.explanation.slice(0, 4000), JSON.stringify(e.metrics), JSON.stringify(e.decision.evaluation), JSON.stringify(results)],
    );
  }
  const max = deps.maxConsecutiveFailures ?? 3;
  if (failures) {
    const f = (await c.query("update public.rules set consecutive_failures = consecutive_failures + 1 where id = $1 returning consecutive_failures", [ruleId])).rows[0].consecutive_failures;
    if (f >= max) {
      const reason = `${f} execuções seguidas com falha nas ações; regra suspensa automaticamente`;
      await c.query("update public.rules set status = 'suspended', status_reason = $2 where id = $1", [ruleId, reason]);
      await notify(c, orgId, { kind: "rule.triggered", projectId: null, semanticKey: `rule.suspended:${ruleId}:${now.toISOString()}`, title: `Regra suspensa: ${rule.name}`, body: reason, link: `/automacao/${ruleId}`, onlyUnrestricted: true }, now);
    }
  } else await c.query("update public.rules set consecutive_failures = 0 where id = $1", [ruleId]);
  await c.query("update public.rule_runs set finished_at = $2, status = case when $3 then 'failed' else status end where id = $1", [run, now, failures > 0]);
  await c.query("update public.rules set last_run_at = $2, next_run_at = $2::timestamptz + make_interval(mins => $3) where id = $1", [ruleId, now, def.schedule.every_minutes]);
  return { status: "ok" as const, runId: run, summary };
}

async function applyAction(
  c: PoolClient,
  orgId: string,
  rule: { id: string; name: string; current_version: number },
  def: RuleDefinition,
  runId: string,
  e: EvaluatedEntity,
  a: RuleAction,
  key: string,
  now: Date,
): Promise<{ status: "executed" | "failed" | "skipped_capability"; detail: string }> {
  const bucket = key.slice(key.lastIndexOf(":") + 1);
  if (MEDIA_ACTIONS.has(a.type)) return { status: "skipped_capability", detail: MEDIA_UNAVAILABLE };
  if (a.type === "notify") {
    const r = await notify(c, orgId, {
      kind: "rule.triggered",
      projectId: e.projectId ?? (def.scope.project_ids.length === 1 ? def.scope.project_ids[0]! : null),
      semanticKey: `rule.triggered:${rule.id}:${e.level}:${e.id ?? "-"}:${bucket}`,
      title: `${rule.name}: ${e.name}`.slice(0, 200),
      body: e.decision.explanation.replace(`${DECISION_LABEL.execute}. `, "").slice(0, 480),
      link: `/automacao/${rule.id}`,
      data: { rule_id: rule.id, run_id: runId },
      // Regra sobre várias campanhas/projetos: membros restritos a projetos não recebem dados de outros projetos.
      onlyUnrestricted: !e.projectId && def.scope.project_ids.length !== 1,
    }, now);
    return { status: "executed", detail: `${r.created} destinatário(s)` };
  }
  if (a.type === "webhook") {
    const s = (await c.query("select id from public.webhook_subscriptions where organization_id = $1 and id = $2 and status = 'active' and 'rule.triggered' = any(events)", [orgId, a.subscription_id])).rows[0];
    if (!s) return { status: "failed", detail: "Assinatura de webhook inativa ou sem o evento rule.triggered" };
    const eventId = `rule.triggered:${key}`;
    const payload = {
      id: eventId,
      type: "rule.triggered",
      created_at: now.toISOString(),
      api_version: OUTBOUND_API_VERSION,
      data: { rule: { id: rule.id, name: rule.name, version: rule.current_version }, entity: { level: e.level, id: e.id, name: e.name }, decision: e.decision.kind, explanation: e.decision.explanation, metrics: e.metrics, run_id: runId },
      provenance: { source: "rule", hop: 1 },
    };
    const d = await c.query(
      "insert into public.webhook_out_deliveries (organization_id, subscription_id, event_id, event_type, payload, hop) values ($1, $2, $3, 'rule.triggered', $4, 1) on conflict (organization_id, subscription_id, event_id) do nothing returning id",
      [orgId, s.id, eventId, JSON.stringify(payload)],
    );
    if (d.rows[0]) await c.query("insert into public.outbox (organization_id, topic, payload, dedup_key, priority) values ($1, 'webhooks.deliver', $2, $3, 7) on conflict do nothing", [orgId, JSON.stringify({ delivery_id: d.rows[0].id }), `whd:${d.rows[0].id}:1`]);
    return { status: "executed", detail: "Entrega de webhook enfileirada" };
  }
  if (a.type === "tag") {
    if (e.level === "project" || !e.id) return { status: "failed", detail: "Tag só se aplica a campanha, conjunto ou anúncio" };
    await c.query("insert into public.entity_tags (organization_id, entity_level, entity_id, tag, rule_id) values ($1, $2, $3, $4, $5) on conflict do nothing", [orgId, e.level, e.id, a.tag, rule.id]);
    return { status: "executed", detail: `Tag "${a.tag}" aplicada` };
  }
  return { status: "failed", detail: "Ação desconhecida" };
}

type ActionResult = { type: RuleAction["type"]; status: "executed" | "failed" | "skipped_capability" | "duplicate"; detail: string };

async function executeActions(c: PoolClient, orgId: string, rule: { id: string; name: string; current_version: number }, def: RuleDefinition, runId: string, e: EvaluatedEntity, now: Date): Promise<ActionResult[]> {
  // Janela de idempotência = intervalo mínimo: a mesma decisão repetida (retry do job) não duplica a ação.
  const bucket = Math.floor(now.getTime() / (def.limits.cooldown_minutes * 60_000));
  // Lock por entidade (R26-07): regras diferentes não agem na mesma entidade ao mesmo tempo.
  await c.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`rule-entity:${orgId}:${e.level}:${e.id ?? "-"}`]);
  const out: ActionResult[] = [];
  for (const a of def.actions) {
    const key = `${rule.id}:${rule.current_version}:${e.level}:${e.id ?? "-"}:${a.type}:${bucket}`;
    // Reserva a ação ANTES do efeito (mesma transação): repetição do job não repete o efeito.
    const reserved = await c.query(
      `insert into public.rule_actions (organization_id, rule_id, version, run_id, entity_level, entity_id, action_type, idempotency_key, status, executed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'executed', $9) on conflict (organization_id, idempotency_key) do nothing returning id`,
      [orgId, rule.id, rule.current_version, runId, e.level, e.id, a.type, key, now],
    );
    const actionId = reserved.rows[0]?.id as string | undefined;
    if (!actionId) {
      out.push({ type: a.type, status: "duplicate", detail: "Já executada nesta janela (idempotência)" });
      continue;
    }
    const r = await applyAction(c, orgId, rule, def, runId, e, a, key, now);
    // Falha libera a chave (registro fica para auditoria): a próxima execução tenta de novo e conta para o circuit breaker.
    await c.query("update public.rule_actions set status = $2, detail = $3, idempotency_key = case when $2 = 'failed' then idempotency_key || ':failed:' || id::text else idempotency_key end where id = $1", [
      actionId, r.status, r.detail,
    ]);
    out.push({ type: a.type, ...r });
  }
  return out;
}
