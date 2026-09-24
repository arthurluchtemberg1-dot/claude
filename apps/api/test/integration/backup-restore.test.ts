import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signCanonicalBody } from "@tracker/connectors";
import { createPool } from "@tracker/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DB } from "../../../../test/env";
import { buildApp } from "../../src/app";
import { loadConfig } from "../../src/lib/config";
import { decryptSecret } from "../../src/lib/crypto";
import { createEmailSender } from "../../src/lib/email";
import { createLogger } from "../../src/lib/logger";
import { Client, createConnection, createHarness, createOrg, drain, postWebhook, signupVerified, type Harness } from "../helpers";

/**
 * T69 — backup restaurado: recuperação reproduzível e credenciais protegidas. Executa os scripts reais
 * (scripts/backup.mjs e scripts/restore.mjs) com pg_dump/pg_restore contra o banco de teste e um banco novo.
 */

const root = join(import.meta.dirname, "../../../..");
const RESTORE_DB = "tracker_restore_check";
const withDb = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};
const restoreAdmin = withDb(TEST_DB.admin, RESTORE_DB);

let h: Harness;
let dir: string;
let owner: { email: string; password: string };
let orgId: string;
let conn: { id: string; token: string; signing_secret: string };
const orders: string[] = [];

async function adminExec(sql: string) {
  const c = new pg.Client({ connectionString: withDb(TEST_DB.admin, "postgres") });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

function run(script: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [join(root, script), ...args], { cwd: root, env: { ...process.env, ...env }, encoding: "utf8" });
}

beforeAll(async () => {
  h = await createHarness();
  const u = await signupVerified(h, "backup");
  owner = { email: u.email, password: u.password };
  ({ orgId } = await createOrg(u.client, "Backup Org"));
  const projectId = u.client.json(await u.client.req("GET", "/v1/projects")).projects[0].id;
  conn = await createConnection(u.client, projectId, "custom");
  for (const [i, amount] of [19700, 4990].entries()) {
    const ext = `bk-${i}-${Math.random().toString(36).slice(2, 8)}`;
    orders.push(ext);
    const raw = JSON.stringify({ schema_version: "1.0", source: { provider: "erp", event_id: `evt-bk-${ext}` }, event_type: "payment.approved", occurred_at: "2026-09-15T12:00:00-03:00", order: { external_order_id: ext, currency: "BRL", amount_minor: amount }, customer: { email: "pessoa@backup.test" } });
    const r = await postWebhook(h, conn.token, raw, { "x-tracker-signature": signCanonicalBody(conn.signing_secret, raw, Math.floor(h.clock.now.getTime() / 1000)) });
    expect(r.statusCode).toBe(200);
  }
  await drain(h);
  dir = mkdtempSync(join(tmpdir(), "tracker-backup-"));
  await adminExec(`drop database if exists ${RESTORE_DB} with (force)`);
  await adminExec(`create database ${RESTORE_DB}`);
});

afterAll(async () => {
  await h.close();
  await adminExec(`drop database if exists ${RESTORE_DB} with (force)`).catch(() => undefined);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("T69 backup e restauração", () => {
  it("restaura em banco novo com manifesto idêntico, sem segredos em claro, e o sistema volta a operar", async () => {
    const dump = join(dir, "tracker.dump");
    const b = run("scripts/backup.mjs", ["--url", TEST_DB.admin, "--out", dump]);
    expect(b.status, b.stderr).toBe(0);
    // A senha do banco não aparece na linha de comando do pg_dump nem na saída.
    expect(b.stdout + b.stderr).not.toContain(new URL(TEST_DB.admin).password);

    // Credenciais protegidas: dump só com material cifrado; nem o segredo nem as chaves aparecem.
    const sql = execFileSync("pg_restore", ["--data-only", "--file", "-", dump], { maxBuffer: 256 * 1024 * 1024 }).toString("utf8");
    expect(sql).toContain("COPY private.credentials");
    expect(sql).not.toContain(conn.signing_secret);
    for (const part of (process.env.CREDENTIALS_KEYS ?? "").split(",")) expect(sql).not.toContain(part.split(":")[1]!);
    expect(sql).not.toContain(process.env.TOKEN_HMAC_SECRET!);

    // Papéis no destino (mesmas senhas do ambiente de teste; o comando é idempotente) e restauração verificada.
    const appPw = decodeURIComponent(new URL(TEST_DB.app).password);
    const sysPw = decodeURIComponent(new URL(TEST_DB.system).password);
    const prov = spawnSync(join(root, "node_modules/.bin/tsx"), ["packages/db/src/cli.ts", "provision-roles"], {
      cwd: root,
      env: { ...process.env, DATABASE_URL_ADMIN: restoreAdmin, DB_APP_PASSWORD: appPw, DB_SYSTEM_PASSWORD: sysPw },
      encoding: "utf8",
    });
    expect(prov.status, prov.stderr).toBe(0);
    const r = run("scripts/restore.mjs", ["--url", restoreAdmin, "--in", dump]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Restauração verificada/);

    // Destino não vazio e arquivo adulterado são recusados.
    expect(run("scripts/restore.mjs", ["--url", restoreAdmin, "--in", dump]).status).toBe(1);
    const tampered = join(dir, "adulterado.dump");
    copyFileSync(dump, tampered);
    copyFileSync(`${dump}.manifest.json`, `${tampered}.manifest.json`);
    appendFileSync(tampered, "x");
    const t = run("scripts/restore.mjs", ["--url", restoreAdmin, "--in", tampered]);
    expect(t.status).toBe(1);
    expect(t.stderr).toMatch(/sha256/);

    // RLS preservada no banco restaurado: papel da API sem contexto não enxerga pedidos.
    const appRestored = withDb(TEST_DB.app, RESTORE_DB);
    const sysRestored = withDb(TEST_DB.system, RESTORE_DB);
    const ac = new pg.Client({ connectionString: appRestored });
    await ac.connect();
    expect((await ac.query("select count(*)::int as n from public.orders")).rows[0].n).toBe(0);
    await ac.end();

    // Credencial restaurada decifra com as chaves (guardadas fora do banco).
    const config = loadConfig({ ...process.env, NODE_ENV: "test", DATABASE_URL_APP: appRestored, DATABASE_URL_SYSTEM: sysRestored, EMAIL_TRANSPORT: "memory", LOG_LEVEL: "silent", MFA_REQUIRED_DEFAULT: "false" });
    const rc = new pg.Client({ connectionString: restoreAdmin });
    await rc.connect();
    const cred = (await rc.query("select ciphertext from private.credentials where connection_id = $1 and purpose = 'webhook_secret' and revoked_at is null and rotated_at is null", [conn.id])).rows[0];
    await rc.end();
    expect(decryptSecret({ keys: config.credentialKeys, current: config.CREDENTIALS_KEY_CURRENT }, cred.ciphertext, `${orgId}:${conn.id}:webhook_secret`)).toBe(conn.signing_secret);

    // Uma API apontada para o banco restaurado autentica o usuário e devolve as vendas com os mesmos valores.
    const pools = { app: createPool(appRestored, { max: 2 }), system: createPool(sysRestored, { max: 2 }) };
    const app = await buildApp({ config, pools, logger: createLogger("silent"), email: createEmailSender("memory", () => undefined, false), now: () => new Date() });
    try {
      const client = new Client({ app, deps: null as never, admin: null as never, worker: null as never, emails: [], clock: { now: new Date() }, close: async () => undefined });
      const login = await client.req("POST", "/v1/auth/login", { email: owner.email, password: owner.password });
      expect(login.statusCode, login.body).toBe(200);
      client.orgId = orgId;
      const list = client.json(await client.req("GET", "/v1/orders?limit=100")).orders;
      const mine = list.filter((o: { external_order_id: string }) => orders.includes(o.external_order_id));
      expect(mine.map((o: { approved_minor: string }) => o.approved_minor).sort()).toEqual(["19700", "4990"]);
      // O webhook de entrada continua aceitando o segredo restaurado.
      const raw = JSON.stringify({ schema_version: "1.0", source: { provider: "erp", event_id: "evt-pos-restauracao" }, event_type: "payment.pending", occurred_at: new Date().toISOString(), order: { external_order_id: "pos-restauracao", currency: "BRL", amount_minor: 100 } });
      const wh = await app.inject({ method: "POST", url: `/v1/webhooks/${conn.token}`, headers: { "content-type": "application/json", "x-tracker-signature": signCanonicalBody(conn.signing_secret, raw, Math.floor(Date.now() / 1000)) }, payload: raw });
      expect(wh.statusCode).toBe(200);
    } finally {
      await app.close();
      await Promise.all([pools.app.end(), pools.system.end()]);
    }
  });
});
