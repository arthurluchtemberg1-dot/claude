import { signCanonicalBody } from "@tracker/connectors";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registeredPublicRoutes } from "../../src/public/plugin";
import { createConnection, createHarness, createOrg, drain, postWebhook, signupVerified, type Client, type Harness } from "../helpers";

/**
 * API pública v1 (R33-01..R33-04): chaves com hash, escopos, projetos, sandbox, limites com cabeçalhos, Idempotency-Key,
 * contrato de erro, uso sem conteúdo sensível, revogação/expiração, OpenAPI cobrindo todas as rotas e sem CORS.
 */

let h: Harness;
let owner: Client;
let orgId: string;
let p1: string;
let p2: string;
const RATE = 8;

beforeAll(async () => {
  h = await createHarness({ API_RATE_LIMIT_PER_KEY: String(RATE), API_RATE_LIMIT_PER_ORG: "1000" });
  const u = await signupVerified(h, "api-owner");
  owner = u.client;
  ({ orgId, projectId: p1 } = await createOrg(owner, "API Org"));
  p2 = owner.json(await owner.req("POST", "/v1/projects", { name: "Projeto 2" })).id;
});
afterAll(async () => h.close());

const uid = () => Math.random().toString(36).slice(2, 10);

async function newKey(body: Record<string, unknown>) {
  const r = await owner.req("POST", "/v1/api-keys", { name: `chave ${uid()}`, ...body });
  expect(r.statusCode, r.body).toBe(201);
  return owner.json(r) as { id: string; key: string; prefix: string };
}

async function call(key: string | null, method: "GET" | "POST", url: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await h.app.inject({
    method,
    url,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return r;
}

async function sale(conn: { token: string; signing_secret: string }, ext: string, amount: number) {
  const raw = JSON.stringify({
    schema_version: "1.0",
    source: { provider: "erp", event_id: `evt-${uid()}` },
    event_type: "payment.approved",
    occurred_at: "2026-09-10T12:00:00-03:00",
    order: { external_order_id: ext, currency: "BRL", amount_minor: amount },
    customer: { email: "pessoa@cliente.test" },
  });
  const r = await postWebhook(h, conn.token, raw, { "x-tracker-signature": signCanonicalBody(conn.signing_secret, raw, Math.floor(h.clock.now.getTime() / 1000)) });
  expect(r.statusCode).toBe(200);
}

describe("chaves e autenticação", () => {
  it("chave exibida uma vez, guardada por hash; erros com código e request_id; revogação e expiração", async () => {
    const k = await newKey({ scopes: ["orders:read"] });
    expect(k.key).toMatch(/^tk_live_[A-Za-z0-9]{8}_[A-Za-z0-9]{40}$/);
    const list = owner.json(await owner.req("GET", "/v1/api-keys")).api_keys;
    expect(JSON.stringify(list)).not.toContain(k.key);
    expect(list.find((x: { id: string }) => x.id === k.id)).toMatchObject({ prefix: k.prefix, environment: "production" });
    const stored = (await h.admin.query("select key_hash from public.api_keys where id = $1", [k.id])).rows[0].key_hash as Buffer;
    expect(stored.toString("utf8")).not.toContain(k.key.slice(-40));

    const none = await call(null, "GET", "/public/v1/orders");
    expect(none.statusCode).toBe(401);
    expect(none.json().error).toMatchObject({ code: "invalid_api_key", request_id: expect.any(String) });
    expect((await call("tk_live_xxxxxxxx_" + "a".repeat(40), "GET", "/public/v1/orders")).statusCode).toBe(401);
    expect((await call(k.key, "GET", "/public/v1/orders")).statusCode).toBe(200);
    // Cookie de sessão não autentica a API pública.
    expect((await h.app.inject({ method: "GET", url: "/public/v1/orders", headers: { cookie: owner.cookie! } })).statusCode).toBe(401);

    expect((await owner.req("DELETE", `/v1/api-keys/${k.id}`)).statusCode).toBe(200);
    const revoked = await call(k.key, "GET", "/public/v1/orders");
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json().error.code).toBe("api_key_revoked");

    const e = await newKey({ scopes: ["orders:read"], expires_in_days: 1 });
    await h.admin.query("update public.api_keys set expires_at = now() - interval '1 minute' where id = $1", [e.id]);
    expect((await call(e.key, "GET", "/public/v1/orders")).json().error.code).toBe("api_key_expired");

    const notFound = await call(null, "GET", "/public/v1/nao-existe");
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json().error).toMatchObject({ code: "not_found", request_id: expect.any(String) });
  });

  it("resposta de criação só sai após o commit: chave recém-criada funciona imediatamente (regressão)", async () => {
    // COMMIT artificialmente lento (gatilho adiado): se a resposta saísse antes do commit, a chave ainda não existiria.
    await h.admin.query("create or replace function public.test_slow_commit() returns trigger language plpgsql as $$ begin perform pg_sleep(0.2); return null; end $$");
    await h.admin.query("create constraint trigger test_slow_commit after insert on public.api_keys deferrable initially deferred for each row execute function public.test_slow_commit()");
    try {
      for (let i = 0; i < 3; i++) {
        const k = await newKey({ scopes: ["integrations:read"] });
        const r = await call(k.key, "GET", "/public/v1/integrations");
        expect(r.statusCode, `iteração ${i}: ${r.body}`).toBe(200);
      }
    } finally {
      await h.admin.query("drop trigger if exists test_slow_commit on public.api_keys");
      await h.admin.query("drop function if exists public.test_slow_commit()");
    }
  });

  it("escopos, sandbox sem escopos de produção e projeto restrito", async () => {
    expect((await owner.req("POST", "/v1/api-keys", { name: "sb", scopes: ["metrics:read"], environment: "sandbox" })).statusCode).toBe(400);
    const k = await newKey({ scopes: ["orders:read"], project_ids: [p1] });
    const m = await call(k.key, "GET", "/public/v1/metrics/summary?from=2026-09-01&to=2026-09-30");
    expect(m.statusCode).toBe(403);
    expect(m.json().error.code).toBe("insufficient_scope");
    expect((await call(k.key, "GET", `/public/v1/orders?project_id=${p2}`)).json().error.code).toBe("project_forbidden");

    const c1 = await createConnection(owner, p1, "custom");
    const c2 = await createConnection(owner, p2, "custom");
    const o1 = `A-${uid()}`;
    const o2 = `B-${uid()}`;
    await sale(c1, o1, 1000);
    await sale(c2, o2, 2000);
    await drain(h);
    const list = (await call(k.key, "GET", "/public/v1/orders")).json();
    const ids = list.data.map((o: { external_order_id: string }) => o.external_order_id);
    expect(ids).toContain(o1);
    expect(ids).not.toContain(o2);
    expect(JSON.stringify(list)).not.toContain("pessoa@cliente.test"); // sem dados pessoais
    const all = (await call((await newKey({ scopes: ["orders:read"] })).key, "GET", "/public/v1/orders")).json().data;
    const other = all.find((o: { external_order_id: string }) => o.external_order_id === o2);
    expect((await call(k.key, "GET", `/public/v1/orders/${other.id}`)).statusCode).toBe(404);
    const detail = (await call(k.key, "GET", `/public/v1/orders/${list.data.find((o: { external_order_id: string }) => o.external_order_id === o1).id}`)).json().data;
    expect(detail).toMatchObject({ external_order_id: o1, status: "approved", approved_minor: "1000", currency: "BRL" });
    expect(detail.transactions[0]).toMatchObject({ status: "approved", amount_minor: "1000" });
  });

  it("paginação por cursor sem repetir nem pular", async () => {
    const conn = await createConnection(owner, p1, "custom");
    for (let i = 0; i < 5; i++) await sale(conn, `PAG-${i}-${uid()}`, 100 + i);
    await drain(h);
    const k = await newKey({ scopes: ["orders:read"] });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const r: { data: { id: string }[]; next_cursor: string | null } = (await call(k.key, "GET", `/public/v1/orders?limit=2${cursor ? `&cursor=${cursor}` : ""}`)).json();
      seen.push(...r.data.map((o) => o.id));
      cursor = r.next_cursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    const total = (await h.admin.query("select count(*)::int as n from public.orders where organization_id = $1 and not is_test", [orgId])).rows[0].n;
    expect(seen.length).toBe(total);
    expect((await call(k.key, "GET", "/public/v1/orders?cursor=lixo")).json().error.code).toBe("invalid_cursor");
  });
});

describe("importação de vendas com Idempotency-Key e sandbox", () => {
  it("repetição devolve a resposta original; corpo diferente → 422; mesmo pedido com outra chave → 409", async () => {
    const k = await newKey({ scopes: ["orders:write", "orders:read"] });
    const body = { project_id: p1, external_order_id: `API-${uid()}`, amount_minor: 4990, currency: "BRL", occurred_at: "2026-09-12T10:00:00-03:00", reference: "NF 123", payment_method: "pix" };
    expect((await call(k.key, "POST", "/public/v1/sales", body)).json().error.code).toBe("idempotency_key_required");
    const first = await call(k.key, "POST", "/public/v1/sales", body, { "idempotency-key": "import-1" });
    expect(first.statusCode, first.body).toBe(202);
    const again = await call(k.key, "POST", "/public/v1/sales", body, { "idempotency-key": "import-1" });
    expect(again.statusCode).toBe(202);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.json()).toEqual(first.json());
    const changed = await call(k.key, "POST", "/public/v1/sales", { ...body, amount_minor: 1 }, { "idempotency-key": "import-1" });
    expect(changed.statusCode).toBe(422);
    const dup = await call(k.key, "POST", "/public/v1/sales", body, { "idempotency-key": "import-2" });
    expect(dup.statusCode).toBe(409);
    expect((await call(k.key, "POST", "/public/v1/sales", { ...body, project_id: "00000000-0000-4000-8000-000000000000" }, { "idempotency-key": "import-3" })).statusCode).toBe(400);

    await drain(h);
    const orders = (await call(k.key, "GET", "/public/v1/orders?limit=100")).json().data;
    expect(orders.find((o: { external_order_id: string }) => o.external_order_id === body.external_order_id)).toMatchObject({ provider: "manual", status: "approved", approved_minor: "4990", is_test: false });
    const audit = (await h.admin.query("select actor_type, details from public.audit_logs where organization_id = $1 and action = 'order.manual_created' and details->>'external_order_id' = $2", [orgId, body.external_order_id])).rows;
    expect(audit).toEqual([expect.objectContaining({ actor_type: "api_key", details: expect.objectContaining({ api_key_id: k.id }) })]);
  });

  it("sandbox cria e lê somente vendas de teste; produção não as vê nem nas métricas", async () => {
    const sb = await newKey({ scopes: ["orders:write", "orders:read"], environment: "sandbox" });
    expect(sb.key).toMatch(/^tk_test_/);
    const ext = `SB-${uid()}`;
    const r = await call(sb.key, "POST", "/public/v1/sales", { project_id: p1, external_order_id: ext, amount_minor: 777, currency: "BRL", occurred_at: "2026-09-12T11:00:00-03:00", reference: "teste" }, { "idempotency-key": "sb-1" });
    expect(r.json().data.is_test).toBe(true);
    await drain(h);
    const sbOrders = (await call(sb.key, "GET", "/public/v1/orders?limit=100")).json().data;
    expect(sbOrders.map((o: { external_order_id: string }) => o.external_order_id)).toEqual([ext]);
    const prod = await newKey({ scopes: ["orders:read", "metrics:read"] });
    const prodOrders = (await call(prod.key, "GET", "/public/v1/orders?limit=100")).json().data;
    expect(prodOrders.map((o: { external_order_id: string }) => o.external_order_id)).not.toContain(ext);
    h.clock.now = new Date(Date.now() + 1000);
    const m = (await call(prod.key, "GET", "/public/v1/metrics/summary?from=2026-09-12&to=2026-09-12")).json();
    const gross = m.data[0].metrics.find((x: { id: string }) => x.id === "gross_approved_revenue");
    expect(gross.amount_minor).not.toBe("777");
  });
});

describe("limites, uso e documentação", () => {
  it("cabeçalhos RateLimit-*; excesso → 429 com Retry-After, por chave", async () => {
    const k = await newKey({ scopes: ["integrations:read"] });
    const other = await newKey({ scopes: ["integrations:read"] });
    let last = await call(k.key, "GET", "/public/v1/integrations");
    expect(last.headers["ratelimit-limit"]).toBe(String(RATE));
    expect(last.headers["ratelimit-remaining"]).toBe(String(RATE - 1));
    for (let i = 1; i < RATE; i++) last = await call(k.key, "GET", "/public/v1/integrations");
    expect(last.statusCode).toBe(200);
    expect(last.headers["ratelimit-remaining"]).toBe("0");
    const over = await call(k.key, "GET", "/public/v1/integrations");
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe("rate_limited");
    expect(Number(over.headers["retry-after"])).toBeGreaterThan(0);
    expect((await call(other.key, "GET", "/public/v1/integrations")).statusCode).toBe(200);
  });

  it("uso registrado com rota modelo, sem query string, e último acesso", async () => {
    const k = await newKey({ scopes: ["orders:read"] });
    await call(k.key, "GET", `/public/v1/orders?project_id=${p1}&approved_from=2026-01-01T00:00:00Z`);
    await call(k.key, "GET", "/public/v1/orders/00000000-0000-4000-8000-000000000000");
    const u = owner.json(await owner.req("GET", `/v1/api-keys/${k.id}/usage`));
    expect(u.recent.map((x: { route: string; status: number }) => `${x.route} ${x.status}`).sort()).toEqual(["/public/v1/orders 200", "/public/v1/orders/:id 404"]);
    expect(JSON.stringify(u)).not.toContain("approved_from");
    expect(u.key.last_used_at).toBeTruthy();
  });

  it("OpenAPI 3.1 público documenta todas as rotas registradas; API pública sem CORS", async () => {
    const r = await h.app.inject({ method: "GET", url: "/public/v1/openapi.json" });
    expect(r.statusCode).toBe(200);
    const doc = r.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.components.securitySchemes.bearer).toMatchObject({ type: "http", scheme: "bearer" });
    expect(registeredPublicRoutes.size).toBeGreaterThanOrEqual(8);
    for (const route of registeredPublicRoutes) {
      const [method, url] = route.split(" ");
      const path = url!.replace(/^\/public\/v1/, "").replace(/:([A-Za-z_]+)/g, "{$1}");
      expect(doc.paths[path]?.[method!.toLowerCase()], route).toBeTruthy();
    }
    const pre = await h.app.inject({ method: "OPTIONS", url: "/public/v1/orders", headers: { origin: "https://site-qualquer.test", "access-control-request-method": "GET" } });
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
