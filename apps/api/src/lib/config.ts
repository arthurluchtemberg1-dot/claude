import { outboundPolicyFromEnv, type SafeHttpPolicy } from "@tracker/connectors";
import { z } from "zod";

/**
 * Configuração validada na inicialização (R41-01). Valores ausentes/obrigatórios geram erro explicativo,
 * sem imprimir segredos.
 */

const base64Key = z
  .string()
  .refine((v) => Buffer.from(v, "base64").length >= 32, "deve ser base64 de pelo menos 32 bytes");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  APP_ENV: z.string().min(1).default("local"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  PUBLIC_API_URL: z.string().url().default("http://localhost:4000"),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  DATABASE_URL_APP: z.string().min(1),
  DATABASE_URL_SYSTEM: z.string().min(1),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  CREDENTIALS_KEYS: z.string().min(1),
  CREDENTIALS_KEY_CURRENT: z.coerce.number().int().positive(),
  TOKEN_HMAC_SECRET: base64Key,
  SESSION_COOKIE_NAME: z.string().default("trk_session"),
  SESSION_COOKIE_SECURE: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().max(24 * 90).default(336),
  EMAIL_TRANSPORT: z.enum(["log", "memory", "file", "smtp"]).default("log"),
  EMAIL_OUTBOX_DIR: z.string().optional(),
  EMAIL_FROM: z.string().default("Tracker <no-reply@example.com>"),
  SMTP_URL: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  META_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v24.0"),
  ALLOW_EXTERNAL_DELIVERY: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  // API pública: limites por minuto (chave e organização), compartilhados entre instâncias via banco.
  API_RATE_LIMIT_PER_KEY: z.coerce.number().int().positive().default(120),
  API_RATE_LIMIT_PER_ORG: z.coerce.number().int().positive().default(600),
  MFA_REQUIRED_DEFAULT: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
});

export type AppConfig = z.infer<typeof schema> & {
  credentialKeys: Map<number, Buffer>;
  corsOrigins: string[];
  tokenHmacKey: Buffer;
  mfaRequiredDefault: boolean;
  /** Política anti-SSRF de saída (webhooks de saída), mesma regra do worker. */
  outboundPolicy: SafeHttpPolicy;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuração inválida (ver .env.example):\n${msg}`);
  }
  const c = parsed.data;
  const credentialKeys = new Map<number, Buffer>();
  for (const part of c.CREDENTIALS_KEYS.split(",")) {
    const [v, k] = part.split(":");
    const version = Number(v);
    const key = Buffer.from(k ?? "", "base64");
    if (!Number.isInteger(version) || key.length !== 32) {
      throw new Error("CREDENTIALS_KEYS inválida: formato versão:base64(32 bytes)[,versão:base64...]");
    }
    credentialKeys.set(version, key);
  }
  if (!credentialKeys.has(c.CREDENTIALS_KEY_CURRENT)) throw new Error("CREDENTIALS_KEY_CURRENT não corresponde a nenhuma chave");
  if (c.NODE_ENV === "production" && !c.SESSION_COOKIE_SECURE) throw new Error("Em produção SESSION_COOKIE_SECURE deve ser true");
  if (c.EMAIL_TRANSPORT === "smtp" && !c.SMTP_URL) throw new Error("EMAIL_TRANSPORT=smtp exige SMTP_URL");
  return {
    ...c,
    credentialKeys,
    corsOrigins: c.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    tokenHmacKey: Buffer.from(c.TOKEN_HMAC_SECRET, "base64"),
    mfaRequiredDefault: c.MFA_REQUIRED_DEFAULT ?? c.APP_ENV === "production",
    outboundPolicy: outboundPolicyFromEnv(env),
  };
}
