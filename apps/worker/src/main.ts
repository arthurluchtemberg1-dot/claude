import { createServer } from "node:http";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import pino from "pino";
import { createPool, requireEnv } from "@tracker/db";
import { dispatchOutboxItem, type WorkerDeps } from "./dispatch";
import { createSecretLoader } from "./secrets";
import { OUTBOX_QUEUE, relayOnce } from "./relay";

/**
 * Processo persistente do worker (R41-06): relay da outbox, consumidor BullMQ, health check e encerramento gracioso.
 * Não executar em função serverless de curta duração.
 */

const log = pino({ level: process.env.LOG_LEVEL ?? "info", base: { service: "tracker-worker" }, timestamp: pino.stdTimeFunctions.isoTime });
const system = createPool(requireEnv("DATABASE_URL_SYSTEM"), { max: Number(process.env.WORKER_DB_POOL ?? 10), applicationName: "tracker-worker" });
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
const queue = new Queue(OUTBOX_QUEUE, { connection });

const deps: WorkerDeps = {
  pools: { system },
  tokenHmacKey: Buffer.from(requireEnv("TOKEN_HMAC_SECRET"), "base64"),
  now: () => new Date(),
  log: (obj, msg) => log.info(obj, msg),
  delivery: {
    environment: process.env.APP_ENV === "production" ? "production" : "test",
    allowExternalDelivery: process.env.ALLOW_EXTERNAL_DELIVERY === "true",
    fetchImpl: fetch,
    loadSecret: createSecretLoader(),
  },
};

const worker = new Worker(
  OUTBOX_QUEUE,
  async (job) => {
    const { outbox_id, organization_id } = job.data as { outbox_id: number; organization_id: string };
    return dispatchOutboxItem(deps, organization_id, outbox_id);
  },
  { connection: connection.duplicate(), concurrency: Number(process.env.WORKER_CONCURRENCY ?? 8) },
);
worker.on("failed", (job, err) => log.error({ job: job?.id, err: err.message }, "job_failed"));

let relayTimer: NodeJS.Timeout | null = null;
let relayErrors = 0;
async function relayLoop() {
  const r = await relayOnce(system, queue);
  if (r.error) {
    relayErrors++;
    log.warn({ err: r.error, consecutive: relayErrors }, "outbox_relay_error");
  } else {
    relayErrors = 0;
    if (r.published) log.debug({ published: r.published }, "outbox_relayed");
  }
  relayTimer = setTimeout(relayLoop, Number(process.env.OUTBOX_RELAY_INTERVAL_MS ?? 500));
}
void relayLoop();

// Health/readiness para orquestradores.
const health = createServer(async (req, res) => {
  if (req.url === "/health") return res.writeHead(200).end("ok");
  if (req.url === "/ready") {
    try {
      await system.query("select 1");
      await connection.ping();
      res.writeHead(relayErrors > 10 ? 503 : 200, { "content-type": "application/json" }).end(JSON.stringify({ db: true, redis: true, relay_errors: relayErrors }));
    } catch (err) {
      res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }
  res.writeHead(404).end();
});
health.listen(Number(process.env.WORKER_HEALTH_PORT ?? 4100));

async function shutdown(signal: string) {
  log.info({ signal }, "worker_shutdown_start");
  if (relayTimer) clearTimeout(relayTimer);
  health.close();
  await worker.close(); // aguarda jobs em andamento
  await queue.close();
  await connection.quit();
  await system.end();
  log.info({}, "worker_shutdown_done");
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
log.info({ redis: redisUrl.replace(/\/\/.*@/, "//***@") }, "worker_started");
