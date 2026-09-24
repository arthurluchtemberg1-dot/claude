import { randomUUID } from "node:crypto";
import pg from "pg";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { createPool } from "@tracker/db";
import { drainOutbox, type WorkerDeps } from "@tracker/worker";
import { TEST_DB } from "../../../test/env";
import { buildApp } from "../src/app";
import type { AppDeps } from "../src/context";
import { loadConfig } from "../src/lib/config";
import { createEmailSender, type EmailMessage } from "../src/lib/email";
import { createLogger } from "../src/lib/logger";
import { totpAt, totpStep } from "../src/lib/crypto";

export interface Harness {
  app: FastifyInstance;
  deps: AppDeps;
  admin: pg.Pool;
  worker: WorkerDeps;
  emails: EmailMessage[];
  clock: { now: Date };
  close(): Promise<void>;
}

export async function createHarness(overrides: Partial<Record<string, string>> = {}, fetchImpl: typeof fetch = fetch): Promise<Harness> {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    APP_ENV: "test",
    DATABASE_URL_APP: TEST_DB.app,
    DATABASE_URL_SYSTEM: TEST_DB.system,
    EMAIL_TRANSPORT: "memory",
    LOG_LEVEL: "silent",
    CORS_ORIGINS: "http://localhost:3000",
    MFA_REQUIRED_DEFAULT: "false",
    ...overrides,
  });
  const pools = { app: createPool(TEST_DB.app, { max: 5 }), system: createPool(TEST_DB.system, { max: 5 }) };
  const email = createEmailSender("memory", () => undefined, false);
  const clock = { now: new Date() };
  const deps: AppDeps = { config, pools, logger: createLogger(process.env.TEST_LOG_LEVEL ?? "silent"), email, now: () => clock.now };
  const app = await buildApp(deps);
  const admin = new pg.Pool({ connectionString: TEST_DB.admin, max: 2 });
  const worker: WorkerDeps = {
    pools: { system: pools.system },
    tokenHmacKey: config.tokenHmacKey,
    now: () => clock.now,
    log: () => undefined,
    delivery: {
      environment: "test",
      allowExternalDelivery: config.ALLOW_EXTERNAL_DELIVERY,
      fetchImpl,
      loadSecret: (await import("@tracker/worker")).createSecretLoader(process.env.CREDENTIALS_KEYS),
      timeoutMs: 500,
    },
    // Testes: somente destinos locais (rede privada liberada, envio externo desligado).
    outbound: {
      policy: { allowPrivateNetworks: true, allowPublicNetworks: false, requireHttps: false, timeoutMs: 2000, maxRedirects: 3, maxResponseBytes: 64 * 1024, blockedHosts: ["localhost"] },
      loadSecrets: (await import("@tracker/worker")).createSubscriptionSecretLoader(process.env.CREDENTIALS_KEYS),
    },
  };
  return {
    app,
    deps,
    admin,
    worker,
    emails: email.sent!,
    clock,
    async close() {
      await app.close();
      await Promise.all([pools.app.end(), pools.system.end(), admin.end()]);
    },
  };
}

export class Client {
  cookie: string | null = null;
  orgId: string | null = null;
  constructor(private readonly h: Harness) {}

  async req(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = { ...extraHeaders };
    if (this.cookie) headers.cookie = this.cookie;
    if (this.orgId) headers["x-org-id"] = this.orgId;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await this.h.app.inject({ method, url, headers, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
    const set = res.headers["set-cookie"];
    const setStr = Array.isArray(set) ? set[0] : set;
    if (setStr) {
      const m = /^([^=]+)=([^;]*)/.exec(setStr);
      if (m) this.cookie = m[2] ? `${m[1]}=${m[2]}` : null;
    }
    return res;
  }

  json<T = any>(res: LightMyRequestResponse): T {
    return res.json() as T;
  }
}

export async function signupVerified(h: Harness, label = "user"): Promise<{ client: Client; email: string; password: string; userId: string }> {
  const client = new Client(h);
  const email = `${label}-${randomUUID().slice(0, 8)}@teste.local`;
  const password = "senha-forte-de-teste-123";
  const r = await client.req("POST", "/v1/auth/signup", { email, password, displayName: label });
  if (r.statusCode !== 201) throw new Error(`signup falhou: ${r.statusCode} ${r.body}`);
  const msg = [...h.emails].reverse().find((m) => m.to === email && m.kind === "verify_email");
  const token = new URL(msg!.actionUrl!).searchParams.get("token")!;
  const v = await client.req("POST", "/v1/auth/verify-email", { token });
  if (v.statusCode !== 200) throw new Error(`verify falhou: ${v.body}`);
  const me = client.json((await client.req("GET", "/v1/auth/me")));
  return { client, email, password, userId: me.user.id };
}

export async function createOrg(client: Client, name = "Org Teste"): Promise<{ orgId: string; projectId: string; publicKey: string }> {
  const r = await client.req("POST", "/v1/orgs", { name });
  if (r.statusCode !== 201) throw new Error(`org falhou: ${r.statusCode} ${r.body}`);
  const b = client.json(r);
  client.orgId = b.id;
  return { orgId: b.id, projectId: b.project.id, publicKey: b.project.public_key };
}

export async function createConnection(client: Client, projectId: string, provider: "lowify" | "custom", extra: Record<string, unknown> = {}) {
  const r = await client.req("POST", "/v1/connections", {
    provider,
    project_id: projectId,
    name: `${provider} teste`,
    account_external_id: `acct-${randomUUID().slice(0, 8)}`,
    account_display_name: "Conta de teste",
    ...extra,
  });
  if (r.statusCode !== 201) throw new Error(`conexão falhou: ${r.statusCode} ${r.body}`);
  const b = client.json(r);
  return { ...b, token: String(b.webhook_url).split("/").pop() as string };
}

export async function postWebhook(h: Harness, token: string, body: unknown, headers: Record<string, string> = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return h.app.inject({ method: "POST", url: `/v1/webhooks/${token}`, headers: { "content-type": "application/json", ...headers }, payload: raw });
}

export async function drain(h: Harness) {
  return drainOutbox(h.worker);
}

export function totpNow(secret: string, now = new Date()) {
  return totpAt(secret, totpStep(now));
}
