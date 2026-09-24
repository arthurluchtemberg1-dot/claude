import { signCanonicalBody } from "@tracker/connectors";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConnection, createHarness, createOrg, drain, postWebhook, signupVerified, type Client, type Harness } from "../helpers";

/** Políticas de atribuição versionadas com comparação e recálculo (R16-01, R16-02, R16-07) e visão de clientes (R24-04). */

let h: Harness;
let owner: Client;
let orgId: string;
let projectId: string;
let publicKey: string;
beforeAll(async () => {
  h = await createHarness();
  const u = await signupVerified(h, "attr-owner");
  owner = u.client;
  ({ orgId, projectId, publicKey } = await createOrg(owner, "Atribuição Org"));
});
afterAll(async () => h.close());

const uid = () => Math.random().toString(36).slice(2, 10);
const rid = (n = 22) => Array.from({ length: n }, () => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 62)]).join("");
const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

async function send(conn: { token: string; signing_secret: string }, body: Record<string, unknown>) {
  const raw = JSON.stringify({ schema_version: "1.0", source: { provider: "erp", event_id: `evt-${uid()}` }, occurred_at: new Date().toISOString(), ...body });
  const r = await postWebhook(h, conn.token, raw, { "x-tracker-signature": signCanonicalBody(conn.signing_secret, raw, Math.floor(h.clock.now.getTime() / 1000)) });
  expect(r.statusCode).toBe(200);
}

async function visitWithToken(url: string, daysAgo: number): Promise<string> {
  const aid = rid();
  const r = await h.app.inject({
    method: "POST",
    url: "/v1/collect",
    headers: { "content-type": "text/plain", origin: "https://loja.exemplo.test", "user-agent": "Mozilla/5.0" },
    payload: JSON.stringify({ v: 1, pk: publicKey, aid, sid: rid(16), consent: { analytics: true, ads: true, storage: true }, ctx: { url, ref: null }, events: [{ id: rid(20), name: "PageView", ts: Date.now() - 60_000 }], token_request: true }),
  });
  expect(r.statusCode).toBe(200);
  if (daysAgo > 0) {
    await h.admin.query(`update public.touchpoints set occurred_at = now() - make_interval(days => $2) where visitor_id = (select id from public.visitors where anon_id = $1)`, [aid, daysAgo]);
    await h.admin.query(`update public.link_tokens set created_at = now() - make_interval(days => $2) where visitor_id = (select id from public.visitors where anon_id = $1)`, [aid, daysAgo]);
  }
  return r.json().token as string;
}

describe("políticas de atribuição", () => {
  it("cria política de comparação, versiona a principal, recalcula sem Purchase e compara resultados", async () => {
    const list0 = owner.json(await owner.req("GET", "/v1/attribution/policies"));
    expect(list0.policies[0]).toMatchObject({ policy_key: "default", current: { model: "last_paid_click", window_days: 7, version: 1 } });
    expect((await owner.req("POST", "/v1/attribution/policies", { name: "x", model: "first_touch", window_days: 5 })).statusCode).toBe(400);
    const created = owner.json(await owner.req("POST", "/v1/attribution/policies", { name: "Primeiro toque 30 dias", model: "first_touch", window_days: 30 }));
    expect(created.policy_key).toBe("primeiro_toque_30_dias");

    // Clique pago há 10 dias (fora da janela de 7 dias da principal, dentro dos 30 da comparação).
    const token = await visitWithToken("https://loja.exemplo.test/?utm_source=facebook&utm_medium=paid_social&utm_campaign=Promo%7C120000000000123", 10);
    const conn = await createConnection(owner, projectId, "custom");
    const ext = `ord-${uid()}`;
    await send(conn, { event_type: "payment.approved", order: { external_order_id: ext, currency: "BRL", amount_minor: 10000 }, attribution: { tracking_token: token } });
    await drain(h);
    h.clock.now = new Date(Date.now() + 1000); // resultados "até agora"
    const cmp = owner.json(await owner.req("GET", `/v1/attribution/compare?from=${today()}&to=${today()}`));
    const byKey = Object.fromEntries(cmp.policies.map((p: { policy_key: string }) => [p.policy_key, p]));
    expect(byKey.default.categories).toEqual([expect.objectContaining({ category: "unattributed", orders: 1, gross: "10000" })]);
    expect(byKey.primeiro_toque_30_dias.categories).toEqual([expect.objectContaining({ category: "paid", orders: 1 })]);
    expect(byKey.primeiro_toque_30_dias.networks[0].rows).toEqual([expect.objectContaining({ network: "meta", orders_credit: "1", attributed_gross_minor: "10000" })]);

    // Principal passa a 30 dias: nova versão; recálculo explícito do período; nenhum Purchase novo.
    const fanoutBefore = (await h.admin.query("select count(*)::int as n from public.outbox where organization_id = $1 and topic = 'destinations.fanout'", [orgId])).rows[0].n;
    const v2 = owner.json(await owner.req("PUT", "/v1/attribution/policies/default", { window_days: 30 }));
    expect(v2).toMatchObject({ policy_key: "default", version: 2 });
    const rc = owner.json(await owner.req("POST", "/v1/attribution/recompute", { from: today(), to: today() }));
    expect(rc.queued).toBe(1);
    await drain(h);
    const order = owner.json(await owner.req("GET", `/v1/orders?q=${ext}`)).orders[0];
    expect(order.attribution_category).toBe("paid");
    const detail = owner.json(await owner.req("GET", `/v1/orders/${order.id}`));
    const hist = detail.attributions.filter((a: { policy_key: string }) => a.policy_key === "default");
    expect(hist.map((a: { policy_version: number; is_current: boolean }) => `${a.policy_version}:${a.is_current}`).sort()).toEqual(["1:false", "2:true"]);
    const fanoutAfter = (await h.admin.query("select count(*)::int as n from public.outbox where organization_id = $1 and topic = 'destinations.fanout'", [orgId])).rows[0].n;
    expect(fanoutAfter).toBe(fanoutBefore);

    const versions = owner.json(await owner.req("GET", "/v1/attribution/policies")).policies.find((p: { policy_key: string }) => p.policy_key === "default");
    expect(versions.versions.map((v: { version: number; is_active: boolean }) => `${v.version}:${v.is_active}`)).toEqual(["2:true", "1:false"]);

    expect((await owner.req("DELETE", "/v1/attribution/policies/default")).statusCode).toBe(400);
    expect((await owner.req("DELETE", "/v1/attribution/policies/primeiro_toque_30_dias")).statusCode).toBe(200);
    const after = owner.json(await owner.req("GET", `/v1/attribution/compare?from=${today()}&to=${today()}`));
    expect(after.policies.map((p: { policy_key: string }) => p.policy_key)).toEqual(["default"]);
  });

  it("somente perfis com attribution.manage alteram políticas", async () => {
    const analyst = await signupVerified(h, "attr-analyst");
    await owner.req("POST", "/v1/invites", { email: analyst.email, role: "analyst" });
    const token = new URL([...h.emails].reverse().find((m) => m.to === analyst.email && m.kind === "invite")!.actionUrl!).searchParams.get("token")!;
    await analyst.client.req("POST", "/v1/invites/accept", { token });
    analyst.client.orgId = orgId;
    expect((await analyst.client.req("GET", "/v1/attribution/policies")).statusCode).toBe(200);
    expect((await analyst.client.req("POST", "/v1/attribution/policies", { name: "y", model: "linear", window_days: 7 })).statusCode).toBe(403);
    expect((await analyst.client.req("POST", "/v1/attribution/recompute", { from: today(), to: today() })).statusCode).toBe(403);
  });
});

describe("clientes", () => {
  it("agrupa por e-mail normalizado dentro da organização, mascara sem pii.read e permite desfazer o agrupamento", async () => {
    const conn = await createConnection(owner, projectId, "custom");
    const a1 = `c1-${uid()}`;
    const a2 = `c2-${uid()}`;
    const b1 = `c3-${uid()}`;
    const buy = (ext: string, amount: number, email: string) => send(conn, { event_type: "payment.approved", order: { external_order_id: ext, currency: "BRL", amount_minor: amount }, customer: { email, name: "Maria Cliente" } });
    await buy(a1, 5000, "Maria@Exemplo.com");
    await buy(a2, 3000, "MARIA@exemplo.com");
    await buy(b1, 1000, "outra@exemplo.com");
    // Outra organização com o mesmo e-mail: nunca se mistura.
    const other = await signupVerified(h, "cust-other");
    const o2 = await createOrg(other.client, "Outra Org Clientes");
    const oc = await createConnection(other.client, o2.projectId, "custom");
    await send(oc, { event_type: "payment.approved", order: { external_order_id: `x-${uid()}`, currency: "BRL", amount_minor: 99999 }, customer: { email: "maria@exemplo.com" } });
    await drain(h);

    const res = owner.json(await owner.req("GET", "/v1/customers?q=maria@exemplo.com"));
    expect(res.customers).toHaveLength(1);
    const maria = res.customers[0];
    expect(maria).toMatchObject({ identified_by: "email_sha256", email: "maria@exemplo.com", orders: 2, recurring: true, totals: [{ currency: "BRL", approved_minor: "8000", net_minor: "8000" }] });
    expect(res.criterion).toMatch(/hash/);
    expect(owner.json(await owner.req("GET", "/v1/customers?recurring=true")).customers.map((c: { customer_key: string }) => c.customer_key)).toEqual([maria.customer_key]);

    // Analista (sem pii.read): e-mail mascarado; busca por e-mail completo não é aceita como filtro.
    const analyst = await signupVerified(h, "cust-analyst");
    await owner.req("POST", "/v1/invites", { email: analyst.email, role: "analyst" });
    const token = new URL([...h.emails].reverse().find((m) => m.to === analyst.email && m.kind === "invite")!.actionUrl!).searchParams.get("token")!;
    await analyst.client.req("POST", "/v1/invites/accept", { token });
    analyst.client.orgId = orgId;
    const masked = analyst.client.json(await analyst.client.req("GET", "/v1/customers"));
    expect(masked.pii_masked).toBe(true);
    expect(JSON.stringify(masked)).not.toContain("maria@exemplo.com");

    // Detalhe e exclusão reversível.
    const detail = owner.json(await owner.req("GET", `/v1/customers/${maria.customer_key}`));
    expect(detail.orders.map((o: { external_order_id: string }) => o.external_order_id)).toEqual([a1, a2]);
    const second = detail.orders[1];
    const ex = await owner.req("POST", "/v1/customers/exclusions", { order_id: second.id, reason: "Compra para terceiro (confirmado pelo suporte)" });
    expect(ex.statusCode).toBe(201);
    const split = owner.json(await owner.req("GET", `/v1/customers/${maria.customer_key}`));
    expect(split.orders).toHaveLength(1);
    const alone = owner.json(await owner.req("GET", `/v1/customers/pedido:${second.id}`));
    expect(alone.orders[0]).toMatchObject({ external_order_id: a2, excluded: true });
    const audit = (await h.admin.query("select action from public.audit_logs where organization_id = $1 and action like 'customer.%'", [orgId])).rows.map((r) => r.action);
    expect(audit).toContain("customer.order_excluded");
    expect((await owner.req("DELETE", `/v1/customers/exclusions/${second.id}`)).statusCode).toBe(200);
    expect(owner.json(await owner.req("GET", `/v1/customers/${maria.customer_key}`)).orders).toHaveLength(2);
    // Chave de outra organização não é acessível.
    expect((await other.client.req("GET", `/v1/customers/${maria.customer_key}`)).json().orders).toHaveLength(1);
    expect(JSON.stringify(other.client.json(await other.client.req("GET", `/v1/customers/${maria.customer_key}`)))).not.toContain(a1);
  });
});
