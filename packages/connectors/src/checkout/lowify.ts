import { createHash } from "node:crypto";
import { jsonNumberToMinor, MoneyError, parseWallTimeInZone, type FinancialEvent } from "@tracker/domain";
import type {
  AuthContext,
  AuthResult,
  CheckoutConnector,
  ConnectorManifest,
  DedupIdentity,
  InboundWebhook,
  NormalizeContext,
  NormalizeResult,
  NormalizedOrderEvent,
} from "../types";

/**
 * Conector Lowify — webhook nativo de notificação de vendas.
 *
 * Fonte: repositório público github.com/lowify/docs (commit b25e43e, 23/09/2026):
 *   - internal-webhook.md, "Documentation version: 1.0.0": eventos sale.pending e sale.paid,
 *     header Idempotency-Key "{order_id}:{event}:{product_id}", payload JSON documentado.
 *   - deploys/2026-08-26-dashboard-seller-webhook-refunded: evento sale.refunded, disparado
 *     somente após aprovação do reembolso ("A solicitação de reembolso pendente não deve disparar o evento").
 *
 * NÃO documentado (tratado como hipótese configurável e visível; ver EXTERNAL_DEPENDENCIES DEP-LOWIFY-*):
 *   - Assinatura/autenticação do webhook → usamos token opaco na URL do endpoint (risco registrado, R09-20).
 *   - Moeda (payload sem campo de moeda) → config.currency (padrão BRL).
 *   - Fuso do campo timestamp "Y-m-d H:i:s" → config.source_timezone (padrão America/Sao_Paulo).
 *   - Semântica do valor em sale.refunded (integral vs parcial) → tratado como reembolso integral da venda.
 *   - Passagem de token opaco próprio pelo checkout → não documentada; somente UTMs retornam no webhook.
 *   - tracking.click_id / tracking.campaign_id são identificadores internos da Lowify, NÃO IDs de anúncios.
 */

export const LOWIFY_EVENTS = ["sale.pending", "sale.paid", "sale.refunded"] as const;
export type LowifyEvent = (typeof LOWIFY_EVENTS)[number];

export const lowifyManifest: ConnectorManifest = {
  id: "lowify",
  displayName: "Lowify",
  vendor: "Lowify",
  product: "Webhook nativo de vendas (dashboard-seller → Integrações → Webhooks)",
  kind: "checkout",
  group: "Primeiro fluxo real",
  state: "implemented_locally",
  stateNote:
    "Normalização implementada e testada com fixtures derivadas do exemplo documentado. Sem payload real anonimizado nem venda de teste autorizada: não validado em sandbox/produção.",
  docs: [
    {
      title: "Webhook Interno da Lowify (internal-webhook.md)",
      url: "https://github.com/lowify/docs/blob/b25e43ea5f0db4b392e3928a7a6be1cc1cabb940/internal-webhook.md",
      consultedAt: "2026-09-24",
      version: "1.0.0",
      accessible: true,
    },
    {
      title: "Deploy — cadastro de webhook para venda reembolsada (sale.refunded)",
      url: "https://github.com/lowify/docs/blob/b25e43ea5f0db4b392e3928a7a6be1cc1cabb940/deploys/2026-08-26-dashboard-seller-webhook-refunded/2026-08-26_DASHBOARD_SELLER_WEBHOOK_REFUNDED_DEPLOY.md",
      consultedAt: "2026-09-24",
      version: "deploy 2026-08-26 (commit b9bd57e do dashboard-seller)",
      accessible: true,
    },
    { title: "Site Lowify", url: "https://lowify.com.br/", consultedAt: "2026-09-24", version: null, accessible: false, note: "Bloqueado pelo proxy de rede deste ambiente" },
  ],
  apiVersion: "Webhook doc 1.0.0",
  authentication: "Não documentada pela Lowify. Proteção: URL com token opaco de alta entropia (hash no banco), rotação e revogação.",
  scopes: [],
  webhookEvents: [...LOWIFY_EVENTS],
  utmTransport:
    "Webhook devolve tracking.utm_source/medium/campaign/content/term, click_id e campaign_id (internos da Lowify). Parâmetros aceitos na URL do checkout e preservação em upsell: não documentados.",
  moneyField: "sale_amount (number, valor total da venda em unidades decimais); product.price (valor do item do disparo). Moeda não informada.",
  timezone: "timestamp 'Y-m-d H:i:s' sem fuso — não documentado",
  limits: "Não documentados. Um disparo por produto da venda (Idempotency-Key inclui product_id).",
  capabilities: {
    receive_sales_webhook: { status: "supported", note: "sale.pending, sale.paid, sale.refunded" },
    webhook_authentication: { status: "not_supported", note: "Sem assinatura documentada; token opaco na URL" },
    pending_payments: { status: "supported", note: "sale.pending (ex.: PIX gerado)" },
    refunds: { status: "supported", note: "sale.refunded após aprovação do reembolso; valor parcial não documentado" },
    chargebacks: { status: "unknown", note: "Não documentado" },
    subscriptions: { status: "unknown", note: "Webhook não identifica renovação" },
    order_bump_items: { status: "supported", note: "Um disparo por produto; product.type indica o tipo do item" },
    query_orders_api: { status: "unknown", note: "API de consulta de pedidos não documentada publicamente" },
    historical_import: { status: "unknown", note: "Sem API documentada; possível via exportação do painel (a confirmar)" },
    reconciliation: { status: "planned", note: "Por importação de exportação do painel, quando o formato for fornecido" },
    utm_passthrough: { status: "supported", note: "UTMs retornam no webhook (origem da captura não documentada)" },
    tracking_token_passthrough: { status: "unknown", note: "Sem campo documentado para token próprio" },
  },
  tests: ["packages/connectors/test/lowify.test.ts", "apps/api/test/integration/webhook-pipeline.test.ts"],
  limitations: [
    "Sem assinatura do provedor: qualquer pessoa com a URL do endpoint pode enviar eventos; mantenha a URL em segredo e rotacione em caso de exposição.",
    "Sem API de confirmação documentada: não há verificação independente do pagamento além do webhook.",
    "Reembolso parcial não documentado: sale.refunded é tratado como reembolso integral.",
    "Moeda e fuso assumidos pela configuração da conexão.",
  ],
  lastVerifiedSuccess: null,
};

interface LowifyPayload {
  event: string;
  order_id: string;
  sale_amount: number;
  status: string | null;
  timestamp: string;
  product: { id: string; name: string | null; price: number | null; type: string | null };
  customer: { name: string | null; email: string | null; phone: string | null } | null;
  tracking: Record<string, unknown> | null;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown, max = 500): string | null {
  if (typeof v === "string") return v.trim() === "" ? null : v.slice(0, max);
  return null;
}

/** IDs numéricos documentados como integer são guardados como string opaca (R07-05). */
function idString(v: unknown): string | null {
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
  if (typeof v === "string" && v.trim() !== "" && v.length <= 200) return v.trim();
  return null;
}

const KNOWN_FIELDS = new Set(["event", "order_id", "sale_amount", "status", "timestamp", "product", "customer", "tracking"]);

function parse(body: unknown): { ok: true; value: LowifyPayload } | { ok: false; reason: string } {
  const o = asObject(body);
  if (!o) return { ok: false, reason: "Corpo não é um objeto JSON" };
  const event = str(o.event, 100);
  if (!event) return { ok: false, reason: "Campo 'event' ausente" };
  const orderId = idString(o.order_id);
  if (!orderId) return { ok: false, reason: "Campo 'order_id' ausente ou inválido" };
  if (typeof o.sale_amount !== "number") return { ok: false, reason: "Campo 'sale_amount' ausente ou não numérico" };
  const timestamp = str(o.timestamp, 40);
  if (!timestamp) return { ok: false, reason: "Campo 'timestamp' ausente" };
  const p = asObject(o.product);
  if (!p) return { ok: false, reason: "Objeto 'product' ausente" };
  const productId = idString(p.id);
  if (!productId) return { ok: false, reason: "Campo 'product.id' ausente" };
  const c = asObject(o.customer);
  return {
    ok: true,
    value: {
      event,
      order_id: orderId,
      sale_amount: o.sale_amount,
      status: str(o.status, 40),
      timestamp,
      product: {
        id: productId,
        name: str(p.name, 300),
        price: typeof p.price === "number" ? p.price : null,
        type: str(p.type, 40),
      },
      customer: c ? { name: str(c.name, 200), email: str(c.email, 254), phone: str(c.phone, 32) } : null,
      tracking: asObject(o.tracking),
    },
  };
}

export const lowifyConnector: CheckoutConnector = {
  manifest: lowifyManifest,

  authenticate(_req: InboundWebhook, ctx: AuthContext): AuthResult {
    if (!ctx.urlTokenVerified) return { ok: false, reason: "Token do endpoint inválido" };
    return {
      ok: true,
      method: "url_token",
      warnings: ["Lowify não documenta assinatura de webhook; autenticidade depende do sigilo da URL do endpoint."],
    };
  },

  dedupIdentity(body: unknown, req: InboundWebhook): DedupIdentity | null {
    const o = asObject(body);
    const event = str(o?.event, 100);
    const orderId = idString(o?.order_id);
    const productId = idString(asObject(o?.product)?.id);
    const header = req.headers["idempotency-key"] ?? null;
    const notes: string[] = [];
    if (event && orderId && productId) {
      const computed = `${orderId}:${event}:${productId}`;
      if (header && header !== computed) notes.push(`Idempotency-Key recebido difere do calculado a partir do corpo`);
      return {
        key: header === computed ? header : computed,
        method: header === computed ? "provider_idempotency_header" : "fingerprint",
        sourceEventType: event,
        notes,
      };
    }
    if (header && header.length <= 300) return { key: `hdr:${header}`, method: "provider_idempotency_header", sourceEventType: event, notes };
    // Fingerprint determinístico do corpo (sem horário de recebimento). Colisões detectáveis por body_sha256.
    return { key: `sha256:${createHash("sha256").update(req.rawBody).digest("hex")}`, method: "fingerprint", sourceEventType: event, notes: ["Corpo sem campos de identidade documentados"] };
  },

  normalize(body: unknown, ctx: NormalizeContext): NormalizeResult {
    const parsed = parse(body);
    if (!parsed.ok) return { status: "quarantine", reason: parsed.reason };
    const p = parsed.value;
    if (!(LOWIFY_EVENTS as readonly string[]).includes(p.event)) {
      return { status: "quarantine", reason: `Evento Lowify desconhecido: "${p.event}" (guardado para diagnóstico, sem efeito financeiro)` };
    }
    const selected = Array.isArray(ctx.config.selected_events) ? (ctx.config.selected_events as string[]) : [...LOWIFY_EVENTS];
    if (!selected.includes(p.event)) return { status: "ignored", reason: `Evento ${p.event} não selecionado na conexão` };

    const currency = typeof ctx.config.currency === "string" ? ctx.config.currency : "BRL";
    const tz = typeof ctx.config.source_timezone === "string" ? ctx.config.source_timezone : "America/Sao_Paulo";
    const notes = [`Moeda assumida pela configuração: ${currency}`, `Fuso do timestamp assumido: ${tz}`];

    let occurredAt: Date;
    try {
      occurredAt = parseWallTimeInZone(p.timestamp, tz);
    } catch {
      return { status: "quarantine", reason: `timestamp inválido: "${p.timestamp.slice(0, 40)}"` };
    }
    let saleMinor: bigint;
    let priceMinor: bigint | null = null;
    try {
      saleMinor = jsonNumberToMinor(p.sale_amount, currency);
      if (p.product.price !== null) priceMinor = jsonNumberToMinor(p.product.price, currency);
    } catch (err) {
      const msg = err instanceof MoneyError ? err.message : "valor inválido";
      return { status: "quarantine", reason: `Valor monetário não interpretável: ${msg}` };
    }
    if (saleMinor < 0n || (priceMinor !== null && priceMinor < 0n)) return { status: "quarantine", reason: "Valor negativo não suportado" };

    const transactionKey = `lowify:${p.order_id}`;
    const financial: FinancialEvent[] = [
      {
        type: "order.items",
        items: [
          {
            externalProductId: p.product.id,
            name: p.product.name,
            itemType: p.product.type,
            unitAmountMinor: priceMinor,
            quantity: 1,
            currency,
          },
        ],
      },
    ];
    let eventType: string;
    switch (p.event as LowifyEvent) {
      case "sale.pending":
        eventType = "payment.pending";
        financial.push({ type: "payment.pending", transactionKey, amountMinor: saleMinor, currency, method: "unknown", occurredAt, kind: "initial" });
        break;
      case "sale.paid":
        if (saleMinor === 0n) return { status: "quarantine", reason: "sale.paid com sale_amount zero: não é possível confirmar receita" };
        eventType = "payment.approved";
        financial.push({ type: "payment.approved", transactionKey, amountMinor: saleMinor, currency, method: "unknown", occurredAt, kind: "initial" });
        break;
      case "sale.refunded":
        eventType = "refund.succeeded";
        notes.push("sale.refunded tratado como reembolso integral (valor parcial não documentado pela Lowify)");
        financial.push({ type: "refund.succeeded", transactionKey, reversalKey: `lowify:${p.order_id}:refund`, amountMinor: null, semantics: "full", currency, occurredAt });
        break;
    }
    if (p.status && p.event === "sale.paid" && p.status !== "paid") notes.push(`status atual da venda no disparo: "${p.status}"`);

    const t = p.tracking ?? {};
    const providerRefs: Record<string, string> = {};
    const clickRef = idString(t.click_id);
    const campaignRef = idString(t.campaign_id);
    if (clickRef) providerRefs.lowify_click_id = clickRef;
    if (campaignRef) providerRefs.lowify_campaign_id = campaignRef;

    // Token próprio só é lido do campo explicitamente configurado como transportador (ex.: utm_term),
    // e somente no formato do rastreador; qualquer outro valor permanece como UTM declarada.
    const carrier = typeof ctx.config.token_carrier === "string" ? ctx.config.token_carrier : null;
    let trackingToken: string | null = null;
    if (carrier && /^utm_(source|medium|campaign|content|term)$/.test(carrier)) {
      const v = str(t[carrier], 128);
      const m = v ? /(?:^|[|_\s-])(trk_[A-Za-z0-9]{16,40})$/.exec(v) ?? /^(trk_[A-Za-z0-9]{16,40})$/.exec(v) : null;
      if (m) trackingToken = m[1]!;
    }

    const event: NormalizedOrderEvent = {
      schemaVersion: "1.0",
      eventType: eventType!,
      sourceEventType: p.event,
      occurredAt,
      externalOrderId: p.order_id,
      parentExternalOrderId: null,
      isTest: ctx.connectionEnvironment === "test",
      paymentMethod: null,
      financial,
      contact: p.customer ? { email: p.customer.email?.toLowerCase() ?? null, phone: p.customer.phone, name: p.customer.name } : null,
      declaredTracking: {
        trackingToken,
        utm: {
          source: str(t.utm_source),
          medium: str(t.utm_medium),
          campaign: str(t.utm_campaign),
          content: str(t.utm_content),
          term: str(t.utm_term),
        },
        campaignId: null,
        adsetId: null,
        adId: null,
        clickIds: {},
        providerRefs,
      },
      notes,
    };
    const unknownFields = Object.keys(body as object).filter((k) => !KNOWN_FIELDS.has(k));
    return { status: "ok", events: [event], unknownFields };
  },
};
