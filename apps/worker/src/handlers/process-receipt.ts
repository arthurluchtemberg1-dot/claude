import { inSequence } from "@tracker/db";
import { createHash } from "node:crypto";
import { CHECKOUT_CONNECTORS, canonicalConnector, type DeclaredTracking, type NormalizedOrderEvent } from "@tracker/connectors";
import type { PoolClient } from "@tracker/db";
import {
  applyFinancialEvent,
  deriveOrderStatus,
  orderTotals,
  type LedgerEntry,
  type OrderAggregateState,
  type OrderConflict,
  type ReversalState,
  type TransactionState,
} from "@tracker/domain";

/**
 * Processamento de um recebimento (R09-07..R09-10). Executado pelo worker numa transação com contexto
 * de organização. Idempotente: reprocessar o mesmo recebimento não altera finanças (T02, T22).
 * Efeitos externos só por outbox, e somente para transações aprovadas pela primeira vez.
 */

export type ReceiptOutcome =
  | { status: "processed"; orderIds: string[]; newlyApproved: number }
  | { status: "quarantined" | "ignored"; reason: string }
  | { status: "skipped"; reason: string };

function connectorFor(provider: string) {
  if (provider === "manual") return canonicalConnector;
  return CHECKOUT_CONNECTORS[provider];
}

export async function loadOrderState(c: PoolClient, orgId: string, orderId: string): Promise<OrderAggregateState> {
  const [tx, rv, it, ord] = await inSequence([
    () => c.query("select * from public.payment_transactions where organization_id = $1 and order_id = $2", [orgId, orderId]),
    () => c.query("select * from public.reversals where organization_id = $1 and order_id = $2", [orgId, orderId]),
    () => c.query("select * from public.order_items where organization_id = $1 and order_id = $2", [orgId, orderId]),
    () => c.query("select currency from public.orders where id = $1", [orderId]),
  ] as const);
  const transactions: Record<string, TransactionState> = {};
  for (const t of tx.rows) {
    transactions[t.transaction_key] = {
      key: t.transaction_key,
      kind: t.kind,
      status: t.status,
      amountMinor: t.amount_minor,
      currency: t.currency,
      method: t.method,
      approvedAt: t.approved_at,
      statusOccurredAt: t.status_occurred_at,
      reversedNetMinor: t.reversed_net_minor,
      refundReportedTotalMinor: t.refund_reported_total_minor,
      orgShareMinor: t.org_share_minor,
      feeMinor: t.fee_minor,
      installments: t.installments,
    };
  }
  const reversals: Record<string, ReversalState> = {};
  for (const r of rv.rows) {
    reversals[r.reversal_key] = {
      key: r.reversal_key,
      kind: r.kind,
      transactionKey: r.transaction_key,
      semantics: r.semantics,
      reportedAmountMinor: r.reported_amount_minor,
      occurredAt: r.occurred_at,
      ...(r.related_key ? { relatedKey: r.related_key } : {}),
      status: r.status,
      effectiveMinor: r.effective_minor,
      restoredMinor: r.restored_minor,
    };
  }
  const items: OrderAggregateState["items"] = {};
  for (const i of it.rows) {
    (items as Record<string, unknown>)[i.item_key] = {
      key: i.item_key,
      externalProductId: i.external_product_id,
      name: i.name,
      itemType: i.item_type,
      unitAmountMinor: i.unit_amount_minor,
      quantity: i.quantity,
      currency: i.currency,
    };
  }
  return { currency: ord.rows[0]?.currency?.trim() ?? null, transactions, reversals, items };
}

async function persistState(c: PoolClient, orgId: string, orderId: string, providerAccountId: string, state: OrderAggregateState) {
  for (const t of Object.values(state.transactions)) {
    await c.query(
      `insert into public.payment_transactions (organization_id, order_id, provider_account_id, transaction_key, kind, status, amount_minor, currency, method,
          approved_at, status_occurred_at, reversed_net_minor, refund_reported_total_minor, org_share_minor, fee_minor, installments)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       on conflict (organization_id, order_id, transaction_key) do update set
         kind = excluded.kind, status = excluded.status, amount_minor = excluded.amount_minor, method = excluded.method, approved_at = excluded.approved_at,
         status_occurred_at = excluded.status_occurred_at, reversed_net_minor = excluded.reversed_net_minor,
         refund_reported_total_minor = excluded.refund_reported_total_minor, org_share_minor = excluded.org_share_minor, fee_minor = excluded.fee_minor,
         installments = excluded.installments, updated_at = now()`,
      [orgId, orderId, providerAccountId, t.key, t.kind, t.status, t.amountMinor, t.currency, t.method, t.approvedAt, t.statusOccurredAt, t.reversedNetMinor, t.refundReportedTotalMinor, t.orgShareMinor, t.feeMinor, t.installments],
    );
  }
  for (const r of Object.values(state.reversals)) {
    await c.query(
      `insert into public.reversals (organization_id, order_id, reversal_key, kind, transaction_key, semantics, reported_amount_minor, occurred_at, related_key, status, effective_minor, restored_minor)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (organization_id, order_id, reversal_key) do update set
         transaction_key = excluded.transaction_key, status = excluded.status, effective_minor = excluded.effective_minor, restored_minor = excluded.restored_minor, updated_at = now()`,
      [orgId, orderId, r.key, r.kind, r.transactionKey, r.semantics, r.reportedAmountMinor, r.occurredAt, r.relatedKey ?? null, r.status, r.effectiveMinor, r.restoredMinor],
    );
  }
  for (const i of Object.values(state.items)) {
    await c.query(
      `insert into public.order_items (organization_id, order_id, item_key, external_product_id, name, item_type, unit_amount_minor, quantity, currency)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (organization_id, order_id, item_key) do update set name = excluded.name, item_type = excluded.item_type,
         unit_amount_minor = excluded.unit_amount_minor, quantity = excluded.quantity, updated_at = now()`,
      [orgId, orderId, i.key, i.externalProductId, i.name, i.itemType, i.unitAmountMinor, i.quantity, i.currency],
    );
  }
}

/** Produto interno por (conta do provedor, ID externo): nunca unifica por nome (R24-03). */
async function ensureProducts(c: PoolClient, orgId: string, projectId: string, providerAccountId: string, orderId: string, state: OrderAggregateState) {
  for (const i of Object.values(state.items)) {
    const existing = await c.query(
      "select product_id from public.product_external_ids where organization_id = $1 and provider_account_id = $2 and external_product_id = $3",
      [orgId, providerAccountId, i.externalProductId],
    );
    let productId = existing.rows[0]?.product_id as string | undefined;
    if (!productId) {
      const p = await c.query(
        "insert into public.products (organization_id, project_id, name, reference_price_minor, currency) values ($1, $2, $3, $4, $5) returning id",
        [orgId, projectId, (i.name ?? `Produto ${i.externalProductId}`).slice(0, 200), i.unitAmountMinor, i.currency],
      );
      productId = p.rows[0].id as string;
      const ins = await c.query(
        `insert into public.product_external_ids (organization_id, product_id, provider_account_id, external_product_id, external_name)
         values ($1, $2, $3, $4, $5) on conflict (organization_id, provider_account_id, external_product_id) do nothing returning product_id`,
        [orgId, productId, providerAccountId, i.externalProductId, i.name],
      );
      if (!ins.rows[0]) {
        await c.query("delete from public.products where id = $1", [productId]);
        productId = (await c.query("select product_id from public.product_external_ids where organization_id = $1 and provider_account_id = $2 and external_product_id = $3", [orgId, providerAccountId, i.externalProductId])).rows[0].product_id;
      }
    }
    await c.query("update public.order_items set product_id = $3 where organization_id = $1 and order_id = $2 and item_key = $4 and product_id is null", [orgId, orderId, productId, i.key]);
  }
}

/**
 * Vínculo de upsell/downsell (R10-06, R10-07, T16). Só a declaração explícita da origem (parent_order_id) cria o vínculo,
 * e somente com pedido da mesma conta lógica do provedor e do mesmo projeto — nunca por e-mail ou similaridade.
 * O pedido original pode chegar depois: o ID externo fica guardado e o vínculo é resolvido na chegada dele.
 */
async function linkParentOrders(
  c: PoolClient,
  orgId: string,
  order: { id: string; project_id: string; provider_account_id: string; external_order_id: string; parent_external_order_id: string | null; parent_order_id: string | null },
  declaredParent: string | null,
  receiptId: string,
) {
  if (declaredParent && order.parent_external_order_id && order.parent_external_order_id !== declaredParent) {
    await c.query(
      "insert into public.order_conflicts (organization_id, order_id, code, message, receipt_id) values ($1, $2, 'parent_mismatch', $3, $4)",
      [orgId, order.id, `Pedido original declarado (${declaredParent.slice(0, 60)}) difere do já registrado; vínculo original preservado.`, receiptId],
    );
  }
  if (!order.parent_order_id && order.parent_external_order_id) {
    await c.query(
      `update public.orders o set parent_order_id = p.id
         from public.orders p
        where o.id = $2 and p.organization_id = $1 and p.provider_account_id = o.provider_account_id and p.project_id = o.project_id
          and p.external_order_id = o.parent_external_order_id and p.id <> o.id`,
      [orgId, order.id],
    );
  }
  // Upsells que chegaram antes deste pedido original.
  const children = await c.query(
    `update public.orders set parent_order_id = $2
      where organization_id = $1 and provider_account_id = $3 and project_id = $4 and parent_external_order_id = $5 and parent_order_id is null and id <> $2
      returning id, first_approved_at`,
    [orgId, order.id, order.provider_account_id, order.project_id, order.external_order_id],
  );
  for (const ch of children.rows) {
    if (!ch.first_approved_at) continue;
    await c.query(
      "insert into public.outbox (organization_id, topic, payload, dedup_key, priority) values ($1, 'attribution.compute', $2, $3, 3) on conflict do nothing",
      [orgId, JSON.stringify({ order_id: ch.id }), `attr:${ch.id}:parent:${order.id}`],
    );
  }
}

/** Remove o token do rastreador de campos UTM declarados (o token completo não é exibido nem exportado, R15-08). */
function maskTokenInUtm(d: DeclaredTracking): DeclaredTracking {
  const token = d.trackingToken;
  if (!token) return d;
  const m = (v: string | null) => (typeof v === "string" ? v.split(token).join("[token]") : v);
  return { ...d, utm: { source: m(d.utm.source), medium: m(d.utm.medium), campaign: m(d.utm.campaign), content: m(d.utm.content), term: m(d.utm.term) } };
}

function sanitizedCanonical(ev: NormalizedOrderEvent) {
  return {
    schema_version: ev.schemaVersion,
    event_type: ev.eventType,
    source_event_type: ev.sourceEventType,
    occurred_at: ev.occurredAt.toISOString(),
    external_order_id: ev.externalOrderId,
    parent_external_order_id: ev.parentExternalOrderId,
    is_test: ev.isTest,
    financial: ev.financial.map((f) => JSON.parse(JSON.stringify(f, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))),
    settlements: (ev.settlements ?? []).map((st) => JSON.parse(JSON.stringify(st, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))),
    declared_tracking: ev.declaredTracking
      ? { ...maskTokenInUtm(ev.declaredTracking), trackingToken: ev.declaredTracking.trackingToken ? `…${ev.declaredTracking.trackingToken.slice(-4)}` : null }
      : null,
    has_contact: !!ev.contact,
    notes: ev.notes,
  };
}

export async function processReceipt(c: PoolClient, orgId: string, receiptId: string, now: Date): Promise<ReceiptOutcome> {
  const rec = (await c.query("select * from public.webhook_receipts where organization_id = $1 and id = $2 for update", [orgId, receiptId])).rows[0];
  if (!rec) return { status: "skipped", reason: "Recebimento não encontrado nesta organização" };
  if (rec.status === "processed" || rec.status === "quarantined" || rec.status === "ignored") return { status: "skipped", reason: `Já ${rec.status}` };
  const conn = (
    await c.query(
      `select c.id, c.project_id, c.provider, c.environment, c.config, c.disabled_at, a.revenue_role
         from public.provider_connections c join public.provider_accounts a on a.id = c.provider_account_id
        where c.organization_id = $1 and c.id = $2`,
      [orgId, rec.connection_id],
    )
  ).rows[0];
  // Validação explícita de organização/conexão/projeto em toda execução (R07-14).
  if (!conn || conn.project_id !== rec.project_id) return { status: "skipped", reason: "Conexão inexistente ou de outro projeto" };
  const connector = connectorFor(conn.provider);
  if (!connector) return { status: "skipped", reason: `Sem conector para ${conn.provider}` };

  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(rec.body).toString("utf8"));
  } catch {
    await c.query("update public.webhook_receipts set status = 'quarantined', status_reason = 'JSON inválido', processed_at = $2 where id = $1", [receiptId, now]);
    return { status: "quarantined", reason: "JSON inválido" };
  }
  const result = connector.normalize(body, { config: conn.config ?? {}, receivedAt: rec.received_at, connectionEnvironment: conn.environment });
  if (result.status !== "ok") {
    await c.query("update public.webhook_receipts set status = $2, status_reason = $3, processed_at = $4, attempts = attempts + 1 where id = $1", [
      receiptId,
      result.status === "quarantine" ? "quarantined" : "ignored",
      result.reason.slice(0, 500),
      now,
    ]);
    return { status: result.status === "quarantine" ? "quarantined" : "ignored", reason: result.reason };
  }

  const orderIds: string[] = [];
  let newlyApprovedCount = 0;
  for (const [seq, ev] of result.events.entries()) {
    const o = await c.query(
      `insert into public.orders (organization_id, project_id, provider, provider_account_id, external_order_id, is_test, is_demo, source_first_occurred_at, source_updated_at,
          first_received_at, parent_external_order_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10)
       on conflict (organization_id, provider_account_id, external_order_id) do update set updated_at = now(),
         parent_external_order_id = coalesce(public.orders.parent_external_order_id, excluded.parent_external_order_id)
       returning id, project_id, provider_account_id, external_order_id, parent_external_order_id, parent_order_id, declared_tracking, source_first_occurred_at, source_updated_at, currency`,
      [orgId, rec.project_id, conn.provider, rec.provider_account_id, ev.externalOrderId, ev.isTest || rec.is_test, rec.is_demo, ev.occurredAt, rec.received_at, ev.parentExternalOrderId],
    );
    const order = o.rows[0];
    const orderId = order.id as string;
    orderIds.push(orderId);
    // Lock do pedido: eventos concorrentes do mesmo pedido são serializados (T03, T22).
    await c.query("select id from public.orders where id = $1 for update", [orderId]);
    await linkParentOrders(c, orgId, order, ev.parentExternalOrderId, receiptId);

    let state = await loadOrderState(c, orgId, orderId);
    const ledger: LedgerEntry[] = [];
    const conflicts: OrderConflict[] = [];
    const newlyApproved: string[] = [];
    for (const fe of ev.financial) {
      const r = applyFinancialEvent(state, fe);
      state = r.state;
      ledger.push(...r.ledger);
      conflicts.push(...r.conflicts);
      newlyApproved.push(...r.newlyApproved);
    }
    await persistState(c, orgId, orderId, rec.provider_account_id, state);
    await ensureProducts(c, orgId, rec.project_id, rec.provider_account_id, orderId, state);
    for (const l of ledger) {
      await c.query(
        `insert into public.financial_entries (organization_id, project_id, order_id, semantic_key, entry_type, transaction_key, amount_minor, currency, occurred_at,
            revenue_kind, reversal_key, estimated, source_receipt_id, is_test, is_demo)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         on conflict (organization_id, order_id, semantic_key) do nothing`,
        [orgId, rec.project_id, orderId, l.semanticKey, l.type, l.transactionKey, l.amountMinor, l.currency, l.occurredAt, l.revenueKind, l.reversalKey ?? null, !!l.estimated, receiptId, ev.isTest || rec.is_test, rec.is_demo],
      );
    }
    for (const cf of conflicts) {
      await c.query("insert into public.order_conflicts (organization_id, order_id, code, message, transaction_key, reversal_key, receipt_id) values ($1,$2,$3,$4,$5,$6,$7)", [
        orgId, orderId, cf.code, cf.message, cf.transactionKey ?? null, cf.reversalKey ?? null, receiptId,
      ]);
    }
    // Recebíveis/liquidações: registro próprio, sem lançamento de receita nem gatilho de conversão (T18).
    for (const st of ev.settlements ?? []) {
      await c.query(
        `insert into public.settlements (organization_id, project_id, order_id, provider_account_id, settlement_key, stage, transaction_key, installment_number,
            installment_count, gross_minor, fee_minor, net_minor, currency, anticipated, expected_at, occurred_at, source_receipt_id, is_test, is_demo)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         on conflict (organization_id, provider_account_id, settlement_key, stage) do nothing`,
        [
          orgId, rec.project_id, orderId, rec.provider_account_id, st.settlementKey, st.stage, st.transactionKey, st.installmentNumber, st.installmentCount,
          st.grossMinor, st.feeMinor, st.netMinor, st.currency, st.anticipated, st.expectedAt, st.occurredAt, receiptId, ev.isTest || rec.is_test, rec.is_demo,
        ],
      );
    }
    const totals = orderTotals(state);
    const status = deriveOrderStatus(state);
    const incoming = ev.declaredTracking ? maskTokenInUtm(ev.declaredTracking) : {};
    const declared = order.declared_tracking && Object.keys(order.declared_tracking).length ? order.declared_tracking : incoming;
    if (ev.declaredTracking?.trackingToken && !declared.trackingToken) declared.trackingToken = ev.declaredTracking.trackingToken;
    await c.query(
      `update public.orders set currency = $2, financial_status = $3, approved_minor = $4, reversed_minor = $5, first_approved_at = $6,
         payment_method = coalesce($7, payment_method), declared_tracking = $8,
         source_first_occurred_at = least(source_first_occurred_at, $9), source_updated_at = greatest(source_updated_at, $9), processed_at = $10
       where id = $1`,
      [orderId, state.currency, status, totals.approvedMinor, totals.reversedNetMinor, totals.firstApprovedAt, ev.paymentMethod, JSON.stringify(declared), ev.occurredAt, now],
    );
    if (ev.contact && (ev.contact.email || ev.contact.phone || ev.contact.name)) {
      const email = ev.contact.email?.trim().toLowerCase() ?? null;
      await c.query(
        `insert into public.order_contacts (organization_id, order_id, email, email_sha256, phone, name, source, retention_until)
         values ($1, $2, $3, $4, $5, $6, 'checkout_webhook', now() + interval '730 days')
         on conflict (organization_id, order_id) do update set email = coalesce(excluded.email, public.order_contacts.email),
           email_sha256 = coalesce(excluded.email_sha256, public.order_contacts.email_sha256), phone = coalesce(excluded.phone, public.order_contacts.phone),
           name = coalesce(excluded.name, public.order_contacts.name), updated_at = now()`,
        [orgId, orderId, email, email ? createHash("sha256").update(email).digest("hex") : null, ev.contact.phone, ev.contact.name],
      );
    }
    await c.query(
      `insert into public.normalized_events (organization_id, project_id, receipt_id, seq, schema_version, event_type, occurred_at, order_id, payload)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (organization_id, receipt_id, seq) do nothing`,
      [orgId, rec.project_id, receiptId, seq, ev.schemaVersion, ev.eventType, ev.occurredAt, orderId, JSON.stringify(sanitizedCanonical(ev))],
    );
    // Efeitos derivados via outbox (sem duplicar: dedup por chave semântica).
    if (totals.firstApprovedAt) {
      await c.query(
        "insert into public.outbox (organization_id, topic, payload, dedup_key, priority) values ($1, 'attribution.compute', $2, $3, 3) on conflict do nothing",
        [orgId, JSON.stringify({ order_id: orderId }), `attr:${orderId}:${totals.firstApprovedAt.toISOString()}`],
      );
    }
    for (const txKey of newlyApproved) {
      newlyApprovedCount++;
      await c.query(
        "insert into public.outbox (organization_id, topic, payload, dedup_key, priority) values ($1, 'destinations.fanout', $2, $3, 4) on conflict do nothing",
        [orgId, JSON.stringify({ order_id: orderId, transaction_key: txKey }), `fanout:${orderId}:${txKey}`],
      );
    }
  }
  await c.query("update public.webhook_receipts set status = 'processed', status_reason = null, processed_at = $2, attempts = attempts + 1 where id = $1", [receiptId, now]);
  await c.query(
    "update public.provider_connections set status = case when status in ('awaiting_configuration', 'temporary_failure') then 'connected' else status end, last_success_at = $2 where id = $1",
    [rec.connection_id, now],
  );
  return { status: "processed", orderIds, newlyApproved: newlyApprovedCount };
}
