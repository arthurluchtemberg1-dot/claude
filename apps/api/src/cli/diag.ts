/**
 * Diagnóstico operacional (R41-05, R42-01): conectividade com banco/Redis, migrações e fila (outbox) de todas as
 * organizações, sem dados pessoais. Uso: pnpm diag
 */
import pg from "pg";
import { migrationStatus } from "@tracker/db";

const adminUrl = process.env.DATABASE_URL_ADMIN;
const systemUrl = process.env.DATABASE_URL_SYSTEM;
if (!systemUrl) {
  console.error("DATABASE_URL_SYSTEM ausente (ver .env.example)");
  process.exit(2);
}
const out: Record<string, unknown> = {};
const c = new pg.Client({ connectionString: systemUrl });
try {
  await c.connect();
  out.database = "ok";
  const stats = await c.query("select status, total::int, oldest from app.outbox_stats()");
  out.outbox = stats.rows;
} catch (err) {
  out.database = `erro: ${(err as Error).message}`;
} finally {
  await c.end().catch(() => undefined);
}
if (adminUrl) {
  try {
    const m = await migrationStatus(adminUrl);
    out.migrations = { applied: m.filter((x) => x.applied).length, pending: m.filter((x) => !x.applied).map((x) => x.name) };
  } catch (err) {
    out.migrations = `erro: ${(err as Error).message}`;
  }
}
try {
  const { Redis } = await import("ioredis");
  const r = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", { maxRetriesPerRequest: 1, lazyConnect: true, enableOfflineQueue: false, retryStrategy: () => null });
  await r.connect();
  out.redis = (await r.ping()) === "PONG" ? "ok" : "sem resposta";
  const info = await r.info("persistence");
  out.redis_aof = /aof_enabled:1/.test(info) ? "habilitado" : "DESABILITADO (recomendado habilitar AOF)";
  r.disconnect();
} catch (err) {
  out.redis = `erro: ${(err as Error).message}`;
}
console.log(JSON.stringify(out, null, 2));
