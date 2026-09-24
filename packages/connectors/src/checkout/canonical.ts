import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalEventSchema, unknownTopLevelFields, type CanonicalEvent } from "@tracker/contracts";
import type { FinancialEvent, PaymentMethod } from "@tracker/domain";
import type {
  AuthContext,
  AuthResult,
  CheckoutConnector,
  ConnectorManifest,
  DedupIdentity,
  InboundWebhook,
  NormalizeContext,
  NormalizeResult,
} from "../types";

/**
 * Sistema próprio: webhook canônico assinado (R12-04). Contrato: packages/contracts (schema_version 1.0).
 *
 * Assinatura: header `X-Tracker-Signature: t=<unix>,v1=<hex>` onde
 *   v1 = HMAC-SHA256(segredo, `${t}.${corpoBruto}`)
 * Janela anti-replay padrão de 300 s, compatível com retransmissões legítimas porque a idempotência
 * por source.event_id absorve repetições (R40-10). Durante rotação, o segredo anterior é aceito.
 */

export const SIGNATURE_HEADER = "x-tracker-signature";
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function signCanonicalBody(secret: string, rawBody: string | Buffer, timestampSeconds: number): string {
  const mac = createHmac("sha256", secret).update(`${timestampSeconds}.`).update(rawBody).digest("hex");
  return `t=${timestampSeconds},v1=${mac}`;
}

export function verifyCanonicalSignature(
  header: string | undefined,
  rawBody: Buffer,
  secrets: readonly string[],
  now: Date,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): { ok: true } | { ok: false; reason: string } {
  if (!header) return { ok: false, reason: "Assinatura ausente" };
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return { ok: false, reason: "Assinatura malformada" };
  if (Math.abs(now.getTime() / 1000 - t) > toleranceSeconds) return { ok: false, reason: "Assinatura fora da janela de tempo (possível replay)" };
  const provided = Buffer.from(v1, "hex");
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest();
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) return { ok: true };
  }
  return { ok: false, reason: "Assinatura inválida" };
}

export const canonicalManifest: ConnectorManifest = {
  id: "custom",
  displayName: "Sistema próprio (webhook canônico assinado)",
  vendor: "Tracker",
  product: "Contrato canônico v1.0",
  kind: "checkout",
  group: "Sistemas próprios",
  state: "implemented_locally",
  stateNote: "Contrato próprio: implementado e testado ponta a ponta localmente. Validação externa depende do sistema emissor do cliente.",
  docs: [{ title: "docs/integrations/CANONICAL_WEBHOOK.md", url: "docs/integrations/CANONICAL_WEBHOOK.md", consultedAt: "2026-09-24", version: "1.0", accessible: true }],
  apiVersion: "1.0",
  authentication: "HMAC-SHA256 com timestamp (X-Tracker-Signature) + token opaco na URL",
  scopes: [],
  webhookEvents: ["payment.pending", "payment.approved", "payment.failed", "payment.canceled", "payment.expired", "refund.succeeded", "chargeback.confirmed", "dispute.won", "subscription.renewed"],
  utmTransport: "attribution.tracking_token e UTMs no corpo",
  moneyField: "order.amount_minor (inteiro na menor unidade) + order.currency (ISO 4217)",
  timezone: "occurred_at ISO 8601 com offset",
  limits: "Corpo até 256 KiB",
  capabilities: {
    receive_sales_webhook: { status: "supported", note: "Contrato canônico" },
    webhook_authentication: { status: "supported", note: "HMAC com anti-replay" },
    pending_payments: { status: "supported", note: "payment.pending" },
    refunds: { status: "supported", note: "incremental/cumulativo/integral" },
    chargebacks: { status: "supported", note: "chargeback.confirmed / dispute.won" },
    subscriptions: { status: "supported", note: "subscription.renewed" },
    order_bump_items: { status: "supported", note: "order.items" },
    tracking_token_passthrough: { status: "supported", note: "attribution.tracking_token" },
  },
  tests: ["packages/connectors/test/canonical.test.ts", "apps/api/test/integration/webhook-pipeline.test.ts"],
  limitations: ["O emissor é responsável por enviar event_id estável por evento semântico."],
  lastVerifiedSuccess: null,
};

function methodOf(m: string): PaymentMethod {
  return (["pix", "boleto", "credit_card", "debit_card", "wallet", "other"] as const).includes(m as never) ? (m as PaymentMethod) : "unknown";
}

function toFinancial(e: CanonicalEvent): FinancialEvent[] | { quarantine: string } | { ignored: string } {
  const occurredAt = new Date(e.occurred_at);
  const o = e.order;
  const out: FinancialEvent[] = [];
  if (o && o.items.length) {
    out.push({
      type: "order.items",
      items: o.items.map((i) => ({
        externalProductId: i.external_product_id,
        name: i.name ?? null,
        itemType: i.item_type ?? null,
        unitAmountMinor: i.unit_amount_minor === null || i.unit_amount_minor === undefined ? null : BigInt(i.unit_amount_minor),
        quantity: i.quantity,
        currency: o.currency,
      })),
    });
  }
  if (!o) return { ignored: `${e.event_type} sem efeito financeiro` };
  const txKey = o.external_transaction_id ?? `order:${o.external_order_id}`;
  const amount = o.amount_minor === null || o.amount_minor === undefined ? null : BigInt(o.amount_minor);
  switch (e.event_type) {
    case "payment.pending":
    case "payment.failed":
    case "payment.canceled":
    case "payment.expired":
      out.push({ type: e.event_type, transactionKey: txKey, amountMinor: amount, currency: o.currency, method: methodOf(o.payment_method), occurredAt, kind: o.transaction_kind });
      break;
    case "payment.approved":
    case "subscription.renewed":
      if (amount === null) return { quarantine: "Aprovação sem valor" };
      out.push({
        type: "payment.approved",
        transactionKey: txKey,
        amountMinor: amount,
        currency: o.currency,
        method: methodOf(o.payment_method),
        occurredAt,
        kind: e.event_type === "subscription.renewed" ? "renewal" : o.transaction_kind,
        orgShareMinor: o.org_share_minor === null || o.org_share_minor === undefined ? null : BigInt(o.org_share_minor),
        feeMinor: o.fee_minor === null || o.fee_minor === undefined ? null : BigInt(o.fee_minor),
      });
      break;
    case "refund.succeeded": {
      const r = e.refund!;
      out.push({
        type: "refund.succeeded",
        transactionKey: o.external_transaction_id ?? null,
        reversalKey: `refund:${r.external_refund_id}`,
        amountMinor: r.amount_minor === null || r.amount_minor === undefined ? null : BigInt(r.amount_minor),
        semantics: r.semantics,
        currency: o.currency,
        occurredAt,
      });
      break;
    }
    case "chargeback.confirmed": {
      const d = e.dispute!;
      out.push({
        type: "chargeback.confirmed",
        transactionKey: o.external_transaction_id ?? null,
        reversalKey: `dispute:${d.external_dispute_id}`,
        amountMinor: d.amount_minor === null || d.amount_minor === undefined ? null : BigInt(d.amount_minor),
        currency: o.currency,
        occurredAt,
        ...(d.covers_refund_id ? { coversRefundKey: `refund:${d.covers_refund_id}` } : {}),
      });
      break;
    }
    case "dispute.won": {
      const d = e.dispute!;
      out.push({
        type: "dispute.won",
        winKey: `dispute_won:${d.external_dispute_id}:${e.source.event_id}`,
        reversalKey: `dispute:${d.external_dispute_id}`,
        amountMinor: d.amount_minor === null || d.amount_minor === undefined ? null : BigInt(d.amount_minor),
        currency: o.currency,
        occurredAt,
      });
      break;
    }
    default:
      // refund.created, dispute.opened etc.: registrados sem efeito financeiro (não são confirmação).
      if (out.length === 0) return { ignored: `${e.event_type} registrado sem efeito financeiro` };
  }
  return out;
}

export const canonicalConnector: CheckoutConnector = {
  manifest: canonicalManifest,

  authenticate(req: InboundWebhook, ctx: AuthContext): AuthResult {
    if (!ctx.urlTokenVerified) return { ok: false, reason: "Token do endpoint inválido" };
    const secrets = [ctx.secrets.current, ctx.secrets.previous].filter((s): s is string => !!s);
    if (!secrets.length) return { ok: false, reason: "Conexão sem segredo de assinatura configurado" };
    const res = verifyCanonicalSignature(req.headers[SIGNATURE_HEADER], req.rawBody, secrets, req.receivedAt);
    return res.ok ? { ok: true, method: "hmac_sha256", warnings: [] } : { ok: false, reason: res.reason };
  },

  dedupIdentity(body: unknown): DedupIdentity | null {
    const src = (body as { source?: { event_id?: unknown; event_type?: unknown } } | null)?.source;
    const id = typeof src?.event_id === "string" && src.event_id.length <= 200 ? src.event_id : null;
    if (!id) return null;
    return { key: `evt:${id}`, method: "provider_event_id", sourceEventType: typeof src?.event_type === "string" ? src.event_type : null, notes: [] };
  },

  normalize(body: unknown, ctx: NormalizeContext): NormalizeResult {
    const parsed = canonicalEventSchema.safeParse(body);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`);
      return { status: "quarantine", reason: `Contrato canônico inválido — ${issues.join("; ")}` };
    }
    const e = parsed.data;
    const fin = toFinancial(e);
    if ("quarantine" in fin) return { status: "quarantine", reason: fin.quarantine };
    if ("ignored" in fin) return { status: "ignored", reason: fin.ignored };
    const a = e.attribution;
    const clickIds: Record<string, string> = {};
    if (a?.fbclid) clickIds.fbclid = a.fbclid;
    if (a?.gclid) clickIds.gclid = a.gclid;
    const notes: string[] = [];
    if (e.organization_id !== undefined) notes.push("organization_id do corpo ignorado; organização resolvida pela conexão");
    return {
      status: "ok",
      unknownFields: unknownTopLevelFields(body),
      events: [
        {
          schemaVersion: "1.0",
          eventType: e.event_type,
          sourceEventType: e.source.event_type ?? e.event_type,
          occurredAt: new Date(e.occurred_at),
          externalOrderId: e.order!.external_order_id,
          parentExternalOrderId: e.order!.parent_order_id ?? null,
          isTest: e.order!.is_test || ctx.connectionEnvironment === "test",
          paymentMethod: e.order!.payment_method,
          financial: fin,
          contact: e.customer ? { email: e.customer.email?.toLowerCase() ?? null, phone: e.customer.phone ?? null, name: e.customer.name ?? null } : null,
          declaredTracking: a
            ? {
                trackingToken: a.tracking_token ?? null,
                utm: { source: a.utm_source ?? null, medium: a.utm_medium ?? null, campaign: a.utm_campaign ?? null, content: a.utm_content ?? null, term: a.utm_term ?? null },
                campaignId: a.campaign_id ?? null,
                adsetId: a.adset_id ?? null,
                adId: a.ad_id ?? null,
                clickIds,
                providerRefs: {},
              }
            : null,
          notes,
        },
      ],
    };
  },
};
