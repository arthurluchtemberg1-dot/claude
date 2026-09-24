import { randomUUID } from "node:crypto";
import type { PoolClient } from "@tracker/db";
import { z } from "zod";
import { audit } from "../lib/org-tx";

/**
 * Venda manual/offline ou importada pela API pública (R24-05, R33-02): vira um evento canônico com fonte "manual" e segue
 * o MESMO pipeline auditado do checkout (recebimento → worker → pedido/razão). Confirmação manual é distinta da
 * confirmação do checkout (provedor "manual", auth_method identifica usuário ou chave de API).
 */

export const manualSaleSchema = z.object({
  project_id: z.string().uuid(),
  external_order_id: z.string().trim().min(1).max(200),
  amount_minor: z.number().int().positive().safe(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  occurred_at: z.iso.datetime({ offset: true }),
  payment_method: z.enum(["pix", "boleto", "credit_card", "debit_card", "wallet", "other", "unknown"]).default("other"),
  reference: z.string().trim().min(1).max(300),
  utm_source: z.string().max(200).optional(),
  utm_medium: z.string().max(200).optional(),
  utm_campaign: z.string().max(200).optional(),
});
export type ManualSale = z.infer<typeof manualSaleSchema>;

export async function createManualSale(
  c: PoolClient,
  input: { organizationId: string; sale: ManualSale; actor: { type: "user" | "api_key"; id: string }; isDemo: boolean; isTest: boolean; requestId: string },
): Promise<{ receiptId: string } | { duplicate: true }> {
  const { sale, organizationId: orgId } = input;
  const canonical = {
    schema_version: "1.0",
    source: { provider: "manual", event_id: randomUUID(), event_type: "manual.confirmed" },
    event_type: "payment.approved",
    occurred_at: sale.occurred_at,
    order: {
      external_order_id: sale.external_order_id,
      external_transaction_id: `manual:${sale.external_order_id}`,
      currency: sale.currency,
      amount_minor: sale.amount_minor,
      payment_method: sale.payment_method,
      transaction_kind: "manual",
      is_test: input.isTest,
    },
    attribution: { utm_source: sale.utm_source ?? null, utm_medium: sale.utm_medium ?? null, utm_campaign: sale.utm_campaign ?? null },
  };
  const acct = await c.query(
    `insert into public.provider_accounts (organization_id, project_id, provider, external_account_id, display_name) values ($1, $2, 'manual', $3, 'Vendas manuais')
     on conflict (organization_id, provider, external_account_id) do update set display_name = excluded.display_name returning id`,
    [orgId, sale.project_id, `manual:${sale.project_id}`],
  );
  let conn = (await c.query("select id from public.provider_connections where organization_id = $1 and provider_account_id = $2 and provider = 'manual'", [orgId, acct.rows[0].id])).rows[0];
  if (!conn) {
    conn = (
      await c.query(
        "insert into public.provider_connections (organization_id, project_id, provider_account_id, provider, kind, name, status) values ($1, $2, $3, 'manual', 'custom', 'Vendas manuais', 'connected') returning id",
        [orgId, sale.project_id, acct.rows[0].id],
      )
    ).rows[0];
  }
  const raw = Buffer.from(JSON.stringify(canonical));
  const r = await c.query(
    `insert into public.webhook_receipts (organization_id, project_id, connection_id, provider, provider_account_id, dedup_key, dedup_method, source_event_type, body, body_sha256,
        content_type, headers, auth_method, is_demo, is_test)
     values ($1, $2, $3, 'manual', $4, $5, 'provider_event_id', 'manual.confirmed', $6, sha256($6), 'application/json', $7, $8, $9, $10)
     on conflict (organization_id, provider_account_id, dedup_key) do nothing returning id`,
    [orgId, sale.project_id, conn.id, acct.rows[0].id, `order:${sale.external_order_id}`, raw, JSON.stringify({ reference: sale.reference }), `${input.actor.type}:${input.actor.id}`, input.isDemo, input.isTest],
  );
  if (!r.rows[0]) return { duplicate: true };
  const receiptId = r.rows[0].id as string;
  await c.query("insert into public.outbox (organization_id, topic, payload, dedup_key, priority) values ($1, 'receipt.process', $2, $3, 1)", [
    orgId, JSON.stringify({ receipt_id: receiptId }), `receipt:${receiptId}`,
  ]);
  await audit(c, {
    organizationId: orgId,
    actorType: input.actor.type,
    actorId: input.actor.type === "user" ? input.actor.id : null,
    action: "order.manual_created",
    targetType: "receipt",
    targetId: receiptId,
    details: { external_order_id: sale.external_order_id, amount_minor: sale.amount_minor, currency: sale.currency, reference: sale.reference, ...(input.actor.type === "api_key" ? { api_key_id: input.actor.id } : {}), is_test: input.isTest },
    requestId: input.requestId,
  });
  return { receiptId };
}
