import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConnection, createHarness, createOrg, drain, postWebhook, signupVerified, type Client, type Harness } from "../helpers";

const documented = JSON.parse(readFileSync(join(import.meta.dirname, "../../../../packages/connectors/test/fixtures/lowify/documented-example.json"), "utf8"));

let h: Harness;
let client: Client;
let projectId: string;
let publicKey: string;
let orgId: string;

beforeAll(async () => {
  h = await createHarness();
  const u = await signupVerified(h, "tracking");
  client = u.client;
  ({ projectId, publicKey, orgId } = await createOrg(client, "Tracking Org"));
});
afterAll(async () => h.close());

const rid = (n = 22) => Array.from({ length: n }, () => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 62)]).join("");

async function collect(body: Record<string, unknown>, origin = "https://loja.exemplo.test") {
  return h.app.inject({ method: "POST", url: "/v1/collect", headers: { "content-type": "text/plain", origin, "user-agent": "Mozilla/5.0 teste" }, payload: JSON.stringify(body) });
}

function visit(opts: { aid: string; sid: string; url: string; ts: number; consent?: Record<string, boolean | null>; token?: boolean; events?: string[] }) {
  return {
    v: 1,
    pk: publicKey,
    aid: opts.aid,
    sid: opts.sid,
    consent: opts.consent ?? { analytics: true, ads: true, storage: true },
    ctx: { url: opts.url, ref: null, fbp: "fb.1.1726000000000.987654321" },
    events: (opts.events ?? ["PageView"]).map((name) => ({ id: rid(20), name, ts: opts.ts })),
    token_request: opts.token ?? false,
  };
}

describe("coletor do SDK", () => {
  it("T34 sem consentimento de analytics nada é armazenado", async () => {
    const aid = rid();
    const r = await collect(visit({ aid, sid: rid(16), url: "https://loja.exemplo.test/?utm_source=fb", ts: Date.now(), consent: { analytics: null, ads: null, storage: null } }));
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ stored: false, reason: "consent_required" });
    const v = await h.admin.query("select count(*)::int as n from public.visitors where anon_id = $1", [aid]);
    expect(v.rows[0].n).toBe(0);
  });

  it("chave pública inválida, payload grande e eventos fora da janela são rejeitados/ignorados (R40-11)", async () => {
    expect((await collect({ ...visit({ aid: rid(), sid: rid(16), url: "https://x.test/", ts: Date.now() }), pk: "pk_" + "0".repeat(24) })).statusCode).toBe(404);
    expect((await collect({ foo: "bar" })).statusCode).toBe(400);
    const r = await collect(visit({ aid: rid(), sid: rid(16), url: "https://x.test/", ts: Date.now() - 3 * 86_400_000 }));
    expect(r.json().stored).toBe(0);
  });

  it("origem restrita por projeto (não é autenticação, reduz poluição)", async () => {
    await client.req("PATCH", `/v1/projects/${projectId}`, { allowed_origins: ["https://loja.exemplo.test"] });
    expect((await collect(visit({ aid: rid(), sid: rid(16), url: "https://outra.test/", ts: Date.now() }), "https://outra.test")).statusCode).toBe(403);
    expect((await collect(visit({ aid: rid(), sid: rid(16), url: "https://loja.exemplo.test/", ts: Date.now() }))).statusCode).toBe(200);
  });

  it("URL sem parâmetros sensíveis; IP/UA só com consentimento de publicidade", async () => {
    const sid = rid(16);
    await collect(visit({ aid: rid(), sid, url: "https://loja.exemplo.test/p?utm_source=fb&email=a%40b.com&token=segredo", ts: Date.now(), consent: { analytics: true, ads: false, storage: true } }));
    const s = (await h.admin.query("select landing_url, client_ip, user_agent, fbp from public.sessions where session_key = $1", [sid])).rows[0];
    expect(s.landing_url).toBe("https://loja.exemplo.test/p?utm_source=fb");
    expect(s.client_ip).toBeNull();
    expect(s.user_agent).toBeNull();
    expect(s.fbp).toBeNull();
  });
});

describe("jornada visita → token → checkout Lowify → atribuição (T29, T31, T36, T37)", () => {
  it("token devolvido no campo configurado vincula o pedido ao visitante com evidência forte", async () => {
    const conn = await createConnection(client, projectId, "lowify", { config: { token_carrier: "utm_term" } });
    const aid = rid();
    const now = Date.now();
    // Visita paga 2 dias antes, depois retorno direto (bio) antes da compra.
    const h1 = await collect(visit({ aid, sid: rid(16), url: "https://loja.exemplo.test/oferta?utm_source=facebook&utm_medium=paid_social&utm_campaign=Campanha%20A%7C120000000000001", ts: now - 2 * 86_400_000 + 60_000 }));
    expect(h1.statusCode).toBe(200);
    // Ajuste manual do horário do toque (o coletor limita a 24h para eventos atrasados).
    await h.admin.query("update public.sessions set started_at = now() - interval '2 days' where visitor_id = (select id from public.visitors where anon_id = $1)", [aid]);
    await h.admin.query("update public.touchpoints set occurred_at = now() - interval '2 days' where visitor_id = (select id from public.visitors where anon_id = $1)", [aid]);
    const h2 = await collect(visit({ aid, sid: rid(16), url: "https://loja.exemplo.test/oferta", ts: now - 60_000, token: true, events: ["PageView", "CheckoutClick"] }));
    const token = h2.json().token as string;
    expect(token).toMatch(/^trk_[A-Za-z0-9]{24}$/);

    // Lowify devolve UTMs; utm_term transporta o token (configurado na conexão).
    const order = `ord_trk_${Date.now()}`;
    const ts = new Date(now).toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).replace("T", " ");
    const r = await postWebhook(h, conn.token, { ...documented, order_id: order, timestamp: ts, tracking: { ...documented.tracking, utm_term: `keyword|${token}` } });
    expect(r.statusCode).toBe(200);
    await drain(h);

    const list = client.json(await client.req("GET", `/v1/orders?q=${order}`)).orders;
    expect(list[0]).toMatchObject({ attribution_category: "paid" });
    const detail = client.json(await client.req("GET", `/v1/orders/${list[0].id}`));
    const current = detail.attributions.find((a: { is_current: boolean }) => a.is_current);
    expect(current).toMatchObject({ model: "last_paid_click", evidence: "token_link", window_days: 7 });
    expect(current.path.length).toBeGreaterThanOrEqual(2); // caminho observado inclui o retorno direto
    expect(detail.order.declared_tracking.trackingToken).toMatch(/^…/); // nunca exposto completo
    expect(JSON.stringify(detail)).not.toContain(token);

    // Diagnóstico da cadeia (R15-08).
    const diag = client.json(await client.req("GET", `/v1/diagnostics/tracking/orders/${list[0].id}`));
    expect(diag.steps.every((s: { ok: boolean }) => s.ok)).toBe(true);
    expect(JSON.stringify(diag)).not.toContain(token);
  });

  it("T30/T37 sem token e sem UTMs: venda preservada, sem atribuição com motivo localizado", async () => {
    const conn = await createConnection(client, projectId, "lowify", { config: { token_carrier: "utm_term" } });
    const order = `ord_none_${Date.now()}`;
    await postWebhook(h, conn.token, { ...documented, order_id: order, tracking: null });
    await drain(h);
    const list = client.json(await client.req("GET", `/v1/orders?q=${order}`)).orders;
    expect(list[0]).toMatchObject({ financial_status: "approved", attribution_category: "unattributed", unattributed_reason: "no_touchpoints" });
    const diag = client.json(await client.req("GET", `/v1/diagnostics/tracking/orders/${list[0].id}`));
    expect(diag.loss_reason).toBeTruthy();
  });

  it("T38 macro não expandida vinda do checkout não vira ID; T40 ID de outra organização não é validado", async () => {
    const other = await signupVerified(h, "other");
    await createOrg(other.client, "Outra Org");
    const created = await other.client.req("POST", "/v1/ad-accounts", { network: "meta", external_account_id: "act_other", name: "Outra", currency: "BRL", timezone: "America/Sao_Paulo" });
    expect(created.statusCode, created.body).toBe(201);
    const otherOrgId = other.client.orgId!;
    const acc = (await h.admin.query("select id from public.ad_accounts where organization_id = $1", [otherOrgId])).rows[0].id;
    await h.admin.query("insert into public.ad_entities (organization_id, ad_account_id, level, external_id, name) values ($1, $2, 'campaign', '120000000000999', 'Campanha da outra org')", [otherOrgId, acc]);

    const conn = await createConnection(client, projectId, "lowify");
    const o1 = `ord_macro_${Date.now()}`;
    await postWebhook(h, conn.token, { ...documented, order_id: o1, tracking: { utm_source: "facebook", utm_medium: "paid_social", utm_campaign: "{{campaign.name}}|{{campaign.id}}" } });
    const o2 = `ord_cross_${Date.now()}`;
    await postWebhook(h, conn.token, { ...documented, order_id: o2, tracking: { utm_source: "facebook", utm_medium: "paid_social", utm_campaign: "Roubada|120000000000999" } });
    await drain(h);
    const d1 = client.json(await client.req("GET", `/v1/orders/${client.json(await client.req("GET", `/v1/orders?q=${o1}`)).orders[0].id}`));
    const cur1 = d1.attributions.find((a: { is_current: boolean }) => a.is_current);
    expect(cur1.campaign_id).toBeNull();
    expect(cur1.reason).toMatch(/macro não expandida/);
    const d2 = client.json(await client.req("GET", `/v1/orders/${client.json(await client.req("GET", `/v1/orders?q=${o2}`)).orders[0].id}`));
    const tp = d2.touchpoints.find((t: { evidence: string }) => t.evidence === "checkout_source");
    expect(tp).toMatchObject({ campaign_id: "120000000000999", ids_validated: false, declared: true });
    expect(orgId).not.toBe(otherOrgId);
  });

  it("T32 clique pago fora da janela não recebe crédito; recálculo cria nova versão (T27)", async () => {
    const conn = await createConnection(client, projectId, "lowify", { config: { token_carrier: "utm_term" } });
    const aid = rid();
    const r = await collect(visit({ aid, sid: rid(16), url: "https://loja.exemplo.test/?utm_source=facebook&utm_medium=cpc", ts: Date.now() - 60_000, token: true }));
    const token = r.json().token as string;
    await h.admin.query("update public.touchpoints set occurred_at = now() - interval '10 days' where visitor_id = (select id from public.visitors where anon_id = $1)", [aid]);
    await h.admin.query("update public.link_tokens set created_at = now() - interval '10 days' where visitor_id = (select id from public.visitors where anon_id = $1)", [aid]);
    const order = `ord_old_${Date.now()}`;
    const ts = new Date().toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).replace("T", " ");
    await postWebhook(h, conn.token, { ...documented, order_id: order, timestamp: ts, tracking: { utm_term: token } });
    await drain(h);
    const list = client.json(await client.req("GET", `/v1/orders?q=${order}`)).orders;
    expect(list[0].attribution_category).toBe("unattributed");
    // Nova política (janela 30 dias) → recálculo explícito preserva histórico.
    await h.admin.query("update public.attribution_policies set is_active = false where organization_id = $1", [orgId]);
    await h.admin.query("insert into public.attribution_policies (organization_id, policy_key, name, version, model, window_days, is_default) values ($1, 'default', 'Último clique pago — 30 dias', 2, 'last_paid_click', 30, true)", [orgId]);
    await h.admin.query("insert into public.outbox (organization_id, topic, payload, dedup_key) values ($1, 'attribution.compute', $2, $3)", [orgId, JSON.stringify({ order_id: list[0].id }), `attr-recalc:${list[0].id}`]);
    const deliveriesBefore = (await h.admin.query("select count(*)::int as n from public.outbox where organization_id = $1 and topic = 'destinations.fanout'", [orgId])).rows[0].n;
    await drain(h);
    const detail = client.json(await client.req("GET", `/v1/orders/${list[0].id}`));
    const versions = detail.attributions.filter((a: { policy_key: string }) => a.policy_key === "default");
    expect(versions).toHaveLength(2);
    const cur = versions.find((a: { is_current: boolean }) => a.is_current);
    expect(cur).toMatchObject({ policy_version: 2, window_days: 30, category: "paid" });
    expect(cur.recalculation_of).toBeTruthy();
    const deliveriesAfter = (await h.admin.query("select count(*)::int as n from public.outbox where organization_id = $1 and topic = 'destinations.fanout'", [orgId])).rows[0].n;
    expect(deliveriesAfter).toBe(deliveriesBefore);
  });
});
