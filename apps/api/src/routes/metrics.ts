import { METRIC_DEFINITIONS, localDateOf, localDateRangeToUtc, previousLocalPeriod, serializeMetric } from "@tracker/domain";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../context";
import { jsonSafe, orgTx } from "../lib/org-tx";
import { assertPermission, assertProjectAccess } from "../services/auth";
import { chosenSpendSql, computeScopeMetrics } from "../services/metrics-repo";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const metricsRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.get("/metrics/definitions", async () => ({ definitions: Object.values(METRIC_DEFINITIONS) }));

    app.get("/metrics/summary", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      const q = z
        .object({
          from: date,
          to: date,
          project_id: z.string().uuid().optional(),
          basis: z.enum(["approval", "financial_movement", "acquisition_cohort"]).default("approval"),
          policy: z.string().max(60).default("default"),
          compare: z.coerce.boolean().default(false),
          include_test: z.coerce.boolean().default(false),
          as_of: z.iso.datetime({ offset: true }).optional(),
        })
        .parse(req.query);
      if (q.project_id) assertProjectAccess(req.org!, q.project_id);
      return orgTx(deps, req, async (c, { org }) => {
        const projectIds = q.project_id ? [q.project_id] : org.projectIds;
        const settings = (await c.query("select settings from public.organizations where id = $1", [org.id])).rows[0]?.settings ?? {};
        const scope = {
          organizationId: org.id,
          projectIds,
          from: q.from,
          to: q.to,
          timezone: org.timezone,
          basis: q.basis,
          asOf: q.as_of ? new Date(q.as_of) : deps.now(),
          policyKey: q.policy,
          includeTest: q.include_test,
          declaredZeroCosts: Array.isArray(settings?.cost_policy?.declared_zero) ? settings.cost_policy.declared_zero : [],
        };
        localDateRangeToUtc(q.from, q.to, org.timezone); // valida o intervalo
        const current = await computeScopeMetrics(c, scope);
        const previous = q.compare ? await computeScopeMetrics(c, { ...scope, ...previousLocalPeriod(q.from, q.to) }) : null;
        const freshness = (
          await c.query(
            `select (select max(received_at) from public.webhook_receipts) as last_receipt_at,
                    (select max(processed_at) from public.orders) as last_order_processed_at,
                    (select max(snapshot_at) from public.ad_spend_daily) as last_spend_snapshot_at,
                    (select count(*) from public.webhook_receipts where status in ('pending','failed')) as pending_receipts,
                    (select count(*) from public.webhook_receipts where status in ('quarantined','dead')) as problem_receipts,
                    (select count(*) from public.provider_connections where status in ('token_expired','revoked','temporary_failure','sync_delayed') and disabled_at is null) as degraded_connections`,
          )
        ).rows[0];
        return jsonSafe({
          scope: { from: q.from, to: q.to, timezone: org.timezone, basis: q.basis, policy: q.policy, as_of: scope.asOf, project_id: q.project_id ?? null, include_test: q.include_test },
          groups: current.map((g, i) => ({
            currency: g.currency,
            notes: g.notes,
            policy_label: g.input.attribution?.policyLabel ?? null,
            metrics: Object.values(g.metrics).map(serializeMetric),
            previous: previous?.[i] && previous[i]!.currency === g.currency ? Object.values(previous[i]!.metrics).map(serializeMetric) : null,
          })),
          freshness,
          disclaimer: "Métricas internas (base: pedidos confirmados pelo checkout). Conversões reportadas pelas redes são exibidas separadamente e não são somadas.",
        });
      });
    });

    // Série diária por data local de aprovação (sem empilhar receitas sobrepostas).
    app.get("/metrics/timeseries", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      const q = z.object({ from: date, to: date, project_id: z.string().uuid().optional(), include_test: z.coerce.boolean().default(false) }).parse(req.query);
      if (q.project_id) assertProjectAccess(req.org!, q.project_id);
      return orgTx(deps, req, async (c, { org }) => {
        const range = localDateRangeToUtc(q.from, q.to, org.timezone);
        const projectIds = q.project_id ? [q.project_id] : org.projectIds;
        // Receita por data de cada aprovação (renovações no dia da renovação) e reversões dessas transações até agora;
        // pedidos contados pela primeira aprovação (mesmas regras da base por aprovação do resumo).
        const money = await c.query(
          `with appr as (
             select f.order_id, f.transaction_key, f.occurred_at, trim(f.currency) as currency, f.amount_minor
               from public.financial_entries f join public.orders o on o.id = f.order_id
              where f.entry_type = 'approval' and f.occurred_at >= $1 and f.occurred_at < $2 and ($3::uuid[] is null or o.project_id = any($3)) and (o.is_test = false or $5)),
           rev as (
             select f.order_id, f.transaction_key, sum(f.amount_minor) as s from public.financial_entries f
              where f.entry_type in ('refund','chargeback','chargeback_reversal') and (f.order_id, f.transaction_key) in (select order_id, transaction_key from appr)
              group by 1, 2)
           select to_char(a.occurred_at at time zone $4, 'YYYY-MM-DD') as day, a.currency, sum(a.amount_minor)::bigint as gross, sum(a.amount_minor + coalesce(r.s, 0))::bigint as net
             from appr a left join rev r on r.order_id = a.order_id and r.transaction_key = a.transaction_key
            group by 1, 2 order by 1`,
          [range.start, range.end, projectIds, org.timezone, q.include_test],
        );
        const counts = await c.query(
          `select to_char(o.first_approved_at at time zone $4, 'YYYY-MM-DD') as day, trim(o.currency) as currency, count(*)::int as approved_orders
             from public.orders o
            where o.first_approved_at >= $1 and o.first_approved_at < $2 and ($3::uuid[] is null or o.project_id = any($3)) and (o.is_test = false or $5)
            group by 1, 2`,
          [range.start, range.end, projectIds, org.timezone, q.include_test],
        );
        const byKey = new Map<string, { day: string; currency: string; approved_orders: number; gross: bigint; net: bigint }>();
        for (const m of money.rows) byKey.set(`${m.day}|${m.currency}`, { day: m.day, currency: m.currency, approved_orders: 0, gross: BigInt(m.gross), net: BigInt(m.net) });
        for (const k of counts.rows) {
          const e = byKey.get(`${k.day}|${k.currency}`) ?? { day: k.day, currency: k.currency, approved_orders: 0, gross: 0n, net: 0n };
          e.approved_orders = k.approved_orders;
          byKey.set(`${k.day}|${k.currency}`, e);
        }
        const days = [...byKey.values()].sort((x, y) => x.day.localeCompare(y.day));
        // Mesmo critério do resumo: um único nível por conta e dia e uma única fonte por entidade/dia (T45, T46).
        const spend = await c.query(
          `with ${chosenSpendSql()} select to_char(spend_date, 'YYYY-MM-DD') as day, trim(currency) as currency, sum(spend_minor)::bigint as spend from chosen group by 1, 2 order by 1`,
          [org.id, q.from, q.to, null, projectIds],
        );
        const hours = await c.query(
          `select extract(hour from o.first_approved_at at time zone $4)::int as hour, count(*)::int as orders
             from public.orders o where o.first_approved_at >= $1 and o.first_approved_at < $2 and ($3::uuid[] is null or o.project_id = any($3)) and (o.is_test = false or $5)
            group by 1 order by 1`,
          [range.start, range.end, projectIds, org.timezone, q.include_test],
        );
        const quality = await c.query(
          `select coalesce(a.category, 'unattributed') as category, coalesce(a.quality, 'none') as quality, count(*)::int as orders
             from public.orders o left join public.order_attributions a on a.order_id = o.id and a.is_current and a.policy_key = 'default'
            where o.first_approved_at >= $1 and o.first_approved_at < $2 and ($3::uuid[] is null or o.project_id = any($3)) and (o.is_test = false or $4)
            group by 1, 2`,
          [range.start, range.end, projectIds, q.include_test],
        );
        return jsonSafe({ timezone: org.timezone, days, spend: spend.rows, hours: hours.rows, attribution_quality: quality.rows, today: localDateOf(deps.now(), org.timezone) });
      });
    });
  };
