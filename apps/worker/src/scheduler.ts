import { withTx, type Pool } from "@tracker/db";
import { scheduleTicks } from "./handlers/monitors";

/**
 * Ciclo do agendador (monitores e, depois, regras): enfileira trabalho periódico por organização via outbox.
 * Várias réplicas podem rodar ao mesmo tempo — a deduplicação por janela evita ciclos repetidos.
 */
export async function schedulerOnce(pool: Pool, now: Date): Promise<number> {
  return withTx(pool, null, async (c) => {
    const ids = (await c.query("select id from app.scheduler_org_ids()")).rows.map((r) => r.id as string);
    return scheduleTicks(c, ids, now);
  });
}
