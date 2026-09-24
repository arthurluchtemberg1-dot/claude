import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, createConnection, createHarness, createOrg, signupVerified, totpNow, type Harness } from "../helpers";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

describe("autenticação (R06-01..R06-03)", () => {
  it("cadastro, verificação de e-mail, login e logout", async () => {
    const { client, email, password } = await signupVerified(h, "auth");
    const me = client.json(await client.req("GET", "/v1/auth/me"));
    expect(me.user).toMatchObject({ email, email_verified: true, mfa_enabled: false });
    expect((await client.req("POST", "/v1/auth/logout", {})).statusCode).toBe(200);
    expect((await client.req("GET", "/v1/auth/me")).statusCode).toBe(401);
    const login = await client.req("POST", "/v1/auth/login", { email, password });
    expect(login.statusCode).toBe(200);
    expect((await client.req("GET", "/v1/auth/me")).statusCode).toBe(200);
  });

  it("senha errada tem mensagem genérica e bloqueio progressivo (R06-02)", async () => {
    const { email } = await signupVerified(h, "lock");
    const anon = new Client(h);
    for (let i = 0; i < 5; i++) {
      const r = await anon.req("POST", "/v1/auth/login", { email, password: "errada-errada-1" });
      expect(r.statusCode).toBe(401);
      expect(anon.json(r).error.message).toBe("E-mail ou senha inválidos");
    }
    const blocked = await anon.req("POST", "/v1/auth/login", { email, password: "errada-errada-1" });
    expect(blocked.statusCode).toBe(429);
    const unknown = await anon.req("POST", "/v1/auth/login", { email: "naoexiste@teste.local", password: "qualquer-coisa-1" });
    expect(unknown.statusCode).toBe(401);
  });

  it("recuperação de senha encerra sessões existentes; token é de uso único", async () => {
    const { client, email } = await signupVerified(h, "reset");
    const other = new Client(h);
    expect((await other.req("POST", "/v1/auth/password/forgot", { email })).statusCode).toBe(200);
    expect((await other.req("POST", "/v1/auth/password/forgot", { email: "ninguem@teste.local" })).statusCode).toBe(200);
    const msg = [...h.emails].reverse().find((m) => m.to === email && m.kind === "reset_password")!;
    const token = new URL(msg.actionUrl!).searchParams.get("token")!;
    expect((await other.req("POST", "/v1/auth/password/reset", { token, password: "nova-senha-forte-456" })).statusCode).toBe(200);
    expect((await other.req("POST", "/v1/auth/password/reset", { token, password: "outra-senha-forte-789" })).statusCode).toBe(400);
    expect((await client.req("GET", "/v1/auth/me")).statusCode).toBe(401);
    expect((await other.req("POST", "/v1/auth/login", { email, password: "nova-senha-forte-456" })).statusCode).toBe(200);
  });

  it("MFA TOTP: configuração, login exige código, código reutilizado é recusado", async () => {
    const { client, email, password } = await signupVerified(h, "mfa");
    const setup = client.json(await client.req("POST", "/v1/auth/mfa/setup", {}));
    expect(setup.otpauth_url).toMatch(/^otpauth:\/\/totp\//);
    const code = totpNow(setup.secret, h.clock.now);
    expect((await client.req("POST", "/v1/auth/mfa/confirm", { code })).statusCode).toBe(200);
    await client.req("POST", "/v1/auth/logout", {});
    const login = client.json(await client.req("POST", "/v1/auth/login", { email, password }));
    expect(login.mfa_required).toBe(true);
    const me = client.json(await client.req("GET", "/v1/auth/me"));
    expect(me.user.mfa_verified).toBe(false);
    expect(me.organizations).toEqual([]);
    expect((await client.req("POST", "/v1/orgs", { name: "x" })).statusCode).toBe(401);
    // Mesmo passo de tempo já usado na confirmação: rejeitado (anti-replay).
    expect((await client.req("POST", "/v1/auth/mfa/verify", { code })).statusCode).toBe(400);
    h.clock.now = new Date(h.clock.now.getTime() + 30_000);
    expect((await client.req("POST", "/v1/auth/mfa/verify", { code: totpNow(setup.secret, h.clock.now) })).statusCode).toBe(200);
    expect((await client.req("POST", "/v1/orgs", { name: "MFA Org" })).statusCode).toBe(201);
  });

  it("MFA obrigatório para ações sensíveis quando a organização exige", async () => {
    const { client } = await signupVerified(h, "mfareq");
    const { projectId } = await createOrg(client, "Org MFA");
    await client.req("PATCH", "/v1/org", { mfa_required: true });
    const r = await client.req("POST", "/v1/connections", { provider: "lowify", project_id: projectId, name: "x", account_external_id: "a", account_display_name: "a" });
    expect(r.statusCode).toBe(403);
    expect(client.json(r).error.code).toBe("mfa_setup_required");
  });
});

describe("organizações, convites e isolamento (R06, T52–T54)", () => {
  it("convite de uso único com e-mail correspondente; permissões por perfil", async () => {
    const owner = await signupVerified(h, "owner");
    const { orgId } = await createOrg(owner.client, "Agência X");
    const invitee = await signupVerified(h, "analyst");
    const inv = await owner.client.req("POST", "/v1/invites", { email: invitee.email, role: "analyst" });
    expect(inv.statusCode).toBe(201);
    const token = new URL([...h.emails].reverse().find((m) => m.to === invitee.email && m.kind === "invite")!.actionUrl!).searchParams.get("token")!;
    // Outro usuário não pode usar o convite.
    const stranger = await signupVerified(h, "stranger");
    expect((await stranger.client.req("POST", "/v1/invites/accept", { token })).statusCode).toBe(403);
    expect((await invitee.client.req("POST", "/v1/invites/accept", { token })).statusCode).toBe(200);
    expect((await invitee.client.req("POST", "/v1/invites/accept", { token })).statusCode).toBe(400);
    invitee.client.orgId = orgId;
    // Analista lê métricas, mas não conecta provedores nem gerencia membros.
    expect((await invitee.client.req("GET", "/v1/orders")).statusCode).toBe(200);
    expect((await invitee.client.req("GET", "/v1/members")).statusCode).toBe(403);
    const projects = invitee.client.json(await invitee.client.req("GET", "/v1/projects")).projects;
    expect((await invitee.client.req("POST", "/v1/connections", { provider: "lowify", project_id: projects[0].id, name: "x", account_external_id: "a", account_display_name: "a" })).statusCode).toBe(403);
  });

  it("T52 organização A não lê nem escreve dados de B (cabeçalho, URL direta, export)", async () => {
    const a = await signupVerified(h, "orga");
    const b = await signupVerified(h, "orgb");
    const orgA = await createOrg(a.client, "A");
    const orgB = await createOrg(b.client, "B");
    const connB = await createConnection(b.client, orgB.projectId, "lowify");
    // A tenta usar o org id de B.
    a.client.orgId = orgB.orgId;
    const res = await a.client.req("GET", "/v1/connections");
    expect(res.statusCode).toBe(403);
    expect((await a.client.req("GET", "/v1/exports/orders.csv?from=2020-01-01T00:00:00Z&to=2030-01-01T00:00:00Z")).statusCode).toBe(403);
    // Com o próprio org, IDs de B não aparecem nem são alteráveis.
    a.client.orgId = orgA.orgId;
    expect((await a.client.req("PATCH", `/v1/connections/${connB.id}`, { name: "hack" })).statusCode).toBe(404);
    expect((await a.client.req("GET", `/v1/orders/${connB.id}`)).statusCode).toBe(404);
    const list = a.client.json(await a.client.req("GET", "/v1/connections"));
    expect(list.connections.map((c: { id: string }) => c.id)).not.toContain(connB.id);
  });

  it("T54 membro removido perde acesso na sessão já aberta", async () => {
    const owner = await signupVerified(h, "own2");
    const { orgId } = await createOrg(owner.client, "Org Remoção");
    const member = await signupVerified(h, "member");
    await owner.client.req("POST", "/v1/invites", { email: member.email, role: "viewer" });
    const token = new URL([...h.emails].reverse().find((m) => m.to === member.email && m.kind === "invite")!.actionUrl!).searchParams.get("token")!;
    await member.client.req("POST", "/v1/invites/accept", { token });
    member.client.orgId = orgId;
    expect((await member.client.req("GET", "/v1/orders")).statusCode).toBe(200);
    const members = owner.client.json(await owner.client.req("GET", "/v1/members")).members;
    const mem = members.find((m: { email: string }) => m.email === member.email);
    expect((await owner.client.req("PATCH", `/v1/members/${mem.id}`, { status: "removed" })).statusCode).toBe(200);
    expect((await member.client.req("GET", "/v1/orders")).statusCode).toBe(403);
  });

  it("não é possível remover o último proprietário; auditoria registra alterações", async () => {
    const owner = await signupVerified(h, "own3");
    await createOrg(owner.client, "Org Dono");
    const members = owner.client.json(await owner.client.req("GET", "/v1/members")).members;
    const r = await owner.client.req("PATCH", `/v1/members/${members[0].id}`, { role: "admin" });
    expect(r.statusCode).toBe(409);
    const logs = owner.client.json(await owner.client.req("GET", "/v1/audit-logs")).entries;
    expect(logs.map((l: { action: string }) => l.action)).toContain("organization.created");
  });

  it("CSRF: mutação com Origin não permitido é recusada", async () => {
    const { client } = await signupVerified(h, "csrf");
    const r = await client.req("POST", "/v1/orgs", { name: "x" }, { origin: "https://malicioso.example" });
    expect(r.statusCode).toBe(403);
  });
});
