import { randomUUID } from "node:crypto";
import { ATTRIBUTION_MODELS, localDateRangeToUtc, type AttributionModel } from "@tracker/domain";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../context";
import { badRequest, conflict, notFound } from "../lib/errors";
import { audit, jsonSafe, orgSystemTx, orgTx } from "../lib/org-tx";
import { assertPermission, assertProjectAccess } from "../services/auth";
import { computeBreakdown } from "../services/breakdown";
import { orderScopeSql } from "../services/metrics-repo";

/**
 * Políticas de atribuição (R16-01, R16-02, R16-06, R16-07). A política "default" é a principal (vendas, painel,
 * webhooks); outras políticas existem para comparação. Alterar modelo/janela cria NOVA VERSÃO imutável; resultados
 * antigos ficam no histórico. Recalcular gera novas versões de resultado e nunca reenvia Purchase.
 */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const WINDOWS = [1, 7, 14, 30] as const;
const RECOMPUTE_LIMIT = 5000;
const modelEnum = z.enum(ATTRIBUTION_MODELS as unknown as [AttributionModel, ...AttributionModel[]]);
const windowDays = z.number().int().refine((w) => (WINDOWS as readonly number[]).includes(w), "Janela: 1, 7, 14 ou 30 dias");

const MODEL_LABELS: Record<string, string> = {
  first_touch: "Primeiro toque",
  last_touch: "Último toque",
  last_non_direct: "Último não direto",
  first_paid_click: "Primeiro clique pago elegível",
  last_paid_click: "Último clique pago elegível",
  explicit_order: "Atribuição explícita ao pedido",
  linear: "Linear (análise adicional)",
};

function slugify(name: string) {
  const base = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return base || "politica";
}

export const attributionRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.get("/attribution/policies", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      return orgTx(deps, req, async (c) => {
        const rows = (
          await c.query(
            `select policy_key, name, version, model, window_days, is_default, is_active, created_at
               from public.attribution_policies order by policy_key = 'default' desc, policy_key, version desc`,
          )
        ).rows;
        const byKey = new Map<string, { policy_key: string; current: unknown; versions: unknown[] }>();
        for (const r of rows) {
          const g: { policy_key: string; current: unknown; versions: unknown[] } = byKey.get(r.policy_key) ?? { policy_key: r.policy_key, current: null, versions: [] };
          if (r.is_active && !g.current) g.current = { ...r, model_label: MODEL_LABELS[r.model] ?? r.model };
          g.versions.push({ ...r, model_label: MODEL_LABELS[r.model] ?? r.model });
          byKey.set(r.policy_key, g);
        }
        return jsonSafe({ policies: [...byKey.values()], models: MODEL_LABELS, windows: WINDOWS });
      });
    });

    app.post("/attribution/policies", async (req, reply) => {
      assertPermission(req.auth, req.org, "attribution.manage");
      const body = z
        .object({ name: z.string().trim().min(1).max(120), model: modelEnum, window_days: windowDays })
        .parse(req.body);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const active = (await c.query("select count(distinct policy_key)::int as n from public.attribution_policies where is_active")).rows[0].n;
        if (active >= 6) throw conflict("too_many_policies", "Limite de 6 políticas ativas (cada uma é recalculada a cada venda)");
        let key = slugify(body.name);
        const taken = new Set((await c.query("select distinct policy_key from public.attribution_policies")).rows.map((r) => r.policy_key));
        if (key === "default" || taken.has(key)) key = `${key}_${randomUUID().slice(0, 6)}`;
        await c.query(
          "insert into public.attribution_policies (organization_id, policy_key, name, version, model, window_days, is_default, created_by) values ($1, $2, $3, 1, $4, $5, false, $6)",
          [org.id, key, body.name, body.model, body.window_days, auth.userId],
        );
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "attribution_policy.created", targetType: "attribution_policy", targetId: null, details: { policy_key: key, ...body }, requestId: req.id });
        reply.status(201);
        return { policy_key: key, version: 1, note: "Vendas existentes não têm resultado nesta política até o recálculo do período." };
      });
    });

    // Nova versão imutável (a anterior fica inativa e preservada com seus resultados).
    app.put("/attribution/policies/:key", async (req) => {
      assertPermission(req.auth, req.org, "attribution.manage", { sensitive: true });
      const { key } = z.object({ key: z.string().regex(/^[a-z0-9_]{1,60}$/) }).parse(req.params);
      const body = z
        .object({ name: z.string().trim().min(1).max(120).optional(), model: modelEnum.optional(), window_days: windowDays.optional() })
        .parse(req.body);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const cur = (await c.query("select * from public.attribution_policies where policy_key = $1 and is_active for update", [key])).rows[0];
        if (!cur) throw notFound("Política não encontrada");
        const next = { name: body.name ?? cur.name, model: body.model ?? cur.model, window_days: body.window_days ?? cur.window_days };
        if (next.model === cur.model && next.window_days === cur.window_days && next.name === cur.name) throw badRequest("no_change", "Nada mudou");
        await c.query("update public.attribution_policies set is_active = false where id = $1", [cur.id]);
        const r = await c.query(
          "insert into public.attribution_policies (organization_id, policy_key, name, version, model, window_days, is_default, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning version",
          [org.id, key, next.name, cur.version + 1, next.model, next.window_days, cur.is_default, auth.userId],
        );
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "attribution_policy.versioned", targetType: "attribution_policy", targetId: cur.id, details: { policy_key: key, from: { model: cur.model, window_days: cur.window_days, version: cur.version }, to: { ...next, version: r.rows[0].version } }, requestId: req.id });
        return { policy_key: key, version: r.rows[0].version, note: "Novas vendas usam a nova versão; recalcule o período para atualizar vendas anteriores (o histórico é preservado)." };
      });
    });

    app.delete("/attribution/policies/:key", async (req) => {
      assertPermission(req.auth, req.org, "attribution.manage");
      const { key } = z.object({ key: z.string().regex(/^[a-z0-9_]{1,60}$/) }).parse(req.params);
      if (key === "default") throw badRequest("default_policy", "A política principal não pode ser desativada; crie nova versão para alterá-la");
      return orgTx(deps, req, async (c, { auth, org }) => {
        const r = await c.query("update public.attribution_policies set is_active = false where policy_key = $1 and is_active returning id", [key]);
        if (!r.rows[0]) throw notFound("Política não encontrada");
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "attribution_policy.deactivated", targetType: "attribution_policy", targetId: r.rows[0].id, details: { policy_key: key }, requestId: req.id });
        return { ok: true };
      });
    });

    // Recálculo explícito do período: novas versões de resultado; nunca Purchase (R16-07, T27).
    app.post("/attribution/recompute", async (req) => {
      assertPermission(req.auth, req.org, "attribution.manage", { sensitive: true });
      const body = z.object({ from: date, to: date, project_id: z.string().uuid().optional() }).parse(req.body);
      if (body.project_id) assertProjectAccess(req.org!, body.project_id);
      const range = localDateRangeToUtc(body.from, body.to, req.org!.timezone);
      return orgSystemTx(deps, req, async (c, { auth, org }) => {
        const projectIds = body.project_id ? [body.project_id] : org.projectIds;
        const orders = (
          await c.query(
            `select id from public.orders where first_approved_at >= $1 and first_approved_at < $2 and ($3::uuid[] is null or project_id = any($3)) and not is_demo
              order by first_approved_at limit $4`,
            [range.start, range.end, projectIds, RECOMPUTE_LIMIT + 1],
          )
        ).rows;
        if (orders.length > RECOMPUTE_LIMIT) throw badRequest("too_many_orders", `Período com mais de ${RECOMPUTE_LIMIT} vendas: divida em intervalos menores`);
        const run = randomUUID();
        for (const o of orders) {
          await c.query("insert into public.outbox (organization_id, topic, payload, dedup_key, priority) values ($1, 'attribution.compute', $2, $3, 8)", [
            org.id, JSON.stringify({ order_id: o.id }), `attr-recompute:${run}:${o.id}`,
          ]);
        }
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "attribution.recompute_requested", details: { ...body, orders: orders.length, run }, requestId: req.id });
        return { queued: orders.length, run };
      });
    });

    // Comparação entre políticas ativas no mesmo período: categorias por pedido e receita creditada por rede.
    app.get("/attribution/compare", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      const q = z.object({ from: date, to: date, project_id: z.string().uuid().optional() }).parse(req.query);
      if (q.project_id) assertProjectAccess(req.org!, q.project_id);
      return orgTx(deps, req, async (c, { org }) => {
        const scope = {
          organizationId: org.id,
          projectIds: q.project_id ? [q.project_id] : org.projectIds,
          from: q.from,
          to: q.to,
          timezone: org.timezone,
          basis: "approval" as const,
          asOf: deps.now(),
          includeTest: false,
        };
        const { params, periodOrders, entryWindow } = orderScopeSql(scope);
        const policies = (await c.query("select policy_key, name, version, model, window_days from public.attribution_policies where is_active order by policy_key = 'default' desc, policy_key")).rows;
        const out = [];
        for (const p of policies) {
          const cats = (
            await c.query(
              `with po as (${periodOrders}),
               per_order as (
                 select f.order_id, f.currency, sum(f.amount_minor) filter (where f.entry_type = 'approval') as approved
                   from public.financial_entries f join po on po.id = f.order_id where ${entryWindow} group by f.order_id, f.currency)
               select trim(po.currency) as currency, coalesce(a.category, 'not_computed') as category, count(*)::int as orders, coalesce(sum(po.approved), 0)::bigint as gross
                 from per_order po left join public.order_attributions a on a.order_id = po.order_id and a.is_current and a.policy_key = $7
                where po.approved > 0 group by 1, 2 order by 1, 2`,
              [...params, p.policy_key],
            )
          ).rows;
          const networks = await computeBreakdown(c, { ...scope, policyKey: p.policy_key, dimension: "network", campaignId: null });
          out.push({
            ...p,
            model_label: MODEL_LABELS[p.model] ?? p.model,
            categories: cats,
            networks: networks.map((g) => ({ currency: g.currency, rows: g.rows.map((r) => ({ network: r.network, orders_credit: r.orders_credit, attributed_gross_minor: r.attributed_gross_minor })) })),
          });
        }
        return jsonSafe({ scope: { from: q.from, to: q.to, timezone: org.timezone }, policies: out, note: "Categorias por pedido; receita por rede usa os créditos de cada política (modelos fracionados somam 1 por pedido)." });
      });
    });
  };
