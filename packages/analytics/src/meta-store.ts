import { reportedPurchases, type MetaAdAccount, type MetaEntity, type MetaInsight } from "@tracker/connectors";
import type { PoolClient } from "@tracker/db";
import { parseDecimalToMinor } from "@tracker/domain";

/**
 * Persistência dos dados lidos da Meta (compartilhada por API e worker).
 * - Valores da conta (gasto acumulado, limite, saldo, orçamento mínimo) e orçamentos vêm em unidades mínimas da
 *   moeda como inteiros em string; outro formato vira "desconhecido" (nunca zero).
 * - Gasto diário (insights `spend`) vem em decimal na moeda da conta.
 * - Insights substituem o snapshot do período e nível (T45): correções tardias da Meta não somam em duplicidade.
 * - Compras e valor de compras REPORTADOS pela Meta ficam em colunas próprias, separadas das vendas do checkout.
 */

export const minorOrNull = (v: string | number | undefined | null): string | null => (v === undefined || v === null || !/^\d+$/.test(String(v)) ? null : String(v));

export function metaAccountId(a: Pick<MetaAdAccount, "id">): string {
  return a.id.startsWith("act_") ? a.id : `act_${a.id}`;
}

export async function upsertMetaAccount(c: PoolClient, orgId: string, projectId: string, connectionId: string, a: MetaAdAccount, enableNew: boolean): Promise<string> {
  const r = await c.query(
    `insert into public.ad_accounts (organization_id, project_id, connection_id, network, external_account_id, name, currency, timezone, status, account_status,
        amount_spent_minor, spend_cap_minor, balance_minor, is_prepay, min_daily_budget_minor, business_name, sync_enabled)
     values ($1, $2, $3, 'meta', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     on conflict (organization_id, network, external_account_id) do update set
       connection_id = excluded.connection_id, name = excluded.name, currency = excluded.currency, timezone = coalesce(excluded.timezone, public.ad_accounts.timezone),
       status = excluded.status, account_status = excluded.account_status, amount_spent_minor = excluded.amount_spent_minor, spend_cap_minor = excluded.spend_cap_minor,
       balance_minor = excluded.balance_minor, is_prepay = excluded.is_prepay, min_daily_budget_minor = excluded.min_daily_budget_minor, business_name = excluded.business_name
     returning id`,
    [
      orgId,
      projectId,
      connectionId,
      metaAccountId(a),
      (a.name ?? a.id).slice(0, 200),
      (a.currency ?? "BRL").toUpperCase(),
      a.timezone_name ?? null,
      a.account_status === 1 ? "active" : a.account_status === undefined ? null : `status_${a.account_status}`,
      a.account_status ?? null,
      minorOrNull(a.amount_spent),
      // spend_cap "0" = sem limite definido.
      minorOrNull(a.spend_cap) === "0" ? null : minorOrNull(a.spend_cap),
      minorOrNull(a.balance),
      a.is_prepay_account ?? null,
      minorOrNull(a.min_daily_budget),
      a.business?.name ?? null,
      enableNew ? a.account_status === 1 || a.account_status === undefined : false,
    ],
  );
  return r.rows[0].id as string;
}

export async function upsertMetaEntities(c: PoolClient, orgId: string, accountId: string, level: "campaign" | "adset" | "ad", rows: MetaEntity[], today: string, now: Date): Promise<number> {
  for (const e of rows) {
    const parent = level === "adset" ? (e.campaign_id ?? null) : level === "ad" ? (e.adset_id ?? null) : null;
    await c.query(
      `insert into public.ad_entities (organization_id, ad_account_id, level, external_id, parent_external_id, name, status, effective_status, objective, source,
          daily_budget_minor, lifetime_budget_minor, budget_remaining_minor, learning_status, campaign_external_id, adset_external_id, created_time, synced_at, last_seen_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'api', $10, $11, $12, $13, $14, $15, $16, $17, $17)
       on conflict (organization_id, ad_account_id, level, external_id) do update set
         parent_external_id = coalesce(excluded.parent_external_id, public.ad_entities.parent_external_id), name = coalesce(excluded.name, public.ad_entities.name),
         status = excluded.status, effective_status = excluded.effective_status, objective = coalesce(excluded.objective, public.ad_entities.objective), source = 'api',
         daily_budget_minor = excluded.daily_budget_minor, lifetime_budget_minor = excluded.lifetime_budget_minor, budget_remaining_minor = excluded.budget_remaining_minor,
         learning_status = excluded.learning_status, campaign_external_id = coalesce(excluded.campaign_external_id, public.ad_entities.campaign_external_id),
         adset_external_id = coalesce(excluded.adset_external_id, public.ad_entities.adset_external_id), created_time = coalesce(excluded.created_time, public.ad_entities.created_time),
         synced_at = excluded.synced_at, last_seen_at = excluded.last_seen_at`,
      [
        orgId,
        accountId,
        level,
        e.id,
        parent,
        e.name ?? null,
        e.status ?? e.configured_status ?? null,
        e.effective_status ?? null,
        e.objective ?? null,
        minorOrNull(e.daily_budget) === "0" ? null : minorOrNull(e.daily_budget),
        minorOrNull(e.lifetime_budget) === "0" ? null : minorOrNull(e.lifetime_budget),
        minorOrNull(e.budget_remaining),
        e.learning_stage_info?.status ?? null,
        level === "campaign" ? e.id : (e.campaign_id ?? null),
        level === "adset" ? e.id : level === "ad" ? (e.adset_id ?? null) : null,
        e.created_time ? new Date(e.created_time) : null,
        now,
      ],
    );
    if (e.name) await recordName(c, orgId, accountId, level, e.id, e.name, today);
  }
  return rows.length;
}

async function recordName(c: PoolClient, orgId: string, accountId: string, level: string, id: string, name: string, date: string) {
  await c.query(
    `insert into public.ad_entity_names (organization_id, ad_account_id, level, external_id, name, first_seen_date, last_seen_date) values ($1, $2, $3, $4, $5, $6, $6)
     on conflict (organization_id, ad_account_id, level, external_id, name) do update set
       first_seen_date = least(coalesce(public.ad_entity_names.first_seen_date, excluded.first_seen_date), excluded.first_seen_date),
       last_seen_date = greatest(coalesce(public.ad_entity_names.last_seen_date, excluded.last_seen_date), excluded.last_seen_date)`,
    [orgId, accountId, level, id, name.slice(0, 300), date],
  );
}

const INT = /^\d+$/;
const intOrNull = (v: string | undefined) => (v !== undefined && INT.test(v) ? v : null);

/** Substitui o snapshot de insights (fonte api) da conta, nível e período; devolve linhas gravadas e erros de linha. */
export async function replaceMetaInsights(
  c: PoolClient,
  input: { orgId: string; accountId: string; projectId: string | null; level: "campaign" | "adset" | "ad"; since: string; until: string; currency: string; rows: MetaInsight[] },
): Promise<{ written: number; errors: string[] }> {
  const errors: string[] = [];
  await c.query("delete from public.ad_spend_daily where organization_id = $1 and ad_account_id = $2 and level = $3 and source = 'api' and spend_date between $4::date and $5::date", [
    input.orgId, input.accountId, input.level, input.since, input.until,
  ]);
  let written = 0;
  for (const r of input.rows) {
    const id = input.level === "campaign" ? r.campaign_id : input.level === "adset" ? r.adset_id : r.ad_id;
    const date = r.date_start;
    if (!id || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      errors.push(`Linha sem ID ou data (${input.level})`);
      continue;
    }
    const currency = (r.account_currency ?? input.currency).toUpperCase();
    let spend: bigint;
    try {
      spend = parseDecimalToMinor(r.spend ?? "0", currency);
    } catch {
      errors.push(`Gasto inválido em ${id} ${date}`);
      continue;
    }
    const rep = reportedPurchases(r);
    let repValue: string | null;
    try {
      repValue = rep.value === null ? null : parseDecimalToMinor(rep.value, currency).toString();
    } catch {
      repValue = null;
    }
    await c.query(
      `insert into public.ad_spend_daily (organization_id, project_id, ad_account_id, level, entity_external_id, campaign_external_id, adset_external_id, spend_date, currency,
          spend_minor, impressions, link_clicks, reach, reported_purchases, reported_purchase_value_minor, source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'api')
       on conflict (organization_id, ad_account_id, level, entity_external_id, spend_date, source) do update set
         spend_minor = excluded.spend_minor, impressions = excluded.impressions, link_clicks = excluded.link_clicks, reach = excluded.reach,
         reported_purchases = excluded.reported_purchases, reported_purchase_value_minor = excluded.reported_purchase_value_minor, snapshot_at = now()`,
      [
        input.orgId, input.projectId, input.accountId, input.level, id, r.campaign_id ?? null, input.level === "ad" ? (r.adset_id ?? null) : input.level === "adset" ? id : null, date, currency,
        spend.toString(), intOrNull(r.impressions), intOrNull(r.inline_link_clicks), intOrNull(r.reach), rep.count !== null && /^\d+(\.\d+)?$/.test(rep.count) ? rep.count : null, repValue,
      ],
    );
    const name = input.level === "campaign" ? r.campaign_name : input.level === "adset" ? r.adset_name : r.ad_name;
    if (name) await recordName(c, input.orgId, input.accountId, input.level, id, name, date);
    written++;
  }
  return { written, errors };
}
