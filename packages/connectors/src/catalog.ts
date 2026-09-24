import { canonicalManifest } from "./checkout/canonical";
import { lowifyManifest } from "./checkout/lowify";
import { metaAdsManifest } from "./ads/meta-ads";
import { metaCapiManifest } from "./destinations/meta-capi";
import type { ConnectorManifest, DocumentationReference, ImplementationState } from "./types";

/**
 * Catálogo completo de integrações (R12-01, R12-03, R18-01, R20-01, R29-02, R32-07, R32-08).
 * Itens sem implementação aparecem com estado real ("Planejado"/"Em pesquisa"/"Bloqueado externamente").
 * Nenhum item deste catálogo responde sucesso sem implementação (R03-04, R44-03).
 */

function planned(
  id: string,
  displayName: string,
  kind: ConnectorManifest["kind"],
  group: string,
  opts: { state?: ImplementationState; note?: string; docs?: DocumentationReference[] } = {},
): ConnectorManifest {
  return {
    id,
    displayName,
    vendor: displayName,
    product: "A confirmar (identidade, domínio, tipo de produto e APIs)",
    kind,
    group,
    state: opts.state ?? "planned",
    stateNote: opts.note ?? "No catálogo; documentação oficial ainda não consultada nesta base de código.",
    docs: opts.docs ?? [],
    apiVersion: null,
    authentication: "A confirmar",
    scopes: [],
    webhookEvents: [],
    utmTransport: "A confirmar",
    moneyField: "A confirmar",
    timezone: "A confirmar",
    limits: "A confirmar",
    capabilities: {},
    tests: [],
    limitations: ["Sem implementação: nenhuma capacidade disponível."],
    lastVerifiedSuccess: null,
  };
}

const blockedDocs = (title: string, url: string): DocumentationReference[] => [
  { title, url, consultedAt: "2026-09-24", version: null, accessible: false, note: "Domínio bloqueado pelo proxy de rede deste ambiente" },
];

const CHECKOUT_PRIORITY = ["Kiwify", "Hotmart", "Cakto", "Kirvano", "PerfectPay", "Ticto", "Eduzz", "Braip", "Monetizze"];
const CHECKOUT_FUNNELS = ["Lastlink", "Doppus", "Greenn", "Hubla", "Payt", "Pepper", "Guru", "TriboPay", "Vega/Vegacheckout", "Paradise"];
const CHECKOUT_ECOM = ["Cartpanda", "Yampi", "Shopify", "WooCommerce", "Nuvemshop", "Adoorei", "Logzz"];
const PAYMENTS = ["Stripe", "Mercado Pago", "Pagar.me", "Asaas", "PagBank", "PayPal", "Appmax", "BananaPay"];
const INTERNATIONAL = ["ClickBank", "Digistore24", "BuyGoods", "MaxWeb", "Everflow", "Systeme.io"];
const COMPLEMENTARY = [
  "MundPay", "Disrupty", "Frendz", "InvictusPay", "NitroPagamentos", "GoatPay", "Hebreus", "IExperience", "PagTrust", "FortPay",
  "IronPay", "CinqPay", "SharkPays", "Zouti", "Pantherfy", "StrivPay", "AtomoPay", "AllPay", "BullPay", "OctusPay", "Zippify",
  "Masterfy", "InovaPag", "SoutPay", "WolfPay", "SigmaPagamentos", "Nexopayt", "WeGate", "Unicornify", "Allpes", "VittaPay",
  "FluxionPay", "NezzyPay", "PMHMPay", "TrivexPay", "GatPay", "BearPay", "AmandisPay", "Orbita", "DigiPag", "AlphaPay",
  "AssetPay", "BrGateway", "Creedx", "Hotfy", "KlivoPay", "Plumify", "PrimeGate", "Wise2Pay", "VisionPay", "SharkBytePay",
  "SigmaPay", "ZeroOnePay", "Traxon", "Bloo", "KitePay",
];

const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

const SPECIFIC_DOCS: Record<string, DocumentationReference[]> = {
  Hotmart: blockedDocs("Hotmart Developers", "https://developers.hotmart.com/"),
  Kiwify: blockedDocs("Kiwify — Central de ajuda de integrações", "https://ajuda.kiwify.com.br/pt-br/category/integracoes-1633r3w/"),
  Stripe: blockedDocs("Stripe webhooks", "https://docs.stripe.com/webhooks"),
};

export const CONNECTOR_CATALOG: readonly ConnectorManifest[] = [
  lowifyManifest,
  canonicalManifest,
  ...CHECKOUT_PRIORITY.map((n) =>
    planned(slug(n), n, "checkout", "Infoprodutos prioritários", SPECIFIC_DOCS[n] ? { state: "researching", note: "Referência oficial listada na especificação; domínio inacessível neste ambiente.", docs: SPECIFIC_DOCS[n] } : {}),
  ),
  ...CHECKOUT_FUNNELS.map((n) => planned(slug(n), n, "checkout", "Funis e vendas digitais")),
  ...CHECKOUT_ECOM.map((n) => planned(slug(n), n, "checkout", "Checkout e comércio eletrônico")),
  ...PAYMENTS.map((n) => planned(slug(n), n, "checkout", "Pagamentos e cobrança", SPECIFIC_DOCS[n] ? { state: "researching", docs: SPECIFIC_DOCS[n], note: "Documentação oficial identificada; domínio inacessível neste ambiente." } : {})),
  ...INTERNATIONAL.map((n) => planned(slug(n), n, "checkout", "Operação internacional")),
  ...COMPLEMENTARY.map((n) => planned(slug(n), n, "checkout", "Catálogo complementar (a pesquisar)", { note: "Nome da lista pública da UTMify; identidade, domínio e API não confirmados. Não representa endosso." })),
  // Redes de mídia (R20-01)
  metaAdsManifest,
  planned("google_ads", "Google Ads", "ad_network", "Redes de mídia", { state: "blocked_external", note: "Requer projeto Google Cloud, developer token e OAuth (DEP-GOOGLE-APP)." }),
  planned("tiktok_ads", "TikTok Ads", "ad_network", "Redes de mídia", { state: "blocked_external", note: "Requer app TikTok for Business aprovado (DEP-TIKTOK-APP)." }),
  ...["Microsoft Advertising", "Pinterest Ads", "LinkedIn Ads", "Snapchat Ads", "Kwai Ads", "Taboola", "Outbrain"].map((n) => planned(slug(n), n, "ad_network", "Redes de mídia")),
  // Destinos de conversão (R18-01)
  metaCapiManifest,
  planned("tiktok_events", "TikTok Pixel + Events API", "destination", "Destinos de conversão", { state: "blocked_external", note: "Deduplicação por event_id a confirmar na documentação oficial (bloqueada neste ambiente).", docs: blockedDocs("TikTok — Event deduplication", "https://ads.tiktok.com/resources/help/article/event-deduplication?lang=en") }),
  planned("google_data_manager", "Google Ads / Data Manager API", "destination", "Destinos de conversão", { state: "researching", note: "Rota atual para conversões offline a confirmar (restrições ao UploadClickConversions legado).", docs: [...blockedDocs("Data Manager API: offline conversions", "https://developers.google.com/data-manager/api/devguides/events/google-ads/offline"), ...blockedDocs("Google Ads API: upload offline conversions", "https://developers.google.com/google-ads/api/docs/conversions/upload-offline")] }),
  planned("ga4_mp", "Google Analytics 4 (Measurement Protocol)", "destination", "Destinos de conversão", { note: "Não substitui conversões do Google Ads (R18-02)." }),
  ...["Microsoft Advertising (conversões offline)", "Pinterest Conversions API", "Snapchat Conversions API", "LinkedIn Conversions API", "Kwai (postback)", "Taboola (postback)", "Outbrain (postback)"].map((n) => planned(slug(n), n, "destination", "Destinos de conversão")),
  // CRM (R29-02)
  ...["Kommo", "HubSpot", "Pipedrive", "RD Station", "Salesforce", "Zoho"].map((n) => planned(slug(n), n, "crm", "CRM")),
  // Mensageria (R28)
  planned("whatsapp_cloud", "WhatsApp Business Platform", "messaging", "WhatsApp", { state: "blocked_external", note: "Requer número e app aprovados na WhatsApp Business Platform (DEP-WHATSAPP)." }),
  // Exportação e automação (R32-07, R32-08)
  ...["Google Sheets", "Google Drive", "BigQuery", "Metabase", "Looker Studio", "Make", "n8n", "Zapier"].map((n) => planned(slug(n), n, "export", "Exportação e automação")),
];

export function findManifest(id: string): ConnectorManifest | undefined {
  return CONNECTOR_CATALOG.find((m) => m.id === id);
}
