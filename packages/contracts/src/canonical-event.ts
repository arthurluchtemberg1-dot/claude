import { z } from "zod";

/**
 * Contrato canônico interno v1.0 (seção 08). É um contrato PRÓPRIO: não é o formato de nenhum checkout.
 * Usado pelo conector "Sistema próprio" (webhook canônico assinado, R12-04) e como forma documentada
 * de integração. O servidor ignora qualquer organization_id/project_id recebido (R08-02, T21).
 */

export const CANONICAL_SCHEMA_VERSION = "1.0" as const;

export const INTERNAL_EVENT_TYPES = [
  "checkout.started",
  "payment.pending",
  "payment.approved",
  "payment.failed",
  "payment.canceled",
  "payment.expired",
  "refund.created",
  "refund.succeeded",
  "dispute.opened",
  "dispute.won",
  "chargeback.confirmed",
  "subscription.renewed",
  "subscription.canceled",
  "lead.created",
  "deal.won",
] as const;
export type InternalEventType = (typeof INTERNAL_EVENT_TYPES)[number];

const opaqueId = z.string().trim().min(1).max(200);
const currency = z.string().regex(/^[A-Z]{3}$/, "Moeda ISO 4217 em maiúsculas");
const amountMinor = z.number().int().safe().nonnegative();
const utmValue = z.string().max(500).nullish();

export const PAYMENT_METHODS = ["pix", "boleto", "credit_card", "debit_card", "wallet", "other", "unknown"] as const;

export const canonicalItemSchema = z.object({
  external_product_id: opaqueId,
  name: z.string().max(300).nullish(),
  item_type: z.string().max(40).nullish(),
  unit_amount_minor: amountMinor.nullish(),
  quantity: z.number().int().positive().max(10_000).default(1),
});

const canonicalEventBase = z.object({
    schema_version: z.literal(CANONICAL_SCHEMA_VERSION),
    // Aceitos para compatibilidade, porém IGNORADOS: organização e projeto vêm da conexão autenticada.
    organization_id: z.unknown().optional(),
    project_id: z.unknown().optional(),
    connection_id: z.unknown().optional(),
    source: z.object({
      provider: z.string().max(60).nullish(),
      provider_account_id: z.string().max(200).nullish(),
      event_id: opaqueId,
      event_type: z.string().max(100).nullish(),
      api_version: z.string().max(40).nullish(),
    }),
    event_type: z.enum(INTERNAL_EVENT_TYPES),
    occurred_at: z.iso.datetime({ offset: true }),
    order: z
      .object({
        external_order_id: opaqueId,
        external_transaction_id: opaqueId.nullish(),
        parent_order_id: opaqueId.nullish(),
        currency,
        amount_minor: amountMinor.nullish(),
        payment_method: z.enum(PAYMENT_METHODS).default("unknown"),
        transaction_kind: z.enum(["initial", "upsell", "downsell", "renewal", "manual"]).default("initial"),
        org_share_minor: amountMinor.nullish(),
        fee_minor: amountMinor.nullish(),
        is_test: z.boolean().default(false),
        items: z.array(canonicalItemSchema).max(200).default([]),
      })
      .nullish(),
    refund: z
      .object({
        external_refund_id: opaqueId,
        amount_minor: amountMinor.nullish(),
        semantics: z.enum(["incremental", "cumulative", "full"]),
      })
      .nullish(),
    dispute: z
      .object({
        external_dispute_id: opaqueId,
        amount_minor: amountMinor.nullish(),
        covers_refund_id: opaqueId.nullish(),
      })
      .nullish(),
    attribution: z
      .object({
        tracking_token: z.string().max(128).nullish(),
        utm_source: utmValue,
        utm_medium: utmValue,
        utm_campaign: utmValue,
        utm_content: utmValue,
        utm_term: utmValue,
        campaign_id: z.string().max(64).nullish(),
        adset_id: z.string().max(64).nullish(),
        ad_id: z.string().max(64).nullish(),
        fbclid: z.string().max(500).nullish(),
        gclid: z.string().max(500).nullish(),
      })
      .nullish(),
    customer: z
      .object({
        email: z.string().email().max(254).nullish(),
        phone: z.string().max(32).nullish(),
        name: z.string().max(200).nullish(),
      })
      .nullish(),
    verification: z.unknown().optional(),
  });

export const canonicalEventSchema = canonicalEventBase.superRefine((v, ctx) => {
    const needsOrder = v.event_type.startsWith("payment.") || v.event_type.startsWith("refund.") || v.event_type.startsWith("dispute.") || v.event_type === "chargeback.confirmed" || v.event_type === "subscription.renewed";
    if (needsOrder && !v.order) ctx.addIssue({ code: "custom", message: `${v.event_type} exige o objeto order`, path: ["order"] });
    if ((v.event_type === "payment.approved" || v.event_type === "subscription.renewed") && v.order && (v.order.amount_minor === null || v.order.amount_minor === undefined)) {
      // Sem valor não há venda aprovada: não adivinhar dinheiro (T20).
      ctx.addIssue({ code: "custom", message: "payment.approved exige order.amount_minor", path: ["order", "amount_minor"] });
    }
    if (v.event_type === "refund.succeeded" && !v.refund) ctx.addIssue({ code: "custom", message: "refund.succeeded exige refund", path: ["refund"] });
    if ((v.event_type === "chargeback.confirmed" || v.event_type === "dispute.won") && !v.dispute) ctx.addIssue({ code: "custom", message: `${v.event_type} exige dispute`, path: ["dispute"] });
  });

export type CanonicalEvent = z.infer<typeof canonicalEventSchema>;

const KNOWN_TOP_LEVEL = new Set(Object.keys(canonicalEventBase.shape));

/** Campos de primeiro nível desconhecidos (registrados para diagnóstico, nunca interpretados). */
export function unknownTopLevelFields(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  return Object.keys(body).filter((k) => !KNOWN_TOP_LEVEL.has(k));
}
