import type { PoolClient } from "@tracker/db";
import { CONNECTOR_CATALOG } from "@tracker/connectors";
import {
  computeMetrics,
  localDateRangeToUtc,
  ratio,
  type MetricsInput,
  type TimeBasis,
} from "@tracker/domain";

/**
 * Coleta de agregados brutos para o serviço de métricas (packages/domain/metrics). Aqui só há somas e contagens
 * com filtros explícitos; nenhuma fórmula derivada (ROAS, CPA...) é calculada em SQL (R05-11, R22-01).
 */

export interface MetricsScope {
  organizationId: string;
  projectIds: string[] | null;
  from: string; // YYYY-MM-DD (fuso da organização)
  to: string; // inclusivo
  timezone: string;
  basis: TimeBasis;
  asOf: Date;
  policyKey: string;
  includeTest: boolean;
  /** Custos materiais declarados como inexistentes pela organização (ex.: "impostos"). */
  declaredZeroCosts: string[];
}

const MATERIAL_COST_CATEGORIES: Record<string, string> = { tax_estimate: "impostos", product_cost: "custo de produto" };
const PENDING_CAPABLE = new Set(CONNECTOR_CATALOG.filter((m) => m.capabilities.pending_payments?.status === "supported").map((m) => m.id));

function parseFrac(s: string): { num: bigint; den: bigint } {
  const [n, d] = s.split("/");
  return { num: BigInt(n ?? "0"), den: BigInt(d ?? "1") };
}

/**
 * Fragmentos SQL do escopo de pedidos, compartilhados pelo resumo e pelos detalhamentos (mesmas regras de período,
 * projeto, teste e base temporal). Parâmetros: $1 org, $2/$3 intervalo UTC, $4 as_of, $5 projetos, $6 incluir teste.
 */
export function orderScopeSql(scope: Pick<MetricsScope, "organizationId" | "projectIds" | "from" | "to" | "timezone" | "basis" | "asOf" | "includeTest">) {
  const range = localDateRangeToUtc(scope.from, scope.to, scope.timezone);
  const params: unknown[] = [scope.organizationId, range.start, range.end, scope.asOf, scope.projectIds, scope.includeTest];
  // $4 (as_of) é referenciado com tipo explícito para que todas as consultas compartilhem a mesma lista de parâmetros.
  const orderFilter = `o.organization_id = $1 and ($5::uuid[] is null or o.project_id = any($5)) and (o.is_test = false or $6) and $2::timestamptz < $3::timestamptz and $4::timestamptz is not null`;
  // Base temporal: por aprovação usa first_approved_at; por movimento usa a data de cada lançamento.
  const periodOrders =
    scope.basis === "financial_movement"
      ? `select distinct o.id from public.orders o join public.financial_entries f on f.order_id = o.id where ${orderFilter} and f.occurred_at >= $2 and f.occurred_at < $3`
      : `select o.id from public.orders o where ${orderFilter} and o.first_approved_at >= $2 and o.first_approved_at < $3`;
  const entryWindow = scope.basis === "financial_movement" ? "f.occurred_at >= $2 and f.occurred_at < $3" : "f.occurred_at < $4::timestamptz";
  return { range, params, orderFilter, periodOrders, entryWindow };
}

const LEVEL_RANK = `case s.level when 'account' then 1 when 'campaign' then 2 when 'adset' then 3 else 4 end`;

/**
 * Linhas de gasto sem dupla contagem (T45, T46): uma fonte por entidade/dia (api > csv > manual) e, por conta e dia,
 * um único nível — o mais agregado disponível naquele dia entre `levels` (todos quando null).
 * Parâmetros: $1 org, $2/$3 datas locais, $4 moeda, $5 projetos.
 */
export function chosenSpendSql(levels: readonly ("account" | "campaign" | "adset" | "ad")[] | null = null) {
  const levelFilter = levels ? `and s.level in (${levels.map((l) => `'${l}'`).join(", ")})` : "";
  return `
    base as (
      select distinct on (s.ad_account_id, s.level, s.entity_external_id, s.spend_date) s.*, ${LEVEL_RANK} as lvl
        from public.ad_spend_daily s
       where s.organization_id = $1 and s.spend_date between $2::date and $3::date and s.currency = $4
         and ($5::uuid[] is null or s.project_id is null or s.project_id = any($5)) ${levelFilter}
       order by s.ad_account_id, s.level, s.entity_external_id, s.spend_date, case s.source when 'api' then 1 when 'csv' then 2 else 3 end),
    day_level as (select ad_account_id, spend_date, min(lvl) as lvl from base group by ad_account_id, spend_date),
    chosen as (select b.* from base b join day_level d on d.ad_account_id = b.ad_account_id and d.spend_date = b.spend_date and d.lvl = b.lvl)`;
}

export async function collectMetricsInputs(c: PoolClient, scope: MetricsScope): Promise<{ currency: string; input: MetricsInput; notes: string[] }[]> {
  const { range, params, orderFilter, periodOrders, entryWindow } = orderScopeSql(scope);

  const currencies = (await c.query(`select distinct o.currency from public.orders o where o.id in (${periodOrders}) and o.currency is not null`, params)).rows.map((r) => String(r.currency).trim());
  const orgCurrency = String((await c.query("select currency from public.organizations where id = $1", [scope.organizationId])).rows[0].currency).trim();
  if (!currencies.length) currencies.push(orgCurrency);

  const out: { currency: string; input: MetricsInput; notes: string[] }[] = [];
  for (const currency of currencies) {
    const p = [...params, currency];
    const cur = "$7";
    const fin = (
      await c.query(
        `with po as (${periodOrders}),
         ent as (select f.* from public.financial_entries f join po on po.id = f.order_id where f.currency = ${cur} and ${entryWindow}),
         per_order as (
           select order_id,
                  sum(amount_minor) filter (where entry_type = 'approval') as approved,
                  sum(amount_minor) filter (where entry_type in ('approval','refund','chargeback','chargeback_reversal')) as net
             from ent group by order_id)
         select
           count(*) filter (where approved > 0)::int as approved_orders,
           count(*) filter (where net > 0)::int as retained_orders,
           coalesce(sum(approved), 0)::bigint as gross,
           coalesce((select -sum(amount_minor) from ent where entry_type in ('refund','chargeback','chargeback_reversal')), 0)::bigint as reversals
         from per_order`,
        p,
      )
    ).rows[0];

    // Receita da organização por transação (R10-15): participação informada vs produtor sem participação vs desconhecida.
    const org = (
      await c.query(
        `with po as (${periodOrders}),
         ent as (select f.*, o.provider_account_id from public.financial_entries f join po on po.id = f.order_id join public.orders o on o.id = f.order_id
                  where f.currency = ${cur} and ${entryWindow}),
         tx as (
           select e.order_id, e.transaction_key, pa.revenue_role,
                  bool_or(e.entry_type = 'org_share') as has_share,
                  bool_or(e.entry_type = 'org_share_reversal' and e.estimated) as est,
                  sum(e.amount_minor) filter (where e.entry_type in ('org_share','org_share_reversal')) as share_net,
                  sum(e.amount_minor) filter (where e.entry_type in ('approval','refund','chargeback','chargeback_reversal')) as gross_net,
                  bool_or(e.entry_type = 'approval') as approved,
                  -sum(e.amount_minor) filter (where e.entry_type = 'fee') as fee
             from ent e join public.provider_accounts pa on pa.id = e.provider_account_id
            group by e.order_id, e.transaction_key, pa.revenue_role)
         select
           coalesce(sum(share_net) filter (where has_share), 0)::bigint as with_share_net,
           count(*) filter (where has_share and approved)::int as with_share_tx,
           coalesce(bool_or(est) filter (where has_share), false) as with_share_est,
           coalesce(sum(gross_net) filter (where not has_share and revenue_role = 'producer'), 0)::bigint as producer_net,
           count(*) filter (where not has_share and revenue_role = 'producer' and approved)::int as producer_tx,
           count(*) filter (where not has_share and revenue_role <> 'producer' and approved)::int as other_tx,
           coalesce(sum(fee) filter (where not has_share), 0)::bigint as provider_fees,
           count(*) filter (where not has_share and approved and fee is null)::int as tx_without_fee
         from tx`,
        p,
      )
    ).rows[0];

    // Taxas estimadas por tabela vigente para transações sem taxa informada (rotuladas como estimadas).
    const est = (
      await c.query(
        `with po as (${periodOrders}),
         tx as (
           select t.order_id, t.transaction_key, t.amount_minor, t.approved_at, o.provider_account_id
             from public.payment_transactions t join po on po.id = t.order_id join public.orders o on o.id = t.order_id
            where t.status = 'approved' and t.currency = ${cur} and t.fee_minor is null and t.org_share_minor is null)
         select coalesce(sum(round(tx.amount_minor * fs.percent_bp / 10000.0) + fs.fixed_minor), 0)::bigint as estimated, count(fs.id)::int as covered, count(*)::int as total
           from tx left join lateral (
             select * from public.fee_schedules s
              where s.organization_id = $1 and s.currency = ${cur} and (s.provider_account_id is null or s.provider_account_id = tx.provider_account_id)
                and s.valid_from <= (tx.approved_at at time zone 'UTC')::date and (s.valid_to is null or s.valid_to >= (tx.approved_at at time zone 'UTC')::date)
              order by (s.provider_account_id is null), s.valid_from desc limit 1) fs on true`,
        p,
      )
    ).rows[0];

    const pendingCapable = (
      await c.query(`select distinct o.provider from public.orders o where ${orderFilter}`, params)
    ).rows.some((r) => PENDING_CAPABLE.has(r.provider));
    const generated = (
      await c.query(
        `select count(*)::int as n, count(*) filter (where exists (select 1 from public.payment_transactions t where t.order_id = o.id))::int as with_attempt
           from public.orders o where ${orderFilter} and o.source_first_occurred_at >= $2 and o.source_first_occurred_at < $3 and (o.currency = $7 or o.currency is null)`,
        p,
      )
    ).rows[0];

    // Atribuição pela política selecionada.
    const attrRows = (
      await c.query(
        `with po as (${periodOrders}),
         per_order as (
           select f.order_id,
                  sum(f.amount_minor) filter (where f.entry_type = 'approval') as approved,
                  sum(f.amount_minor) filter (where f.entry_type in ('approval','refund','chargeback','chargeback_reversal')) as net
             from public.financial_entries f join po on po.id = f.order_id where f.currency = ${cur} and ${entryWindow} group by f.order_id)
         select po.order_id, po.approved, po.net, a.category, a.model, a.policy_version, a.credits, a.window_days,
                (select coalesce(json_agg(t.id), '[]') from public.touchpoints t
                  where t.organization_id = $1 and t.is_paid and t.id::text in (select x->>'touchpoint_id' from jsonb_array_elements(a.credits) x)) as paid_touch_ids
           from per_order po left join public.order_attributions a on a.order_id = po.order_id and a.is_current and a.policy_key = $8 and a.organization_id = $1
          where po.approved > 0`,
        [...p, scope.policyKey],
      )
    ).rows;
    let attributedGross = 0n;
    let attributedNet = 0n;
    let approvedCredit = ratio(0n, 1n);
    let retainedCredit = ratio(0n, 1n);
    let fractional = false;
    let unattributed = 0;
    let policyLabel = scope.policyKey;
    const addR = (a: { num: bigint; den: bigint }, b: { num: bigint; den: bigint }) => ratio(a.num * b.den + b.num * a.den, a.den * b.den);
    for (const r of attrRows) {
      if (r.model) policyLabel = `${r.model} · ${r.window_days} dias · v${r.policy_version}`;
      if (!r.category || r.category === "unattributed") {
        unattributed++;
        continue;
      }
      const paidIds = new Set<string>(r.paid_touch_ids ?? []);
      let w = ratio(0n, 1n);
      for (const cr of (r.credits ?? []) as { touchpoint_id: string; weight: string }[]) {
        if (paidIds.has(cr.touchpoint_id)) w = addR(w, parseFrac(cr.weight));
      }
      if (w.num === 0n) continue;
      if (w.num !== w.den) fractional = true;
      attributedGross += (BigInt(r.approved) * w.num) / w.den;
      attributedNet += (BigInt(r.net) * w.num) / w.den;
      approvedCredit = addR(approvedCredit, w);
      if (BigInt(r.net) > 0n) retainedCredit = addR(retainedCredit, w);
    }

    // Mídia: um único nível por conta e dia e uma única fonte por dia/entidade (T45, T46).
    const media = (
      await c.query(
        `with ${chosenSpendSql()}
         select coalesce(sum(spend_minor), 0)::bigint as spend, count(*)::int as rows,
                sum(impressions)::bigint as impressions, count(impressions)::int as imp_rows, sum(link_clicks)::bigint as clicks, count(link_clicks)::int as click_rows
           from chosen`,
        [scope.organizationId, scope.from, scope.to, currency, scope.projectIds],
      )
    ).rows[0];
    const accounts = (
      await c.query(
        `select a.name, a.timezone, a.synced_from, a.synced_to, a.currency from public.ad_accounts a where a.organization_id = $1 and a.network <> 'manual'`,
        [scope.organizationId],
      )
    ).rows;
    const mediaCosts = (
      await c.query(
        `select coalesce(sum(round(e.amount_minor::numeric * (least(e.period_end, $3::date) - greatest(e.period_start, $2::date) + 1) / (e.period_end - e.period_start + 1))), 0)::bigint as amount,
                count(*)::int as n, count(*) filter (where e.period_start < $2::date or e.period_end > $3::date)::int as prorated
           from public.cost_entries e
          where e.organization_id = $1 and e.counts_as_media and e.currency = $4 and e.period_start <= $3::date and e.period_end >= $2::date
            and ($5::uuid[] is null or e.project_id is null or e.project_id = any($5))`,
        [scope.organizationId, scope.from, scope.to, currency, scope.projectIds],
      )
    ).rows[0];
    const coverageNotes: string[] = [];
    let coverage: "complete" | "partial" | "none" = media.rows > 0 || mediaCosts.n > 0 ? "complete" : "none";
    for (const a of accounts) {
      if (String(a.currency).trim() !== currency) continue;
      const covered = a.synced_from && a.synced_to && a.synced_from <= scope.from && a.synced_to >= scope.to;
      if (!covered) {
        coverage = media.rows > 0 ? "partial" : coverage;
        coverageNotes.push(`Conta "${a.name}" sem dados para todo o período (${a.synced_from ? "coberto até " + a.synced_to : "nunca sincronizada"})`);
      }
      if (a.timezone && a.timezone !== scope.timezone) coverageNotes.push(`Conta "${a.name}" usa fuso ${a.timezone}; dias da conta diferem do fuso da organização (${scope.timezone})`);
    }
    if (mediaCosts.prorated > 0) coverageNotes.push(`${mediaCosts.prorated} custo(s) manual(is) rateado(s) proporcionalmente aos dias do período`);

    // Custos variáveis e despesas (rateio proporcional por dias).
    const costs = (
      await c.query(
        `select e.category, coalesce(sum(round(e.amount_minor::numeric * (least(e.period_end, $3::date) - greatest(e.period_start, $2::date) + 1) / (e.period_end - e.period_start + 1))), 0)::bigint as amount
           from public.cost_entries e
          where e.organization_id = $1 and not e.counts_as_media and e.currency = $4 and e.period_start <= $3::date and e.period_end >= $2::date
            and ($5::uuid[] is null or e.project_id is null or e.project_id = any($5))
          group by e.category`,
        [scope.organizationId, scope.from, scope.to, currency, scope.projectIds],
      )
    ).rows;
    const byCat = new Map(costs.map((r) => [r.category as string, BigInt(r.amount)]));
    const configuredCats = new Set((await c.query("select distinct category from public.cost_entries where organization_id = $1", [scope.organizationId])).rows.map((r) => r.category));
    const missing = Object.entries(MATERIAL_COST_CATEGORIES)
      .filter(([cat, label]) => !configuredCats.has(cat) && !scope.declaredZeroCosts.includes(label))
      .map(([, label]) => label);
    const otherVariable = [...byCat.entries()].filter(([k]) => k !== "operating_expense" && k !== "tool").reduce((a, [, v]) => a + v, 0n);
    const opex = byCat.has("operating_expense") || byCat.has("tool") ? (byCat.get("operating_expense") ?? 0n) + (byCat.get("tool") ?? 0n) : null;

    const leads = (
      await c.query(
        `select count(distinct e.visitor_id) filter (where e.event_name = 'Lead')::int as leads,
                (select count(*)::int from public.sessions s where s.organization_id = $1 and s.started_at >= $2 and s.started_at < $3 and ($4::uuid[] is null or s.project_id = any($4))) as sessions,
                (select count(*)::int from public.tracking_events t where t.organization_id = $1 and ($4::uuid[] is null or t.project_id = any($4))) as any_events
           from public.tracking_events e where e.organization_id = $1 and e.occurred_at >= $2 and e.occurred_at < $3 and ($4::uuid[] is null or e.project_id = any($4))`,
        [scope.organizationId, range.start, range.end, scope.projectIds],
      )
    ).rows[0];

    const notes: string[] = [];
    if (scope.basis === "acquisition_cohort") notes.push("Base por coorte de aquisição usa as aprovações iniciais do período e toda receita posterior até as_of");

    out.push({
      currency,
      notes,
      input: {
        financial: {
          currency,
          basis: scope.basis,
          asOf: scope.asOf,
          ordersGenerated: pendingCapable ? generated.n : null,
          approvedOrders: fin.approved_orders,
          retainedOrders: fin.retained_orders,
          grossApprovedMinor: BigInt(fin.gross),
          reversalsMinor: BigInt(fin.reversals),
          orgRevenue: {
            withShareNetMinor: BigInt(org.with_share_net),
            withShareTransactions: org.with_share_tx,
            withShareHasEstimatedReversal: org.with_share_est,
            producerNoShareNetMinor: BigInt(org.producer_net),
            producerNoShareTransactions: org.producer_tx,
            otherRoleNoShareTransactions: org.other_tx,
          },
          fees: {
            providerReportedMinor: BigInt(org.provider_fees),
            estimatedMinor: est.covered > 0 ? BigInt(est.estimated) : null,
            transactionsWithoutFee: Math.max(0, org.tx_without_fee - est.covered),
          },
          ordersWithPaymentAttempt: pendingCapable ? generated.with_attempt : null,
        },
        attribution: {
          policyLabel,
          attributedGrossMinor: attributedGross,
          attributedAfterReversalsMinor: attributedNet,
          approvedCredit,
          retainedCredit,
          fractional,
          unattributedOrders: unattributed,
        },
        media: {
          spendMinor: media.rows > 0 || mediaCosts.n > 0 ? BigInt(media.spend) + BigInt(mediaCosts.amount) : null,
          spendCurrency: currency,
          coverage,
          coverageNotes,
          impressions: media.imp_rows > 0 ? BigInt(media.impressions) : null,
          linkClicks: media.click_rows > 0 ? BigInt(media.clicks) : null,
        },
        costs: { otherVariableCostsMinor: otherVariable, missingCostCategories: missing, operatingExpensesMinor: opex, allocationCriteria: opex !== null ? "rateio proporcional por dias do período" : null },
        leads: { dedupedLeads: leads.any_events > 0 ? leads.leads : null, eligibleSessions: leads.any_events > 0 ? leads.sessions : null },
      },
    });
  }
  return out;
}

export async function computeScopeMetrics(c: PoolClient, scope: MetricsScope) {
  const groups = await collectMetricsInputs(c, scope);
  return groups.map((g) => ({ currency: g.currency, notes: g.notes, metrics: computeMetrics(g.input), input: g.input }));
}
