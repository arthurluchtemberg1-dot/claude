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
  product: "Marketing API (Graph API) — contas, entidades, insights e gestão",
  kind: "ad_network",
  group: "Redes de mídia",
  state: "implemented_locally",
  stateNote:
    "Conexão por token de usuário do sistema (Business Manager), sincronização de contas/campanhas/conjuntos/anúncios/insights e ações de gestão implementadas e testadas contra Graph API falsa no formato dos SDKs oficiais. Ainda sem evidência com conta real: valide com /v1/meta/check e a primeira sincronização.",
  docs: [
    { title: "facebook-nodejs-business-sdk 24.0.1 — AdAccount, Campaign, AdSet, Ad, AdsInsights, FacebookAdsApi", url: "https://www.npmjs.com/package/facebook-nodejs-business-sdk/v/24.0.1", consultedAt: "2026-10-25", version: "v24.0", accessible: true },
    { title: "facebook_business 26.0.2 (PyPI) — api.py (versão Graph padrão v26.0, appsecret_proof), adobjects", url: "https://pypi.org/project/facebook-business/26.0.2/", consultedAt: "2026-10-25", version: "v26.0", accessible: true },
    { title: "Marketing API authorization", url: "https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started/authorization", consultedAt: "2026-10-25", version: null, accessible: false, note: "Bloqueado pelo proxy; formatos conferidos nos SDKs oficiais" },
  ],
  apiVersion: "v26.0",
  authentication: "Token de acesso de usuário do sistema do Business Manager (colado em formulário protegido, guardado cifrado); appsecret_proof quando META_APP_SECRET está configurado",
  scopes: ["ads_read (leitura)", "ads_management (pausar, ativar, orçamento, duplicar)", "business_management (opcional; acesso às contas do negócio)"],
  webhookEvents: [],
  utmTransport: "Parâmetros de URL do anúncio com macros {{campaign.id}}, {{adset.id}}, {{ad.id}} (ver Instalação → UTM)",
  moneyField: "Insights: spend em decimal na moeda da conta; campos de conta e orçamentos (daily_budget, spend_cap, amount_spent) em inteiro na menor unidade",
  timezone: "date_start/date_stop no fuso da conta de anúncios (timezone_name)",
  limits: "Códigos 4/17/32/613 e 80000–80014 tratados como limite de taxa (nova tentativa com espera); 190/102 marcam a conexão como token expirado",
  capabilities: {
    read_accounts: { status: "supported", note: "/me/adaccounts com paginação; status, limite de gasto, valor gasto, moeda e fuso" },
    read_entities: { status: "supported", note: "Campanhas, conjuntos (com fase de aprendizado) e anúncios por ID estável" },
    import_spend: { status: "supported", note: "Insights diários em 3 níveis com substituição do snapshot (correções tardias não duplicam)" },
    read_insights: { status: "supported", note: "Gasto, impressões, cliques no link, alcance diário e compras reportadas (separadas das vendas confirmadas)" },
    manage_media: { status: "supported", note: "Pausar, ativar, orçamento diário, renomear e duplicar (cópia pausada); exige ads_management + liberação do proprietário + ALLOW_EXTERNAL_DELIVERY=true" },
  },
  tests: ["packages/connectors/test/canonical-meta.test.ts", "packages/connectors/test/meta-graph.test.ts", "apps/api/test/integration/meta.test.ts", "apps/api/test/integration/meta-actions.test.ts"],
  limitations: [
    "Sem evidência com conta real nesta base: o primeiro uso confirma formatos de valores (menor unidade) e permissões.",
    "Saldo pré-pago (balance) não é exibido como saldo disponível; o alerta usa limite de gasto (spend_cap − amount_spent). Ausência de dado nunca vira zero.",
    "Duplicação sem resposta não é repetida automaticamente (evita cópias em dobro): confira no Gerenciador de Anúncios.",
    "Alcance e frequência de período não são somados a partir de dias.",
  ],
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
