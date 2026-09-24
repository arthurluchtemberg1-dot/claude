#!/usr/bin/env node
/**
 * Verificação ponta a ponta da implantação de referência em contêineres (sem provedores reais):
 *   node deploy/compose-smoke.mjs --env-file deploy/.env.smoke
 * Sobe o compose, confere saúde/prontidão, SDK pelo painel, cadastro → organização → conexão de webhook próprio →
 * webhook assinado → processamento no worker (Redis/BullMQ) → pedido aprovado. Usa EMAIL_TRANSPORT=log para ler o
 * link de verificação nos logs da API. Derruba a pilha (com volumes) ao final, salvo --keep.
 */
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { "env-file": { type: "string" }, keep: { type: "boolean", default: false } }, args: process.argv.slice(2).filter((a) => a !== "--") });
const here = import.meta.dirname;
const compose = join(here, "docker-compose.yml");
let envFile = values["env-file"];
if (!envFile) {
  // Segredos efêmeros só para esta verificação local.
  envFile = join(here, ".env.smoke");
  if (!existsSync(envFile)) {
    const b64 = () => randomBytes(32).toString("base64");
    const pw = () => randomBytes(18).toString("base64url");
    writeFileSync(
      envFile,
      [
        "PUBLIC_API_URL=http://localhost:4000",
        "NEXT_PUBLIC_APP_URL=http://localhost:3000",
        "APP_ENV=staging",
        `POSTGRES_PASSWORD=${pw()}`,
        `DB_APP_PASSWORD=${pw()}`,
        `DB_SYSTEM_PASSWORD=${pw()}`,
        `CREDENTIALS_KEYS=1:${b64()}`,
        "CREDENTIALS_KEY_CURRENT=1",
        `TOKEN_HMAC_SECRET=${b64()}`,
        "SESSION_COOKIE_SECURE=true",
        "MFA_REQUIRED_DEFAULT=false",
        "EMAIL_TRANSPORT=log",
        "ALLOW_EXTERNAL_DELIVERY=false",
      ].join("\n") + "\n",
      { mode: 0o600 },
    );
  }
}
const dc = (...args) => execFileSync("docker", ["compose", "-f", compose, "--env-file", envFile, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const api = "http://127.0.0.1:4000";
const web = "http://127.0.0.1:3000";

async function waitFor(label, fn, ms = 180_000) {
  const start = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* ainda subindo */
    }
    if (Date.now() - start > ms) throw new Error(`Tempo esgotado: ${label}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const ok = (label) => console.log(`✔ ${label}`);

let cookie = "";
async function call(method, path, body, headers = {}) {
  const res = await fetch(`${api}${path}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

try {
  dc("up", "-d", "--no-build");
  await waitFor("API pronta", async () => (await fetch(`${api}/ready`)).ok);
  ok("API /ready");
  await waitFor("worker pronto", async () => dc("exec", "-T", "worker", "node", "-e", "fetch('http://127.0.0.1:4100/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))") !== undefined);
  ok("worker /ready (PostgreSQL + Redis)");
  await waitFor("painel", async () => (await fetch(`${web}/entrar`)).ok);
  ok("painel /entrar");
  const sdk = await fetch(`${web}/sdk/v1/tracker.js`);
  if (!sdk.ok || !(await sdk.text()).includes("tracker")) throw new Error("SDK não servido pelo painel");
  ok("SDK servido via painel → API");

  const email = `smoke-${Date.now()}@teste.local`;
  const password = "senha-forte-smoke-123";
  if ((await call("POST", "/v1/auth/signup", { email, password, displayName: "Smoke" })).status !== 201) throw new Error("cadastro falhou");
  // O transporte "log" não registra o destinatário (privacidade): usa o link de verificação mais recente.
  const link = await waitFor("link de verificação no log", async () => /token=([A-Za-z0-9_-]+)/.exec(dc("logs", "api").split("\n").filter((l) => l.includes("verify_email")).at(-1) ?? "")?.[1]);
  if ((await call("POST", "/v1/auth/verify-email", { token: link })).status !== 200) throw new Error("verificação falhou");
  cookie = "";
  if ((await call("POST", "/v1/auth/login", { email, password })).status !== 200) throw new Error("login falhou");
  const org = await call("POST", "/v1/orgs", { name: "Smoke Org" });
  if (org.status !== 201) throw new Error(`organização falhou: ${JSON.stringify(org.json)}`);
  const orgHeader = { "x-org-id": org.json.id };
  const conn = await call("POST", "/v1/connections", { provider: "custom", project_id: org.json.project.id, name: "Smoke", account_external_id: "smoke-acct", account_display_name: "Conta smoke" }, orgHeader);
  if (conn.status !== 201) throw new Error(`conexão falhou: ${JSON.stringify(conn.json)}`);
  ok("cadastro, verificação, login, organização e conexão");

  const token = String(conn.json.webhook_url).split("/").pop();
  const ext = `smoke-${Date.now()}`;
  const raw = JSON.stringify({ schema_version: "1.0", source: { provider: "smoke", event_id: `evt-${ext}` }, event_type: "payment.approved", occurred_at: new Date().toISOString(), order: { external_order_id: ext, currency: "BRL", amount_minor: 12345 } });
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${createHmac("sha256", conn.json.signing_secret).update(`${t}.${raw}`).digest("hex")}`;
  const wh = await fetch(`${api}/v1/webhooks/${token}`, { method: "POST", headers: { "content-type": "application/json", "x-tracker-signature": sig }, body: raw });
  if (wh.status !== 200) throw new Error(`webhook recusado: ${wh.status}`);
  const order = await waitFor("pedido processado pelo worker", async () => {
    const r = await call("GET", `/v1/orders?q=${ext}`, undefined, orgHeader);
    const o = r.json?.orders?.[0];
    return o?.financial_status === "approved" ? o : null;
  }, 60_000);
  if (order.approved_minor !== "12345") throw new Error("valor divergente");
  ok("webhook assinado → outbox → Redis/BullMQ → worker → pedido aprovado (R$ 123,45)");
  console.log("Implantação de referência verificada.");
} catch (err) {
  console.error(`✘ ${err.message}`);
  try {
    console.error(dc("ps"));
    console.error(dc("logs", "--tail", "40"));
  } catch {
    /* sem logs */
  }
  process.exitCode = 1;
} finally {
  if (!values.keep) dc("down", "-v");
}
