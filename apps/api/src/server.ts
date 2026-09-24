import { createPool } from "@tracker/db";
import { buildApp } from "./app";
import { loadConfig } from "./lib/config";
import { createEmailSender } from "./lib/email";
import { createLogger } from "./lib/logger";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const pools = {
  app: createPool(config.DATABASE_URL_APP, { max: 20, applicationName: "tracker-api" }),
  system: createPool(config.DATABASE_URL_SYSTEM, { max: 10, applicationName: "tracker-api-system" }),
};
const email = createEmailSender(config.EMAIL_TRANSPORT, (o, m) => logger.info(o, m), config.NODE_ENV === "production", config.EMAIL_OUTBOX_DIR);
const app = await buildApp({ config, pools, logger, email, now: () => new Date() });

await app.listen({ port: config.API_PORT, host: "0.0.0.0" });
logger.info({ port: config.API_PORT, env: config.APP_ENV }, "api_started");

async function shutdown(signal: string) {
  logger.info({ signal }, "api_shutdown");
  await app.close(); // para de aceitar conexões e aguarda requisições em andamento
  await Promise.all([pools.app.end(), pools.system.end()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
