import { computeBreakdown, mediaWritesState, planMediaChange } from "@tracker/analytics";
import { addRatio, decimalToRatio, localDateRangeToUtc, mediaRowMetrics, parseRatio, ratio, ratioToDecimalString, type Ratio } from "@tracker/domain";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../context";
import { conflict } from "../lib/errors";
import { audit, jsonSafe, orgSystemTx, orgTx } from "../lib/org-tx";
import { assertPermission, assertProjectAccess } from "../services/auth";

/**
 * Gerenciador de campanhas (R25, R23-08): lista campanhas/conjuntos/anúncios com o estado da Meta (status, orçamento,
 * aprendizado) e as métricas do período (gasto sincronizado + vendas do checkout atribuídas por ID), e executa
 * alterações (pausar, ativar, orçamento, renomear, duplicar) pelo mesmo planejamento usado pelas regras.
 * Fórmulas no domínio (mediaRowMetrics); compras reportadas pela Meta ficam separadas das vendas confirmadas.
 */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const level = z.enum(["campaign", "adset", "ad"]);

interface EntityState {
  external_id: string;
  name: string | null;
  status: string | null;
  effective_status: string | null;
  daily_budget_minor: string | null;
  lifetime_budget_minor: string | null;
  budget_remaining_minor: string | null;
  learning_status: string | null;
  campaign_external_id: string | null;
  adset_external_id: string | null;
  created_time: Date | null;
  synced_at: Date | null;
  account_id: string;
  account_name: string | null;
  external_account_id: string;
  currency: string;
  network: string;
}

interface Row {
  id: string | null;
  name: string | null;
  spend_minor: bigint | null;
  impressions: bigint | null;
  link_clicks: bigint | null;
  orders_credit_fraction: string;
  attributed_gross_minor: bigint;
  attributed_net_minor: bigint;
  reported_purchases: Ratio | null;
  reported_purchase_value_minor: bigint | null;
  [k: string]: unknown;
}

export const mediaRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.get("/media/entities", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      const q = z
        .object({
          level: level.default("campaign"),
          from: date,
          to: date,
          project_id: z.string().uuid().optional(),
          account_id: z.string().uuid().optional(),
          campaign_id: z.string().trim().min(1).max(64).optional(),
          adset_id: z.string().trim().min(1).max(64).optional(),
          status: z.enum(["all", "active", "paused"]).default("all"),
          policy: z.string().max(60).default("default"),
        })
        .parse(req.query);
      if (q.project_id) assertProjectAccess(req.org!, q.project_id);
      localDateRangeToUtc(q.from, q.to, req.org!.timezone);
      return orgTx(deps, req, async (c, { org }) => {
        const projectIds = q.project_id ? [q.project_id] : org.projectIds;
        const groups = await computeBreakdown(c, {
          organizationId: org.id,
          projectIds,
          from: q.from,
          to: q.to,
          timezone: org.timezone,
          basis: "approval",
          asOf: deps.now(),
          includeTest: false,
          policyKey: q.policy,
          dimension: q.level,
          campaignId: q.campaign_id ?? null,
        });
        const ents = (
          await c.query(
            `select e.external_id, e.name, e.status, e.effective_status, e.daily_budget_minor::text, e.lifetime_budget_minor::text, e.budget_remaining_minor::text,
                    e.learning_status, e.campaign_external_id, e.adset_external_id, e.created_time, e.synced_at,
                    a.id as account_id, a.name as account_name, a.external_account_id, trim(a.currency) as currency, a.network
               from public.ad_entities e join public.ad_accounts a on a.organization_id = e.organization_id and a.id = e.ad_account_id
              where e.level = $1 and ($2::uuid is null or a.id = $2) and ($3::uuid[] is null or a.project_id is null or a.project_id = any($3))
                and ($4::text is null or (case when e.level = 'campaign' then e.external_id else e.campaign_external_id end) = $4)
                and ($5::text is null or (case when e.level = 'adset' then e.external_id else e.adset_external_id end) = $5)
                and coalesce(e.status, '') not in ('DELETED', 'ARCHIVED')`,
            [q.level, q.account_id ?? null, projectIds, q.campaign_id ?? null, q.adset_id ?? null],
          )
        ).rows as EntityState[];
        const entMap = new Map(ents.map((e) => [e.external_id, e]));
        // Nomes dos níveis acima (campanha do conjunto, conjunto do anúncio).
        const parentIds = [...new Set(ents.flatMap((e) => [e.campaign_external_id, e.adset_external_id]).filter((x): x is string => !!x))];
        const parents = parentIds.length
          ? new Map<string, string | null>((await c.query("select external_id, name from public.ad_entities where level in ('campaign', 'adset') and external_id = any($1)", [parentIds])).rows.map((r) => [r.external_id, r.name]))
          : new Map<string, string | null>();
        const reported = new Map<string, { n: Ratio | null; v: bigint | null }>(
          (
            await c.query(
              `select entity_external_id as id, sum(reported_purchases)::text as n, count(reported_purchases)::int as nn,
                      sum(reported_purchase_value_minor)::text as v, count(reported_purchase_value_minor)::int as nv
                 from public.ad_spend_daily where level = $1 and source = 'api' and spend_date between $2::date and $3::date
                  and ($4::uuid[] is null or project_id is null or project_id = any($4)) group by 1`,
              [q.level, q.from, q.to, projectIds],
            )
          ).rows.map((r) => [r.id, { n: r.nn ? decimalToRatio(r.n) : null, v: r.nv ? BigInt(r.v) : null }]),
        );
        const statusOk = (e: EntityState | undefined) => q.status === "all" || (e && (q.status === "active" ? e.status === "ACTIVE" : e.status === "PAUSED"));
        const entityFilter = !!(q.account_id || q.adset_id || q.status !== "all");

        const base: { currency: string; rows: (typeof groups)[number]["rows"]; totals: (typeof groups)[number]["totals"] | null; notes: string[] }[] = [...groups];
        for (const cur of new Set(ents.map((e) => e.currency))) if (!base.some((g) => g.currency === cur)) base.push({ currency: cur, rows: [], totals: null, notes: [] });

        const out = base.map((g) => {
          const seen = new Set<string>();
          const rows: Row[] = [];
          const state = (e: EntityState | undefined) =>
            e
              ? {
                  account: { id: e.account_id, name: e.account_name, external_id: e.external_account_id },
                  status: e.status,
                  effective_status: e.effective_status,
                  learning_status: e.learning_status,
                  daily_budget_minor: e.daily_budget_minor,
                  lifetime_budget_minor: e.lifetime_budget_minor,
                  budget_remaining_minor: e.budget_remaining_minor,
                  campaign_id: e.campaign_external_id,
                  campaign_name: e.campaign_external_id ? (parents.get(e.campaign_external_id) ?? null) : null,
                  adset_id: e.adset_external_id,
                  adset_name: e.adset_external_id ? (parents.get(e.adset_external_id) ?? null) : null,
                  created_time: e.created_time,
                  synced_at: e.synced_at,
                  manageable: e.network === "meta",
                }
              : { account: null, status: null, effective_status: null, learning_status: null, daily_budget_minor: null, lifetime_budget_minor: null, budget_remaining_minor: null, campaign_id: null, campaign_name: null, adset_id: null, adset_name: null, created_time: null, synced_at: null, manageable: false };
          for (const r of g.rows) {
            const e = r.id ? entMap.get(r.id) : undefined;
            if (entityFilter && (!e || !statusOk(e))) continue;
            if (r.id) seen.add(r.id);
            const rep = r.id ? reported.get(r.id) : undefined;
            const credit = parseRatio(r.orders_credit_fraction);
            rows.push({
              id: r.id,
              name: r.name ?? e?.name ?? null,
              previous_names: r.previous_names,
              network: r.network ?? e?.network ?? null,
              known_entity: r.known_entity,
              ...state(e),
              spend_minor: r.spend_minor,
              impressions: r.impressions,
              link_clicks: r.link_clicks,
              orders: r.orders,
              orders_credit: r.orders_credit,
              orders_credit_fraction: r.orders_credit_fraction,
              attributed_gross_minor: r.attributed_gross_minor,
              attributed_net_minor: r.attributed_net_minor,
              reported_purchases: rep?.n ?? null,
              reported_purchase_value_minor: rep?.v ?? null,
              metrics: mediaRowMetrics({
                spendMinor: r.spend_minor,
                impressions: r.impressions,
                linkClicks: r.link_clicks,
                ordersCredit: credit,
                grossMinor: r.attributed_gross_minor,
                netMinor: r.attributed_net_minor,
                reportedPurchases: rep?.n ?? null,
                reportedValueMinor: rep?.v ?? null,
              }),
            });
          }
          // Entidades sem gasto nem venda no período (ex.: pausadas) também aparecem para poderem ser geridas.
          for (const e of ents) {
            if (e.currency !== g.currency || seen.has(e.external_id) || !statusOk(e)) continue;
            rows.push({
              id: e.external_id,
              name: e.name,
              previous_names: [],
              network: e.network,
              known_entity: true,
              ...state(e),
              spend_minor: null,
              impressions: null,
              link_clicks: null,
              orders: 0,
              orders_credit: "0",
              orders_credit_fraction: "0/1",
              attributed_gross_minor: 0n,
              attributed_net_minor: 0n,
              reported_purchases: null,
              reported_purchase_value_minor: null,
              metrics: mediaRowMetrics({ spendMinor: null, impressions: null, linkClicks: null, ordersCredit: ratio(0n, 1n), grossMinor: 0n, netMinor: 0n, reportedPurchases: null, reportedValueMinor: null }),
            });
          }
          // Totais da tabela (linhas visíveis), com as mesmas fórmulas.
          const sumN = (k: "spend_minor" | "impressions" | "link_clicks" | "reported_purchase_value_minor") => {
            const vals = rows.map((r) => r[k]).filter((v): v is bigint => v !== null);
            return vals.length ? vals.reduce((a, b) => a + b, 0n) : null;
          };
          const credit = rows.reduce((a, r) => addRatio(a, parseRatio(r.orders_credit_fraction)), ratio(0n, 1n));
          const repN = rows.filter((r) => r.reported_purchases !== null).reduce<Ratio | null>((a, r) => (a ? addRatio(a, r.reported_purchases!) : r.reported_purchases), null);
          const gross = rows.reduce((a, r) => a + r.attributed_gross_minor, 0n);
          const net = rows.reduce((a, r) => a + r.attributed_net_minor, 0n);
          const totals = {
            spend_minor: sumN("spend_minor"),
            impressions: sumN("impressions"),
            link_clicks: sumN("link_clicks"),
            orders_credit: ratioToDecimalString(credit, 2),
            attributed_gross_minor: gross,
            attributed_net_minor: net,
            reported_purchase_value_minor: sumN("reported_purchase_value_minor"),
            metrics: mediaRowMetrics({ spendMinor: sumN("spend_minor"), impressions: sumN("impressions"), linkClicks: sumN("link_clicks"), ordersCredit: credit, grossMinor: gross, netMinor: net, reportedPurchases: repN, reportedValueMinor: sumN("reported_purchase_value_minor") }),
            period_spend_minor: g.totals?.spend_minor ?? null,
            unattributed_orders: g.totals?.unattributed_orders ?? 0,
          };
          return {
            currency: g.currency,
            rows: rows.map((r) => ({ ...r, reported_purchases: r.reported_purchases ? ratioToDecimalString(r.reported_purchases, 2) : null })),
            totals,
            notes: g.notes,
          };
        });

        const accounts = (
          await c.query(
            "select id, name, external_account_id, trim(currency) as currency, account_status, sync_enabled, last_synced_at, last_sync_error from public.ad_accounts where network = 'meta' and ($1::uuid[] is null or project_id is null or project_id = any($1)) order by sync_enabled desc, name",
            [projectIds],
          )
        ).rows;
        const writes = await mediaWritesState(c, org.id, deps.config.ALLOW_EXTERNAL_DELIVERY);
        return jsonSafe({
          scope: { level: q.level, from: q.from, to: q.to, timezone: org.timezone, policy: q.policy, campaign_id: q.campaign_id ?? null, adset_id: q.adset_id ?? null, account_id: q.account_id ?? null, status: q.status },
          groups: out.filter((g, i) => g.rows.length || i === 0),
          accounts,
          writes: { enabled: writes.enabled && org.permissions.has("media.execute"), reasons: org.permissions.has("media.execute") ? writes.reasons : ["Seu papel não tem a permissão media.execute", ...writes.reasons] },
          last_synced_at: accounts.reduce<Date | null>((a, x) => (x.last_synced_at && (!a || x.last_synced_at > a) ? x.last_synced_at : a), null),
          disclaimer: "Vendas e faturamento confirmados pelo checkout e atribuídos por ID; compras \"Meta\" são as reportadas pela própria rede (podem divergir).",
        });
      });
    });

    app.post("/media/actions", async (req, reply) => {
      assertPermission(req.auth, req.org, "media.execute", { sensitive: true });
      const b = z
        .object({
          action: z.enum(["pause", "activate", "budget", "rename", "duplicate"]),
          level,
          entity_ids: z.array(z.string().trim().min(1).max(64)).min(1).max(50),
          budget: z.object({ mode: z.enum(["absolute", "percent"]), value: z.string().trim().max(20).regex(/^-?\d+(\.\d{1,4})?$/, "número com ponto decimal") }).strict().optional(),
          name: z.string().trim().min(1).max(400).optional(),
          request_id: z.string().uuid(),
        })
        .strict()
        .parse(req.body);
      return orgSystemTx(deps, req, async (c, { auth, org }) => {
        const writes = await mediaWritesState(c, org.id, deps.config.ALLOW_EXTERNAL_DELIVERY);
        if (!writes.enabled) throw conflict("capability_unavailable", `Ações na Meta não estão liberadas: ${writes.reasons.join("; ")}`);
        const results = [];
        for (const id of [...new Set(b.entity_ids)]) {
          const r = await planMediaChange(c, org.id, writes, {
            action: b.action,
            level: b.level,
            entityId: id,
            budget: b.budget,
            name: b.name,
            actor: { type: "user", id: auth.userId },
            idempotencyKey: `user:${b.request_id}:${id}`,
            projectIds: org.projectIds,
          });
          results.push(r.ok ? { entity_id: id, ok: true, change_id: r.changeId, summary: r.summary, duplicate: r.duplicate } : { entity_id: id, ok: false, error: r.error, noop: r.noop ?? false });
        }
        await audit(c, {
          organizationId: org.id,
          actorId: auth.userId,
          action: "media.action_requested",
          details: { action: b.action, level: b.level, entity_ids: b.entity_ids, budget: b.budget ?? null, queued: results.filter((r) => r.ok).length },
          requestId: req.id,
        });
        reply.status(202);
        return { results };
      });
    });

    app.get("/media/changes", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      const q = z.object({ entity_id: z.string().trim().min(1).max(64).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
      return orgSystemTx(deps, req, async (c, { org }) =>
        jsonSafe({
          changes: (
            await c.query(
              `select m.id, m.level, m.entity_id, m.entity_name, m.action, m.before, m.requested, m.after, m.actor_type, m.status, m.error, m.attempts, m.created_at, m.completed_at,
                      u.display_name as actor_name, r.name as rule_name, a.name as account_name, trim(a.currency) as currency
                 from public.media_changes m
                 join public.ad_accounts a on a.organization_id = m.organization_id and a.id = m.ad_account_id
                 left join iam.users u on m.actor_type = 'user' and u.id = m.actor_id
                 left join public.rules r on r.organization_id = m.organization_id and r.id = m.rule_id
                where m.organization_id = $1 and ($2::text is null or m.entity_id = $2) and ($3::uuid[] is null or a.project_id is null or a.project_id = any($3))
                order by m.created_at desc limit $4`,
              [org.id, q.entity_id ?? null, org.projectIds, q.limit],
            )
          ).rows,
        }),
      );
    });
  };
