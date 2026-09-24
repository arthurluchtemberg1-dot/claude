import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Configuração de testes de integração: usa o banco TEST_DATABASE_NAME (padrão tracker_test)
 * no mesmo servidor das URLs do .env, nunca o banco de desenvolvimento.
 */
const root = join(import.meta.dirname, "..");
const envFile = join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

function toTestDb(url: string | undefined, name: string): string {
  if (!url) throw new Error(`URL de banco ausente para testes (${name}); configure .env (ver .env.example)`);
  const u = new URL(url);
  u.pathname = `/${process.env.TEST_DATABASE_NAME ?? "tracker_test"}`;
  return u.toString();
}

export const TEST_DB = {
  admin: toTestDb(process.env.DATABASE_URL_ADMIN, "DATABASE_URL_ADMIN"),
  app: toTestDb(process.env.DATABASE_URL_APP, "DATABASE_URL_APP"),
  system: toTestDb(process.env.DATABASE_URL_SYSTEM, "DATABASE_URL_SYSTEM"),
};

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
