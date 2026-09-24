import { withTx, type Pool, type PoolClient } from "@tracker/db";
import { computeAttribution } from "./handlers/attribution";
import { fanoutDestinations, sendDelivery, type DeliveryDeps } from "./handlers/deliveries";
import { processReceipt } from "./handlers/process-receipt";
import { deliverWebhook, emitWebhookEvent, type OutboundDeps, type OutboundEvent } from "./handlers/webhooks-out";

/**
 * Despacho de itens da outbox. A outbox é o registro durável do trabalho (R05-04): o Redis/BullMQ apenas
 * transporta o ID. Handlers internos rodam na MESMA transação que marca o item como concluído (efeito exatamente
 * uma vez no banco). Se o worker cair no meio, a transação é desfeita e o item volta a ser processado (T22).
 */

export interface WorkerDeps {
  pools: { system: Pool };
  tokenHmacKey: Buffer;
  delivery: DeliveryDeps;
  outbound: OutboundDeps;
  now: () => Date;
  log: (obj: Record<string, unknown>, msg: string) => void;
}

export type DispatchResult = "done" | "retry" | "dead" | "skipped";

function retryDelayMs(attempts: number): number {
  const base = Math.min(5_000 * 2 ** attempts, 30 * 60_000);
  return Math.round(base / 2 + Math.random() * (base / 2));
}

async function markFailure(pool: Pool, orgId: string, id: number, error: string) {
  await withTx(pool, { organizationId: orgId }, async (c) => {
    const r = await c.query("select attempts, max_attempts from public.outbox where id = $1 for update", [id]);
    const row = r.rows[0];
    if (!row) return;
    const attempts = row.attempts + 1;
    const dead = attempts >= row.max_attempts;
    await c.query(
      "update public.outbox set attempts = $2, status = $3, available_at = now() + make_interval(secs => $4), last_error = $5 where id = $1",
      [id, attempts, dead ? "dead" : "pending", retryDelayMs(attempts) / 1000, error.slice(0, 1000)],
    );
    if (dead) {
      // Recebimento cujo processamento esgotou tentativas fica visível como falha (fila de falhas).
      const item = (await c.query("select topic, payload from public.outbox where id = $1", [id])).rows[0];
      if (item?.topic === "receipt.process") {
        await c.query("update public.webhook_receipts set status = 'dead', status_reason = $2 where id = $1", [item.payload.receipt_id, error.slice(0, 500)]);
      }
    }
  });
}

export async function dispatchOutboxItem(deps: WorkerDeps, orgId: string, outboxId: number): Promise<DispatchResult> {
  const pool = deps.pools.system;
  try {
    const topic = await withTx(pool, { organizationId: orgId }, async (c) => {
      // Espera curta pelo lock: o relay publica no Redis antes de confirmar sua transação, então o job pode chegar
      // antes do commit. SKIP LOCKED aqui faria o job "concluir" sem processar o item (corrida detectada no E2E).
      await c.query("set local lock_timeout = '5s'");
      const r = await c.query("select id, topic, payload, status from public.outbox where id = $1 and organization_id = $2 for update", [outboxId, orgId]);
      const item = r.rows[0];
      if (!item) return { skip: true as const };
      if (item.status === "done" || item.status === "dead") return { skip: true as const };
      const now = deps.now();
      if (item.topic === "delivery.send" || item.topic === "webhooks.deliver") return { external: true as const, topic: item.topic as string, payload: item.payload };
      await runInternal(c, deps, orgId, item.topic, item.payload, now);
      await c.query("update public.outbox set status = 'done', completed_at = now(), last_error = null where id = $1", [outboxId]);
      return { done: true as const };
    });
    if ("skip" in topic) return "skipped";
    if ("done" in topic) return "done";
    // Efeito externo: fora da transação do item; o próprio envio registra tentativas e reagenda.
    const runTx = <T>(fn: (c: PoolClient) => Promise<T>) => withTx(pool, { organizationId: orgId }, fn);
    if (topic.topic === "webhooks.deliver") await deliverWebhook(runTx, deps.outbound, orgId, topic.payload.delivery_id, deps.now());
    else await sendDelivery(runTx, deps.delivery, orgId, topic.payload.delivery_id, deps.now());
    await withTx(pool, { organizationId: orgId }, (c) => c.query("update public.outbox set status = 'done', completed_at = now() where id = $1", [outboxId]));
    return "done";
  } catch (err) {
    const msg = (err as Error).message;
    deps.log({ outboxId, orgId, err: msg }, "outbox_item_failed");
    await markFailure(pool, orgId, outboxId, msg);
    return "retry";
  }
}

async function runInternal(c: PoolClient, deps: WorkerDeps, orgId: string, topic: string, payload: Record<string, string>, now: Date) {
  switch (topic) {
    case "receipt.process": {
      const r = await processReceipt(c, orgId, payload.receipt_id!, now);
      deps.log({ orgId, receipt: payload.receipt_id, status: r.status }, "receipt_processed");
      return;
    }
    case "attribution.compute":
      await computeAttribution(c, { tokenHmacKey: deps.tokenHmacKey }, orgId, payload.order_id!, now);
      return;
    case "destinations.fanout":
      await fanoutDestinations(c, { environment: deps.delivery.environment }, orgId, payload.order_id!, payload.transaction_key!, now);
      return;
    case "webhooks.emit":
      await emitWebhookEvent(c, orgId, payload as unknown as OutboundEvent, now);
      return;
    default:
      throw new Error(`Tópico desconhecido na outbox: ${topic}`);
  }
}

/**
 * Processa diretamente itens pendentes (sem Redis). Usado em testes e em modo de contingência;
 * em operação normal o relay entrega os IDs ao BullMQ.
 */
export async function drainOutbox(deps: WorkerDeps, opts: { maxRounds?: number } = {}): Promise<number> {
  let processed = 0;
  for (let round = 0; round < (opts.maxRounds ?? 20); round++) {
    const items = await withTx(deps.pools.system, null, async (c) => (await c.query("select id, organization_id from app.outbox_claim($1, $2)", [100, 3600])).rows);
    if (!items.length) break;
    for (const it of items) {
      const r = await dispatchOutboxItem(deps, it.organization_id, Number(it.id));
      if (r === "done") processed++;
    }
  }
  return processed;
}
