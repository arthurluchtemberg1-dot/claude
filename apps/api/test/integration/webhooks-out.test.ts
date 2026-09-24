import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { signCanonicalBody, verifyOutbound } from "@tracker/connectors";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConnection, createHarness, createOrg, drain, postWebhook, signupVerified, type Client, type Harness } from "../helpers";

/**
 * Webhooks de saída (R33-05..R33-07, T67): validação do destino no cadastro, verificação de posse por teste assinado,
 * eventos assinados sem dados pessoais, retentativas/fila de falhas/reenvio, rotação com dupla assinatura e limite de
 * saltos contra loops. Receptor local; nenhuma chamada externa (ALLOW_EXTERNAL_DELIVERY=false).
 */

interface Hit {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let h: Harness;
let strict: Harness;
let owner: Client;
let projectId: string;
let server: Server;
let base = "";
const hits: Hit[] = [];
const failing = new Set<string>();

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ path: req.url ?? "", headers: req.headers, body });
      res.writeHead(failing.has(req.url ?? "") ? 500 : 200).end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Desenvolvimento/teste: destinos em rede privada liberados só aqui; envio externo desligado.
  h = await createHarness({ OUTBOUND_ALLOW_PRIVATE_NETWORKS: "true", ALLOW_EXTERNAL_DELIVERY: "false" });
  // Política equivalente à de produção (rede privada bloqueada) para o cadastro.
  strict = await createHarness({ OUTBOUND_ALLOW_PRIVATE_NETWORKS: "false", ALLOW_EXTERNAL_DELIVERY: "true" });
  const u = await signupVerified(h, "wh-owner");
  owner = u.client;
  ({ projectId } = await createOrg(owner, "Webhooks Org"));
});
afterAll(async () => {
  await h.close();
  await strict.close();
  server.close();
});

const uid = () => Math.random().toString(36).slice(2, 10);

async function subscribe(path: string, events = ["order.approved", "order.reversed", "order.status_changed"], extra: Record<string, unknown> = {}) {
  const r = await owner.req("POST", "/v1/webhook-subscriptions", { name: `sub ${uid()}`, url: `${base}${path}`, events, ...extra });
  expect(r.statusCode, r.body).toBe(201);
  const b = owner.json(r) as { id: string; signing_secret: string; status: string };
  expect(b.status).toBe("paused");
  expect((await owner.req("POST", `/v1/webhook-subscriptions/${b.id}/test`)).json()).toMatchObject({ ok: true, verified: true });
  expect((await owner.req("PATCH", `/v1/webhook-subscriptions/${b.id}`, { status: "active" })).statusCode).toBe(200);
  return b;
}

async function sendSale(conn: { token: string; signing_secret: string }, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const raw = JSON.stringify({ schema_version: "1.0", source: { provider: "erp", event_id: `evt-${uid()}` }, occurred_at: new Date().toISOString(), ...body });
  return postWebhook(h, conn.token, raw, { "x-tracker-signature": signCanonicalBody(conn.signing_secret, raw, Math.floor(h.clock.now.getTime() / 1000)), ...headers });
}

const hitsFor = (path: string) => hits.filter((x) => x.path === path);
const typeOf = (x: Hit) => JSON.parse(x.body).type as string;

describe("cadastro protegido contra SSRF (T67)", () => {
  it("bloqueia rede interna, metadata, loopback, esquemas indevidos e o próprio sistema", async () => {
    const s = await signupVerified(strict, "ssrf");
    await createOrg(s.client, "SSRF Org");
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.8/hook",
      "http://127.0.0.1:4000/v1/webhooks/whk_x",
      "http://[::1]/hook",
      "http://localhost:4000/hook",
      "http://0x7f000001/hook",
      "file:///etc/passwd",
      "https://user:senha@exemplo.com.br/hook",
    ]) {
      const r = await s.client.req("POST", "/v1/webhook-subscriptions", { name: "x", url, events: ["order.approved"] });
      expect(r.statusCode, url).toBe(400);
      expect(r.json().error.code).toBe("destination_blocked");
    }
    // Mesmo com rede privada liberada (dev), o host do próprio sistema continua proibido (loop).
    const own = await owner.req("POST", "/v1/webhook-subscriptions", { name: "loop", url: "http://localhost:4000/v1/webhooks/whk_abc", events: ["order.approved"] });
    expect(own.json().error.message).toMatch(/próprio sistema|reservado/);
  });
});

describe("verificação, entrega assinada e conteúdo", () => {
  it("assinatura nasce pausada, só ativa após teste 2xx; evento assinado sem dados pessoais e sem duplicar", async () => {
    const r = await owner.req("POST", "/v1/webhook-subscriptions", { name: "pedidos", url: `${base}/pedidos`, events: ["order.approved", "order.reversed", "order.status_changed"] });
    const sub = owner.json(r);
    const early = await owner.req("PATCH", `/v1/webhook-subscriptions/${sub.id}`, { status: "active" });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe("verification_required");
    const test = owner.json(await owner.req("POST", `/v1/webhook-subscriptions/${sub.id}/test`));
    expect(test).toMatchObject({ ok: true, http_status: 200, verified: true });
    const ping = hitsFor("/pedidos").at(-1)!;
    expect(typeOf(ping)).toBe("test.ping");
    expect(verifyOutbound(ping.headers["x-tracker-signature"] as string, ping.body, sub.signing_secret, h.clock.now)).toMatchObject({ ok: true });
    expect((await owner.req("PATCH", `/v1/webhook-subscriptions/${sub.id}`, { status: "active" })).statusCode).toBe(200);

    const conn = await createConnection(owner, projectId, "custom");
    const ext = `ord-${uid()}`;
    const approved = { event_type: "payment.approved", order: { external_order_id: ext, external_transaction_id: `${ext}-tx`, currency: "BRL", amount_minor: 19700 }, customer: { email: "comprador@cliente.test", name: "Fulano" } };
    await sendSale(conn, approved);
    await sendSale(conn, approved); // reenvio do mesmo evento pelo checkout
    await drain(h);
    const got = hitsFor("/pedidos").filter((x) => typeOf(x) !== "test.ping");
    expect(got.map(typeOf).sort()).toEqual(["order.approved", "order.status_changed"]);
    const ev = got.find((x) => typeOf(x) === "order.approved")!;
    const check = verifyOutbound(ev.headers["x-tracker-signature"] as string, ev.body, sub.signing_secret, h.clock.now);
    expect(check).toMatchObject({ ok: true, id: ev.headers["x-tracker-webhook-id"] });
    expect(ev.headers["x-tracker-hop"]).toBe("1");
    expect(ev.body).not.toContain("comprador@cliente.test");
    expect(ev.body).not.toContain("Fulano");
    const payload = JSON.parse(ev.body);
    expect(payload).toMatchObject({ type: "order.approved", data: { order: { external_order_id: ext, status: "approved", approved_minor: "19700" }, transaction: { amount_minor: "19700" } }, provenance: { hop: 1 } });

    // Estorno → order.reversed + mudança de status.
    await sendSale(conn, { event_type: "refund.succeeded", order: { external_order_id: ext, external_transaction_id: `${ext}-tx`, currency: "BRL" }, refund: { external_refund_id: `r-${uid()}`, amount_minor: 19700, semantics: "full" } });
    await drain(h);
    const after = hitsFor("/pedidos").filter((x) => typeOf(x) !== "test.ping").map(typeOf);
    expect(after.filter((t) => t === "order.reversed")).toHaveLength(1);
    const rev = JSON.parse(hitsFor("/pedidos").find((x) => typeOf(x) === "order.reversed")!.body);
    expect(rev.data.reversal).toMatchObject({ amount_minor: "19700", type: "refund" });
    const deliveries = owner.json(await owner.req("GET", `/v1/webhook-subscriptions/${sub.id}/deliveries`)).deliveries;
    expect(deliveries.every((d: { status: string }) => d.status === "succeeded")).toBe(true);
  });
});

describe("falhas, fila e reenvio", () => {
  it("5xx reagenda com backoff; esgotadas as tentativas vai para a fila de falhas; reenvio manual entrega com o mesmo ID", async () => {
    const sub = await subscribe("/instavel", ["order.approved"]);
    failing.add("/instavel");
    h.worker.outbound.maxAttempts = 2;
    const conn = await createConnection(owner, projectId, "custom");
    await sendSale(conn, { event_type: "payment.approved", order: { external_order_id: `f-${uid()}`, currency: "BRL", amount_minor: 500 } });
    await drain(h);
    let d = owner.json(await owner.req("GET", `/v1/webhook-subscriptions/${sub.id}/deliveries?status=retry_scheduled`)).deliveries;
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ attempts: 1, last_http_status: 500 });
    expect(new Date(d[0].next_attempt_at).getTime()).toBeGreaterThan(h.clock.now.getTime() + 30_000);
    // Antecipa a próxima tentativa (o relógio real não é alterado).
    await h.admin.query("update public.outbox set available_at = now() where topic = 'webhooks.deliver' and status = 'pending'");
    await drain(h);
    d = owner.json(await owner.req("GET", `/v1/webhook-subscriptions/${sub.id}/deliveries?status=dead`)).deliveries;
    expect(d).toHaveLength(1);
    const list = owner.json(await owner.req("GET", "/v1/webhook-subscriptions")).subscriptions.find((s: { id: string }) => s.id === sub.id);
    expect(list).toMatchObject({ consecutive_failures: 2, dead_deliveries: "1" });

    failing.delete("/instavel");
    expect((await owner.req("POST", `/v1/webhook-deliveries/${d[0].id}/resend`)).statusCode).toBe(200);
    await drain(h);
    const ok = owner.json(await owner.req("GET", `/v1/webhook-subscriptions/${sub.id}/deliveries?status=succeeded`)).deliveries.filter((x: { event_type: string }) => x.event_type !== "test.ping");
    expect(ok).toHaveLength(1);
    const ids = hitsFor("/instavel").filter((x) => typeOf(x) === "order.approved").map((x) => x.headers["x-tracker-webhook-id"]);
    expect(new Set(ids).size).toBe(1); // mesmo ID em todas as tentativas
    expect(ids.length).toBe(3);
    h.worker.outbound.maxAttempts = undefined;
  });

  it("rotação de segredo: entregas levam as duas assinaturas durante a transição", async () => {
    const sub = await subscribe("/rotacao", ["order.approved"]);
    const rotated = owner.json(await owner.req("POST", `/v1/webhook-subscriptions/${sub.id}/rotate-secret`));
    const conn = await createConnection(owner, projectId, "custom");
    await sendSale(conn, { event_type: "payment.approved", order: { external_order_id: `rot-${uid()}`, currency: "BRL", amount_minor: 900 } });
    await drain(h);
    const ev = hitsFor("/rotacao").find((x) => typeOf(x) === "order.approved")!;
    const sig = ev.headers["x-tracker-signature"] as string;
    expect(sig.match(/v1=/g)).toHaveLength(2);
    expect(verifyOutbound(sig, ev.body, rotated.signing_secret, h.clock.now).ok).toBe(true);
    expect(verifyOutbound(sig, ev.body, sub.signing_secret, h.clock.now).ok).toBe(true);
  });
});

describe("loops e proveniência (R33-07)", () => {
  it("salto acima do limite é recusado na entrada; no limite, processa sem reemitir; abaixo, propaga hop+1", async () => {
    await subscribe("/saltos", ["order.approved"]);
    const conn = await createConnection(owner, projectId, "custom");
    const over = await sendSale(conn, { event_type: "payment.approved", order: { external_order_id: `h4-${uid()}`, currency: "BRL", amount_minor: 100 } }, { "x-tracker-hop": "4" });
    expect(over.statusCode).toBe(508);
    const atLimit = `h3-${uid()}`;
    expect((await sendSale(conn, { event_type: "payment.approved", order: { external_order_id: atLimit, currency: "BRL", amount_minor: 100 } }, { "x-tracker-hop": "3" })).statusCode).toBe(200);
    const below = `h1-${uid()}`;
    expect((await sendSale(conn, { event_type: "payment.approved", order: { external_order_id: below, currency: "BRL", amount_minor: 100 } }, { "x-tracker-hop": "1" })).statusCode).toBe(200);
    await drain(h);
    const orders = hitsFor("/saltos").filter((x) => typeOf(x) === "order.approved").map((x) => JSON.parse(x.body));
    expect(orders.map((o) => o.data.order.external_order_id)).toEqual([below]);
    expect(orders[0].provenance).toMatchObject({ hop: 2, source: "checkout_webhook", receipt_id: expect.any(String) });
    // A venda no limite foi processada normalmente (sem perda), apenas não reemitida.
    const st = (await h.admin.query("select financial_status from public.orders where external_order_id = $1", [atLimit])).rows[0];
    expect(st.financial_status).toBe("approved");
  });
});
