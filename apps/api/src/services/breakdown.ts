import type { PoolClient } from "@tracker/db";
import { addRatio, mulRatioBy, parseRatio, ratio, ratioToDecimalString, roundRatioHalfEven, type Ratio } from "@tracker/domain";
import { chosenSpendSql, orderScopeSql, type MetricsScope } from "./metrics-repo";

/**
 * Detalhamento de desempenho por campanha/conjunto/anúncio/rede (R23-08, R23-09, T39, T46).
 * Junção SEMPRE por ID externo (nunca por nome): renomear campanha preserva gasto e vendas (T39).
 * Gasto e vendas são agregados separadamente e só então combinados por ID, sem multiplicar linhas por joins (T46).
 * Vendas usam os créditos da política de atribuição selecionada (frações exatas, arredondadas só na saída).
 */

export type BreakdownDimension = "campaign" | "adset" | "ad" | "network";

export interface BreakdownScope extends Pick<MetricsScope, "organizationId" | "projectIds" | "from" | "to" | "timezone" | "basis" | "asOf" | "includeTest" | "policyKey"> {
  dimension: BreakdownDimension;
  campaignId: string | null;
}

interface Bucket {
  key: string | null;
  network: string | null;
  spend: bigint | null;
  impressions: bigint | null;
  linkClicks: bigint | null;
  credit: Ratio;
  gross: Ratio;
  net: Ratio;
  orders: Set<string>;
}

const SPEND_LEVELS: Record<BreakdownDimension, ("account" | "campaign" | "adset" | "ad")[] | null> = {
  campaign: ["campaign", "adset", "ad"],
  adset: ["adset"],
  ad: ["ad"],
  network: null,
};
const TOUCH_KEY: Record<BreakdownDimension, string> = { campaign: "t.campaign_id", adset: "t.adset_id", ad: "t.ad_id", network: "t.network" };

type Metric = { status: "ok"; value: string; fraction: { num: string; den: string } } | { status: "undefined" | "unavailable"; reason: string };

function ratioMetric(num: Ratio, denMinor: bigint | null, missingReason: string, zeroReason: string): Metric {
  if (denMinor === null) return { status: "unavailable", reason: missingReason };
  if (denMinor === 0n) return { status: "undefined", reason: zeroReason };
  const r = ratio(num.num, num.den * denMinor);
  return { status: "ok", value: ratioToDecimalString(r, 4), fraction: { num: r.num.toString(), den: r.den.toString() } };
}

export async function computeBreakdown(c: PoolClient, scope: BreakdownScope) {
  const { params, periodOrders, entryWindow } = orderScopeSql(scope);
  const dim = scope.dimension;
  const currencies = new Set<string>(
    (await c.query(`select distinct o.currency from public.orders o where o.id in (${periodOrders}) and o.currency is not null`, params)).rows.map((r) => String(r.currency).trim()),
  );
  for (const r of (
    await c.query(
      "select distinct currency from public.ad_spend_daily s where s.organization_id = $1 and s.spend_date between $2::date and $3::date and ($4::uuid[] is null or s.project_id is null or s.project_id = any($4))",
      [scope.organizationId, scope.from, scope.to, scope.projectIds],
    )
  ).rows)
    currencies.add(String(r.currency).trim());
  if (!currencies.size) currencies.add(String((await c.query("select currency from public.organizations where id = $1", [scope.organizationId])).rows[0].currency).trim());

  const groups = [];
  for (const currency of [...currencies].sort()) {
    const buckets = new Map<string, Bucket>();
    // Chave = ID externo da dimensão (a rede vem da conta de anúncios quando houver gasto, senão do toque).
    const bucket = (key: string | null, network: string | null, authoritativeNetwork = false): Bucket => {
      const k = key ?? "";
      let b = buckets.get(k);
      if (!b) {
        b = { key, network, spend: null, impressions: null, linkClicks: null, credit: ratio(0n, 1n), gross: ratio(0n, 1n), net: ratio(0n, 1n), orders: new Set() };
        buckets.set(k, b);
      } else if (network && (authoritativeNetwork || !b.network)) b.network = network;
      return b;
    };

    // Vendas: créditos da política por toque (touchpoint → ID da dimensão).
    const credits = (
      await c.query(
        `with po as (${periodOrders}),
         per_order as (
           select f.order_id,
                  sum(f.amount_minor) filter (where f.entry_type = 'approval') as approved,
                  sum(f.amount_minor) filter (where f.entry_type in ('approval','refund','chargeback','chargeback_reversal')) as net
             from public.financial_entries f join po on po.id = f.order_id where f.currency = $7 and ${entryWindow} group by f.order_id)
         select po.order_id, po.approved, po.net, a.category, x->>'weight' as weight, t.network, ${TOUCH_KEY[dim]} as key, t.campaign_id
           from per_order po
           left join public.order_attributions a on a.organization_id = $1 and a.order_id = po.order_id and a.is_current and a.policy_key = $8
           left join lateral jsonb_array_elements(case when a.category is null or a.category = 'unattributed' then '[]'::jsonb else a.credits end) x on true
           left join public.touchpoints t on t.organization_id = $1 and t.id = (x->>'touchpoint_id')::uuid
          where po.approved > 0`,
        [...params, currency, scope.policyKey],
      )
    ).rows;
    let unattributedOrders = 0;
    let unattributedGross = 0n;
    let pendingOrders = 0;
    const allOrders = new Set<string>();
    let totalGross = 0n;
    let totalNet = 0n;
    for (const r of credits) {
      if (!allOrders.has(r.order_id)) {
        allOrders.add(r.order_id);
        totalGross += BigInt(r.approved);
        totalNet += BigInt(r.net);
        if (!r.category) pendingOrders++;
        else if (r.category === "unattributed") {
          unattributedOrders++;
          unattributedGross += BigInt(r.approved);
        }
      }
      if (!r.weight) continue;
      if (scope.campaignId && r.campaign_id !== scope.campaignId) continue;
      const w = parseRatio(r.weight);
      const b = bucket(r.key ?? null, r.network ?? null);
      b.credit = addRatio(b.credit, w);
      b.gross = addRatio(b.gross, mulRatioBy(w, BigInt(r.approved)));
      b.net = addRatio(b.net, mulRatioBy(w, BigInt(r.net)));
      b.orders.add(r.order_id);
    }

    // Gasto: agregado antes de combinar (sem join com vendas).
    const spendKey =
      dim === "campaign" ? "case when c.level = 'campaign' then c.entity_external_id else c.campaign_external_id end" : dim === "network" ? "null" : "c.entity_external_id";
    const spendParams = [scope.organizationId, scope.from, scope.to, currency, scope.projectIds, scope.campaignId];
    const campaignFilter = dim === "adset" || dim === "ad" ? "and ($6::text is null or c.campaign_external_id = $6)" : dim === "campaign" ? "and ($6::text is null or (case when c.level = 'campaign' then c.entity_external_id else c.campaign_external_id end) = $6)" : "and $6::text is null";
    const spendRows = (
      await c.query(
        `with ${chosenSpendSql(SPEND_LEVELS[dim])}
         select a.network, ${spendKey} as key, sum(c.spend_minor)::bigint as spend, sum(c.impressions)::bigint as impressions, count(c.impressions)::int as imp_rows,
                sum(c.link_clicks)::bigint as clicks, count(c.link_clicks)::int as click_rows, count(*)::int as n
           from chosen c join public.ad_accounts a on a.id = c.ad_account_id
          where true ${campaignFilter}
          group by 1, 2`,
        spendParams,
      )
    ).rows;
    let allocated = 0n;
    for (const r of spendRows) {
      const b = bucket(dim === "network" ? r.network : (r.key ?? null), r.network, true);
      b.spend = (b.spend ?? 0n) + BigInt(r.spend);
      b.impressions = r.imp_rows === r.n ? (b.impressions ?? 0n) + BigInt(r.impressions ?? 0) : b.impressions;
      b.linkClicks = r.click_rows === r.n ? (b.linkClicks ?? 0n) + BigInt(r.clicks ?? 0) : b.linkClicks;
      allocated += BigInt(r.spend);
    }
    // Total de mídia pela mesma regra do resumo (um nível por conta/dia), para evidenciar gasto não detalhável.
    const total = (
      await c.query(`with ${chosenSpendSql()} select coalesce(sum(spend_minor), 0)::bigint as spend, count(*)::int as n from chosen c where $6::text is null`, spendParams)
    ).rows[0];

    const keys = [...buckets.values()].map((b) => b.key).filter((k): k is string => !!k);
    const level = dim === "network" ? null : dim;
    const names = level && keys.length
      ? (
          await c.query(
            `select n.external_id, array_agg(n.name order by n.last_seen_date desc nulls last, n.seen_at desc) as names
               from public.ad_entity_names n where n.organization_id = $1 and n.level = $2 and n.external_id = any($3) group by n.external_id`,
            [scope.organizationId, level, keys],
          )
        ).rows
      : [];
    const entities = level && keys.length
      ? (await c.query("select external_id, name, source from public.ad_entities where organization_id = $1 and level = $2 and external_id = any($3)", [scope.organizationId, level, keys])).rows
      : [];
    const nameMap = new Map<string, string[]>(names.map((r) => [r.external_id, r.names]));
    const entityMap = new Map<string, { name: string | null; source: string }>(entities.map((r) => [r.external_id, { name: r.name, source: r.source }]));

    const notes: string[] = [];
    const unallocated = BigInt(total.spend) - allocated;
    if (!scope.campaignId && unallocated !== 0n) {
      notes.push(
        unallocated > 0n
          ? `Gasto sem detalhamento neste nível (ex.: importado só por conta): ${unallocated} na menor unidade, não distribuído entre as linhas`
          : `Soma do detalhamento difere do total por conta em dias com os dois níveis importados (${-unallocated} na menor unidade); o total usa o nível mais agregado`,
      );
    }
    if (pendingOrders) notes.push(`${pendingOrders} pedido(s) aprovado(s) ainda sem atribuição calculada`);
    notes.push("Custos de mídia lançados manualmente (influenciadores, ações offline) não entram no detalhamento por campanha");

    const rows = [...buckets.values()]
      .map((b) => {
        const hist = b.key ? (nameMap.get(b.key) ?? []) : [];
        const ent = b.key ? entityMap.get(b.key) : undefined;
        const gross = roundRatioHalfEven(b.gross);
        const credit = b.credit;
        return {
          id: b.key,
          network: b.network,
          name: hist[0] ?? ent?.name ?? null,
          previous_names: hist.slice(1),
          known_entity: dim === "network" ? null : !!ent,
          entity_source: ent?.source ?? null,
          spend_minor: b.spend,
          impressions: b.impressions,
          link_clicks: b.linkClicks,
          orders: b.orders.size,
          orders_credit: ratioToDecimalString(credit, 4),
          orders_credit_fraction: `${credit.num}/${credit.den}`,
          attributed_gross_minor: gross,
          attributed_net_minor: roundRatioHalfEven(b.net),
          roas_gross: ratioMetric(b.gross, b.spend, "Sem gasto importado/sincronizado para este ID", "Gasto zero no período"),
          cpa_minor:
            b.spend === null
              ? { status: "unavailable", reason: "Sem gasto importado/sincronizado para este ID" }
              : credit.num === 0n
                ? { status: "undefined", reason: "Nenhuma venda atribuída" }
                : { status: "ok", value: roundRatioHalfEven(ratio(b.spend * credit.den, credit.num)).toString() },
        };
      })
      .sort((a, b) => Number((b.spend_minor ?? -1n) - (a.spend_minor ?? -1n)) || Number(b.attributed_gross_minor - a.attributed_gross_minor));

    groups.push({
      currency,
      rows: rows.slice(0, 500),
      truncated: rows.length > 500,
      totals: {
        spend_minor: BigInt(total.spend),
        allocated_spend_minor: allocated,
        approved_orders: allOrders.size,
        gross_minor: totalGross,
        net_minor: totalNet,
        unattributed_orders: unattributedOrders,
        unattributed_gross_minor: unattributedGross,
      },
      notes,
    });
  }
  return groups;
}
