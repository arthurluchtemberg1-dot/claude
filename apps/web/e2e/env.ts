import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../../..");
const envFile = join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

function toDb(url: string | undefined, db: string): string {
  if (!url) throw new Error("Configure .env (ver .env.example) antes do E2E");
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

const dbName = process.env.E2E_DATABASE_NAME ?? "tracker_e2e";
const apiPort = 4010;
const webPort = 3010;
const workerHealthPort = 4110;
const outbox = join(root, "apps/web/.e2e-outbox");

export const E2E = {
  root,
  apiPort,
  webPort,
  workerHealthPort,
  apiUrl: `http://127.0.0.1:${apiPort}`,
  webUrl: `http://localhost:${webPort}`,
  outbox,
  adminDb: toDb(process.env.DATABASE_URL_ADMIN, dbName),
  apiEnv: {
    ...(process.env as Record<string, string>),
    NODE_ENV: "test",
    APP_ENV: "e2e",
    API_PORT: String(apiPort),
    PUBLIC_API_URL: `http://127.0.0.1:${apiPort}`,
    NEXT_PUBLIC_APP_URL: `http://localhost:${webPort}`,
    CORS_ORIGINS: `http://localhost:${webPort}`,
    DATABASE_URL_APP: toDb(process.env.DATABASE_URL_APP, dbName),
    DATABASE_URL_SYSTEM: toDb(process.env.DATABASE_URL_SYSTEM, dbName),
    EMAIL_TRANSPORT: "file",
    EMAIL_OUTBOX_DIR: outbox,
    LOG_LEVEL: "warn",
    MFA_REQUIRED_DEFAULT: "false",
    ALLOW_EXTERNAL_DELIVERY: "false",
  } as Record<string, string>,
  workerEnv: {
    ...(process.env as Record<string, string>),
    APP_ENV: "e2e",
    DATABASE_URL_SYSTEM: toDb(process.env.DATABASE_URL_SYSTEM, dbName),
    REDIS_URL: process.env.E2E_REDIS_URL ?? "redis://127.0.0.1:6379/5",
    WORKER_HEALTH_PORT: String(workerHealthPort),
    OUTBOX_RELAY_INTERVAL_MS: "200",
    LOG_LEVEL: "warn",
    ALLOW_EXTERNAL_DELIVERY: "false",
  } as Record<string, string>,
};
