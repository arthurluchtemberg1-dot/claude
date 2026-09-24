import { MAX_FORWARD_HOPS, postSignedWebhook, type SafeHttpPolicy } from "@tracker/connectors";
import type { PoolClient } from "@tracker/db";

/**
 * Webhooks de saída (R33-05..R33-07):
 * - emissão só para assinaturas ATIVAS (verificadas por teste assinado) interessadas no evento;
 * - uma entrega por (assinatura, evento) — ID estável entre tentativas para o receptor deduplicar;
 * - envio fora da transação do banco, com política anti-SSRF validada na conexão e a cada redirecionamento;
 * - backoff com jitter, limite de tentativas e fila de falhas ("dead") com reenvio manual;
 * - proveniência (recebimento de origem) e contador de saltos para impedir loops entre entradas e saídas.
 * Payload sem dados pessoais: IDs, valores, status e atribuição.
 */

export const OUTBOUND_API_VERSION = "2026-09-24";

export interface OutboundDeps {
  policy: SafeHttpPolicy;
  loadSecrets: (c: PoolClient, orgId: string, subscriptionId: string) => Promise<string[]>;
  maxAttempts?: number;
}

export interface OutboundEvent {
  type: "order.approved" | "order.reversed" | "order.status_changed";
  eventId: string;
  orderId: string;
  transactionKey?: string;
  ledgerKey?: string;
  fromStatus?: string;
  toStatus?: string;
  receiptId: string | null;
  hop: number;
}

/** Enfileira a emissão (mesma transação do fato que a origina) somente se houver assinatura ativa interessada. */
export async function queueWebhookEvent(c: PoolClient, orgId: string, ev: OutboundEvent): Promise<"queued" | "no_subscribers" | "hop_limit"> {
  if (ev.hop > MAX_FORWARD_HOPS) return "hop_limit";
  const any = await c.query("select 1 from public.webhook_subscriptions where organization_id = $1 and status = 'active' and $2 = any(events) limit 1", [orgId, ev.type]);
  if (!any.rows[0]) return "no_subscribers";
  await c.query("insert into public.outbox (organization_id, topic, payload, dedup_key, priority) values ($1, 'webhooks.emit', $2, $3, 6) on conflict do nothing", [
    orgId, JSON.stringify(ev), `whe:${ev.eventId}`,
  ]);
  return "queued";
}

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

async function buildPayload(c: PoolClient, orgId: string, ev: OutboundEvent, now: Date) {
  const o = (
    await c.query(
      `select id, project_id, provider, external_order_id, parent_order_id, financial_status, currency, approved_minor, reversed_minor, first_approved_at, is_test, is_demo
         from public.orders where organization_id = $1 and id = $2`,
      [orgId, ev.orderId],
    )
  ).rows[0];
  if (!o) return null;
  const tx = ev.transactionKey
    ? (await c.query("select transaction_key, kind, status, amount_minor, currency, method, installments, approved_at from public.payment_transactions where organization_id = $1 and order_id = $2 and transaction_key = $3", [orgId, ev.orderId, ev.transactionKey])).rows[0]
    : null;
  const entry = ev.ledgerKey
    ? (await c.query("select semantic_key, entry_type, transaction_key, reversal_key, amount_minor, currency, occurred_at from public.financial_entries where organization_id = $1 and order_id = $2 and semantic_key = $3", [orgId, ev.orderId, ev.ledgerKey])).rows[0]
    : null;
  const attr = (
    await c.query(
      `select policy_key, policy_version, model, category, evidence, quality, network, campaign_id, adset_id, ad_id, utm_source, utm_campaign, computed_at
         from public.order_attributions where organization_id = $1 and order_id = $2 and is_current and policy_key = 'default'`,
      [orgId, ev.orderId],
    )
  ).rows[0];
  return {
    order: o,
    payload: {
      id: ev.eventId,
      type: ev.type,
      created_at: now.toISOString(),
      api_version: OUTBOUND_API_VERSION,
      data: {
        order: {
          id: o.id,
          project_id: o.project_id,
          provider: o.provider,
          external_order_id: o.external_order_id,
          parent_order_id: o.parent_order_id,
          status: o.financial_status,
          currency: str(o.currency)?.trim() ?? null,
          approved_minor: str(o.approved_minor),
          reversed_minor: str(o.reversed_minor),
          first_approved_at: o.first_approved_at,
          is_test: o.is_test,
        },
        ...(tx
          ? { transaction: { key: tx.transaction_key, kind: tx.kind, status: tx.status, amount_minor: str(tx.amount_minor), currency: str(tx.currency)?.trim(), method: tx.method, installments: tx.installments, approved_at: tx.approved_at } }
          : {}),
        ...(entry ? { reversal: { key: entry.reversal_key, type: entry.entry_type, amount_minor: str(-BigInt(entry.amount_minor)), currency: str(entry.currency)?.trim(), occurred_at: entry.occurred_at } } : {}),
        ...(ev.fromStatus ? { status_change: { from: ev.fromStatus, to: ev.toStatus } } : {}),
        // Pode ser null se a atribuição ainda não foi calculada; consulte GET /public/v1/orders/{id}.
        attribution: attr ? { ...attr, computed_at: attr.computed_at } : null,
      },
      provenance: { source: o.provider === "manual" ? "manual" : "checkout_webhook", provider: o.provider, receipt_id: ev.receiptId, hop: ev.hop },
    },
  };
}

/** Cria as entregas por assinatura (transação interna do item da outbox). */
export async function emitWebhookEvent(c: PoolClient, orgId: string, ev: OutboundEvent, now: Date): Promise<{ created: number }> {
  const built = await buildPayload(c, orgId, ev, now);
  if (!built) return { created: 0 };
  // Demonstração nunca sai do sistema (T68).
  if (built.order.is_demo) return { created: 0 };
  const subs = (
    await c.query("select id, project_ids, include_test from public.webhook_subscriptions where organization_id = $1 and status = 'active' and $2 = any(events)", [orgId, ev.type])
  ).rows;
  let created = 0;
  for (const s of subs) {
    if (s.project_ids.length && !s.project_ids.includes(built.order.project_id)) continue;
    if (built.order.is_test && !s.include_test) continue;
    const r = await c.query(
      `insert into public.webhook_out_deliveries (organization_id, subscription_id, event_id, event_type, payload, hop) values ($1, $2, $3, $4, $5, $6)
       on conflict (organization_id, subscription_id, event_id) do nothing returning id`,
      [orgId, s.id, ev.eventId, ev.type, JSON.stringify(built.payload), ev.hop],
    );
    if (!r.rows[0]) continue;
    created++;
    await c.query("insert into public.outbox (organization_id, topic, payload, dedup_key, priority) values ($1, 'webhooks.deliver', $2, $3, 7) on conflict do nothing", [
      orgId, JSON.stringify({ delivery_id: r.rows[0].id }), `whd:${r.rows[0].id}:1`,
    ]);
  }
  return { created };
}

const BACKOFF_S = [60, 300, 1800, 7200, 21600, 43200, 86400];
export function outboundBackoffMs(attempt: number): number {
  const base = (BACKOFF_S[Math.min(attempt - 1, BACKOFF_S.length - 1)] ?? 86400) * 1000;
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

export async function deliverWebhook(
  runTx: <T>(fn: (c: PoolClient) => Promise<T>) => Promise<T>,
  deps: OutboundDeps,
  orgId: string,
  deliveryId: string,
  now: Date,
): Promise<{ status: string; reschedule?: Date }> {
  const maxAttempts = deps.maxAttempts ?? 8;
  const prep = await runTx(async (c) => {
    const d = (
      await c.query(
        `select d.*, s.url, s.status as sub_status from public.webhook_out_deliveries d join public.webhook_subscriptions s on s.id = d.subscription_id
          where d.organization_id = $1 and d.id = $2 for update of d`,
        [orgId, deliveryId],
      )
    ).rows[0];
    if (!d) return { skip: "not_found" };
    if (d.status !== "pending" && d.status !== "retry_scheduled") return { skip: d.status };
    if (d.sub_status !== "active") {
      await c.query("update public.webhook_out_deliveries set status = 'skipped', last_error = 'Assinatura pausada ou desativada antes do envio' where id = $1", [deliveryId]);
      return { skip: "subscription_inactive" };
    }
    const secrets = await deps.loadSecrets(c, orgId, d.subscription_id);
    if (!secrets.length) {
      await c.query("update public.webhook_out_deliveries set status = 'skipped', last_error = 'Segredo de assinatura ausente' where id = $1", [deliveryId]);
      return { skip: "no_secret" };
    }
    const attempt = d.attempts + 1;
    await c.query("update public.webhook_out_deliveries set attempts = $2 where id = $1", [deliveryId, attempt]);
    return { d, secrets, attempt };
  });
  if ("skip" in prep) return { status: `skipped:${prep.skip}` };
  const { d, secrets, attempt } = prep;
  const res = await postSignedWebhook(deps.policy, { url: d.url, deliveryId, eventType: d.event_type, hop: d.hop, payload: d.payload, secrets }, now);

  return runTx(async (c) => {
    const success = res.ok && res.status >= 200 && res.status < 300;
    const blocked = !res.ok && res.error === "blocked";
    let status: string;
    let next: Date | null = null;
    if (success) status = "succeeded";
    else if (blocked) status = "blocked";
    else if (attempt >= maxAttempts) status = "dead";
    else {
      status = "retry_scheduled";
      next = new Date(now.getTime() + outboundBackoffMs(attempt));
    }
    const error = success ? null : res.ok ? `HTTP ${res.status}` : `${res.error}: ${res.message}`;
    await c.query(
      `update public.webhook_out_deliveries set status = $2, next_attempt_at = $3, last_http_status = $4, last_error = $5, last_latency_ms = $6,
         delivered_at = case when $2 = 'succeeded' then now() else delivered_at end where id = $1`,
      [deliveryId, status, next, res.ok ? res.status : res.status, error?.slice(0, 500) ?? null, res.latencyMs],
    );
    await c.query(
      success
        ? "update public.webhook_subscriptions set consecutive_failures = 0, last_success_at = $2, last_error = null where id = $1"
        : "update public.webhook_subscriptions set consecutive_failures = consecutive_failures + 1, last_failure_at = $2, last_error = $3 where id = $1",
      success ? [d.subscription_id, now] : [d.subscription_id, now, error?.slice(0, 500)],
    );
    if (next) {
      await c.query("insert into public.outbox (organization_id, topic, payload, dedup_key, priority, available_at) values ($1, 'webhooks.deliver', $2, $3, 7, $4) on conflict do nothing", [
        orgId, JSON.stringify({ delivery_id: deliveryId }), `whd:${deliveryId}:${attempt + 1}`, next,
      ]);
    }
    return { status, ...(next ? { reschedule: next } : {}) };
  });
}
