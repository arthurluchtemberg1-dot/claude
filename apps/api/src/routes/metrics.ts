import { METRIC_DEFINITIONS, localDateOf, localDateRangeToUtc, previousLocalPeriod, serializeMetric } from "@tracker/domain";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../context";
import { jsonSafe, orgTx } from "../lib/org-tx";
import { assertPermission, assertProjectAccess } from "../services/auth";
import { computeScopeMetrics } from "../services/metrics-repo";

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
        const r = await c.query(
          `select to_char(o.first_approved_at at time zone $4, 'YYYY-MM-DD') as day, o.currency,
                  count(*)::int as approved_orders, sum(o.approved_minor)::bigint as gross, sum(o.approved_minor - o.reversed_minor)::bigint as net
             from public.orders o
            where o.first_approved_at >= $1 and o.first_approved_at < $2 and ($3::uuid[] is null or o.project_id = any($3)) and (o.is_test = false or $5)
            group by 1, 2 order by 1`,
          [range.start, range.end, projectIds, org.timezone, q.include_test],
        );
        // Mesmo critério do resumo: um único nível por conta e uma única fonte por entidade/dia (T45, T46).
        const spend = await c.query(
          `with acc_level as (
             select ad_account_id, min(case level when 'account' then 1 when 'campaign' then 2 when 'adset' then 3 else 4 end) as lvl
               from public.ad_spend_daily where spend_date between $1::date and $2::date group by ad_account_id),
           chosen as (
             select distinct on (s.ad_account_id, s.level, s.entity_external_id, s.spend_date) s.*
               from public.ad_spend_daily s join acc_level l on l.ad_account_id = s.ad_account_id
                and (case s.level when 'account' then 1 when 'campaign' then 2 when 'adset' then 3 else 4 end) = l.lvl
              where s.spend_date between $1::date and $2::date
              order by s.ad_account_id, s.level, s.entity_external_id, s.spend_date, case s.source when 'api' then 1 when 'csv' then 2 else 3 end)
           select to_char(spend_date, 'YYYY-MM-DD') as day, currency, sum(spend_minor)::bigint as spend from chosen group by 1, 2 order by 1`,
          [q.from, q.to],
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
        return jsonSafe({ timezone: org.timezone, days: r.rows, spend: spend.rows, hours: hours.rows, attribution_quality: quality.rows, today: localDateOf(deps.now(), org.timezone) });
      });
    });
  };
