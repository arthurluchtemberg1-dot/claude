import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmailSender } from "../../src/lib/email";
import { TEST_DB } from "../../../../test/env";
import { Client, createHarness, type Harness } from "../helpers";

/**
 * Instalação privada (deploy/install.sh): cadastro público fechado, e-mail desligado aceito em produção sem
 * registrar links, e proprietário criado/redefinido pela linha de comando do servidor (admin.js).
 */

let h: Harness;
const apiDir = join(import.meta.dirname, "../..");
const admin = (args: string[], password?: string) =>
  execFileSync("npx", ["tsx", "src/cli/admin.ts", ...args], { cwd: apiDir, encoding: "utf8", env: { ...process.env, DATABASE_URL_SYSTEM: TEST_DB.system, TRACKER_PASSWORD: password ?? "" }, stdio: ["ignore", "pipe", "pipe"] });

beforeAll(async () => {
  h = await createHarness({ SIGNUP_MODE: "closed" });
});
afterAll(async () => h?.close());

describe("instalação privada", () => {
  it("cadastro público fechado responde 403 sem criar conta", async () => {
    const c = new Client(h);
    const email = `fechado-${Date.now()}@teste.local`;
    const r = await c.req("POST", "/v1/auth/signup", { email, password: "senha-forte-de-teste-123", displayName: "X" });
    expect(r.statusCode).toBe(403);
    expect(c.json(r).error.code).toBe("signup_closed");
    expect((await h.admin.query("select count(*)::int as n from iam.users where email = $1", [email])).rows[0].n).toBe(0);
  });

  it("proprietário criado pela linha de comando já verificado; senha redefinida encerra sessões", async () => {
    const email = `dono-${Date.now()}@teste.local`;
    expect(admin(["create-owner", "--email", email, "--name", "Dono"], "senha-do-dono-123")).toMatch(/Conta criada e verificada/);
    expect(() => admin(["create-owner", "--email", email], "senha-do-dono-123")).toThrow();
    expect(() => admin(["create-owner", "--email", `fraca-${Date.now()}@teste.local`], "123")).toThrow();
    const c = new Client(h);
    expect((await c.req("POST", "/v1/auth/login", { email, password: "senha-do-dono-123" })).statusCode).toBe(200);
    expect(c.json(await c.req("GET", "/v1/auth/me")).user).toMatchObject({ email, email_verified: true });
    admin(["reset-password", "--email", email], "outra-senha-forte-456");
    expect((await c.req("GET", "/v1/auth/me")).statusCode).toBe(401);
    expect((await new Client(h).req("POST", "/v1/auth/login", { email, password: "outra-senha-forte-456" })).statusCode).toBe(200);
  });

  it("e-mail desligado é aceito em produção e não registra links", async () => {
    const logs: Record<string, unknown>[] = [];
    const s = createEmailSender("disabled", (o) => logs.push(o), true);
    await s.send({ to: "a@b.com", subject: "x", text: "t", kind: "verify_email", actionUrl: "https://x/segredo" });
    expect(s.disabled).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("segredo");
    expect(() => createEmailSender("log", () => undefined, true)).toThrow(/não é permitido em produção/);
  });
});
