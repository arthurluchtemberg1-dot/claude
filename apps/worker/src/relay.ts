import type { Queue } from "bullmq";
import { withTx, type Pool } from "@tracker/db";

/**
 * Relay outbox → BullMQ. Reivindica itens pendentes com SKIP LOCKED, publica o ID no Redis e só então marca
 * "enqueued" na mesma transação. Se o Redis falhar, a transação é desfeita e os itens continuam pendentes (T23).
 * Itens "enqueued" antigos são republicados (jobId determinístico evita duplicata enquanto o job existir).
 */
export const OUTBOX_QUEUE = "tracker-outbox";

export interface RelayResult {
  published: number;
  error: string | null;
}

export async function relayOnce(pool: Pool, queue: Pick<Queue, "addBulk">, opts: { batch?: number; staleSeconds?: number } = {}): Promise<RelayResult> {
  try {
    const published = await withTx(pool, null, async (c) => {
      const r = await c.query("select id, organization_id, topic, priority, attempts from app.outbox_claim($1, $2)", [opts.batch ?? 200, opts.staleSeconds ?? 600]);
      if (!r.rows.length) return 0;
      const generation = Date.now().toString(36);
      await queue.addBulk(
        r.rows.map((row) => ({
          name: row.topic,
          data: { outbox_id: Number(row.id), organization_id: row.organization_id },
          opts: {
            // Um jobId por geração de enfileiramento: republicações de itens "enqueued" antigos (ex.: Redis perdeu o job)
            // não podem colidir com um job concluído de mesmo ID retido pelo BullMQ.
            jobId: `ob-${row.id}-${row.attempts}-${generation}`,
            priority: Math.max(1, Math.min(row.priority, 10)),
            removeOnComplete: { age: 3600, count: 10_000 },
            removeOnFail: { age: 24 * 3600 },
            attempts: 1,
          },
        })),
      );
      await c.query("select app.outbox_mark_enqueued($1)", [r.rows.map((row) => Number(row.id))]);
      return r.rows.length;
    });
    return { published, error: null };
  } catch (err) {
    return { published: 0, error: (err as Error).message };
  }
}
