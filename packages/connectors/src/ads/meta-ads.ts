import { parseDecimalToMinor } from "@tracker/domain";
import type { ConnectorManifest, SpendRow } from "../types";

/**
 * Meta Marketing API — leitura de insights (gasto, impressões, cliques no link, alcance) por nível.
 *
 * Campos verificados no SDK oficial facebook-nodejs-business-sdk@24.0.1 (src/objects/ads-insights.js):
 *   account_currency, account_id, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name,
 *   spend, impressions, reach, clicks, inline_link_clicks, cpc, cpm, ctr, frequency, actions, action_values,
 *   date_start, date_stop, objective; níveis: account | campaign | adset | ad.
 * A revalidar na documentação oficial: paginação (paging.cursors/next), time_increment=1, relatórios assíncronos,
 * limites de taxa e cabeçalhos de uso.
 *
 * Regras de consolidação: um único nível por consulta (T46); reimportação substitui o snapshot do dia (T45);
 * alcance e frequência NÃO são somados entre dias (R21-10) — persistimos alcance diário apenas como dado bruto.
 */

export const metaAdsManifest: ConnectorManifest = {
  id: "meta_ads",
  displayName: "Meta Ads",
  vendor: "Meta Platforms",
  product: "Marketing API — Insights e entidades",
  kind: "ad_network",
  group: "Redes de mídia",
  state: "blocked_external",
  stateNote:
    "Parser de insights e persistência por snapshot implementados/testados com resposta no formato dos campos do SDK oficial. Leitura real bloqueada: exige app Meta, OAuth e permissões (DEP-META-APP).",
  docs: [
    { title: "facebook-nodejs-business-sdk 24.0.1 — AdsInsights", url: "https://www.npmjs.com/package/facebook-nodejs-business-sdk/v/24.0.1", consultedAt: "2026-09-24", version: "v24.0", accessible: true },
    { title: "Marketing API authorization", url: "https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started/authorization", consultedAt: "2026-09-24", version: null, accessible: false, note: "Bloqueado pelo proxy" },
  ],
  apiVersion: "v24.0",
  authentication: "OAuth 2.0 (Facebook Login for Business) — escopos a confirmar: ads_read (leitura), ads_management (escrita)",
  scopes: ["ads_read", "ads_management (somente se gestão for habilitada)", "business_management (seleção de contas do negócio, a confirmar)"],
  webhookEvents: [],
  utmTransport: "Parâmetros de URL do anúncio com macros {{campaign.id}} etc. (catálogo a verificar)",
  moneyField: "spend (string decimal na moeda da conta: account_currency)",
  timezone: "date_start/date_stop no fuso da conta de anúncios",
  limits: "Rate limit por conta/app (Business Use Case) — tratar códigos 4/17/32/613 com backoff",
  capabilities: {
    read_accounts: { status: "planned", note: "Requer OAuth" },
    read_entities: { status: "planned", note: "Campanhas, conjuntos, anúncios por ID estável" },
    import_spend: { status: "supported", note: "Parser + persistência testados; sincronização real bloqueada" },
    read_insights: { status: "supported", note: "Parser testado" },
    manage_media: { status: "planned", note: "Escrita desabilitada por padrão (R02-09)" },
  },
  tests: ["packages/connectors/test/meta-ads.test.ts"],
  limitations: ["Sem credenciais: nenhuma chamada real realizada.", "Saldo da conta não é lido; ausência de saldo ≠ saldo zero."],
  lastVerifiedSuccess: null,
};

export interface MetaInsightRow {
  account_currency?: string;
  account_id?: string;
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  ad_id?: string;
  ad_name?: string;
  spend?: string;
  impressions?: string;
  inline_link_clicks?: string;
  reach?: string;
  date_start?: string;
  date_stop?: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INT = /^\d+$/;

function optInt(v: string | undefined): bigint | null {
  return v !== undefined && INT.test(v) ? BigInt(v) : null;
}

export function parseMetaInsights(
  rows: readonly MetaInsightRow[],
  level: SpendRow["level"],
  fallbackCurrency: string,
): { rows: SpendRow[]; errors: string[] } {
  const out: SpendRow[] = [];
  const errors: string[] = [];
  rows.forEach((r, idx) => {
    const currency = (r.account_currency ?? fallbackCurrency).toUpperCase();
    if (!r.date_start || !DATE.test(r.date_start) || r.date_start !== r.date_stop) {
      errors.push(`linha ${idx}: esperado detalhamento diário (date_start = date_stop)`);
      return;
    }
    const entityId =
      level === "ad" ? r.ad_id : level === "adset" ? r.adset_id : level === "campaign" ? r.campaign_id : r.account_id;
    if (!entityId) {
      errors.push(`linha ${idx}: ID da entidade ausente para nível ${level}`);
      return;
    }
    let spendMinor: bigint;
    try {
      spendMinor = parseDecimalToMinor(r.spend ?? "0", currency);
    } catch (e) {
      errors.push(`linha ${idx}: spend inválido (${(e as Error).message})`);
      return;
    }
    out.push({
      level,
      entityExternalId: String(entityId),
      campaignExternalId: r.campaign_id ?? null,
      entityName: (level === "ad" ? r.ad_name : level === "adset" ? r.adset_name : level === "campaign" ? r.campaign_name : null) ?? null,
      date: r.date_start,
      currency,
      spendMinor,
      impressions: optInt(r.impressions),
      linkClicks: optInt(r.inline_link_clicks),
      reach: optInt(r.reach),
    });
  });
  return { rows: out, errors };
}
