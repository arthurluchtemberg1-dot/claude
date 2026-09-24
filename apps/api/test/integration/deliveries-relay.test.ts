import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { signCanonicalBody } from "@tracker/connectors";
import { dispatchOutboxItem, relayOnce } from "@tracker/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_REDIS_URL } from "../../../../test/env";
import { createConnection, createHarness, createOrg, drain, postWebhook, signupVerified, type Client, type Harness } from "../helpers";

/**
 * Entregas Meta CAPI contra servidor HTTP local que simula respostas da Graph API (nenhuma chamada real),
 * e relay outbox → BullMQ com Redis real, incluindo indisponibilidade do Redis (T23).
 */

interface Received {
  path: string;
  body: { data: { event_id: string; event_name: string; event_time: number; user_data: Record<string, unknown> }[]; test_event_code?: string };
}
const received: Received[] = [];
let mode: Array<"ok" | "429" | "500" | "400" | "hang"> = [];
let server: Server;
let baseUrl = "";

// fetch que redireciona graph.facebook.com para o servidor local.
const localFetch: typeof fetch = async (input, init) => {
  const url = String(input).replace("https://graph.facebook.com", baseUrl);
  return fetch(url, init);
};

let h: Harness;
let client: Client;
let projectId: string;
let conn: { token: string; signing_secret: string };

beforeAll(async () => {
  server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const m = mode.shift() ?? "ok";
      received.push({ path: req.url ?? "", body: JSON.parse(data) });
      if (m === "hang") return; // simula timeout após escrita
      if (m === "429") return res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: 4, message: "rate limit" } }));
      if (m === "500") return res.writeHead(500).end("{}");
      if (m === "400") return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: 100, message: "Invalid parameter", fbtrace_id: "TR400" } }));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ events_received: 1, fbtrace_id: "TR200" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  h = await createHarness({ ALLOW_EXTERNAL_DELIVERY: "true" }, localFetch);
  const u = await signupVerified(h, "deliv");
  client = u.client;
  ({ projectId } = await createOrg(client, "Deliveries Org"));
  conn = await createConnection(client, projectId, "custom");
});

afterAll(async () => {
  await h.close();
  server.closeAllConnections();
  server.close();
});

async function approve(ext: string, amount = 19990) {
  const body = JSON.stringify({ schema_version: "1.0", source: { event_id: `e-${ext}` }, event_type: "payment.approved", occurred_at: h.clock.now.toISOString(), order: { external_order_id: ext, currency: "BRL", amount_minor: amount }, customer: { email: "Comprador@Exemplo.com", phone: "11999999999" } });
  const r = await postWebhook(h, conn.token, body, { "x-tracker-signature": signCanonicalBody(conn.signing_secret, body, Math.floor(h.clock.now.getTime() / 1000)) });
  expect(r.statusCode).toBe(200);
}

async function deliveriesFor(ext: string) {
  const r = await h.admin.query(
    "select d.* from public.destination_deliveries d join public.orders o on o.id = d.order_id where o.external_order_id = $1",
    [ext],
  );
  return r.rows;
}

async function runDue() {
  await h.admin.query("update public.outbox set available_at = now() where status = 'pending' and available_at > now()");
  await drain(h);
}

describe("destino Meta CAPI (servidor local simulando a Graph API)", () => {
  let destId: string;

  it("R02-08 destino nasce desligado e exige emissor responsável antes de ativar", async () => {
    const r = await client.req("POST", "/v1/destinations", { provider: "meta_capi", name: "Pixel principal", config: { pixel_id: "123456789012345", test_event_code: "TEST77" }, access_token: "EAAB-token-de-teste-nao-real-0000000000" });
    expect(r.statusCode).toBe(201);
    destId = client.json(r).id;
    expect((await client.req("PATCH", `/v1/destinations/${destId}`, { status: "test_mode" })).statusCode).toBe(400);
    expect((await client.req("PATCH", `/v1/destinations/${destId}`, { status: "enabled", purchase_emitter: "server" })).statusCode).toBe(400);
    // Sem destino ativo, aprovação não gera entrega.
    await approve("NO-DEST");
    await drain(h);
    expect(await deliveriesFor("NO-DEST")).toHaveLength(0);
    const list = client.json(await client.req("GET", "/v1/destinations")).destinations;
    expect(JSON.stringify(list)).not.toContain("EAAB-token");
  });

  it("T43 emissor = checkout nativo → servidor não envia Purchase (não elegível, com motivo)", async () => {
    await client.req("PATCH", `/v1/destinations/${destId}`, { status: "test_mode", purchase_emitter: "checkout_native" });
    await approve("NATIVE");
    await drain(h);
    const d = await deliveriesFor("NATIVE");
    expect(d[0]).toMatchObject({ status: "not_eligible" });
    expect(d[0].not_eligible_reason).toMatch(/Emissor responsável/);
  });

  it("T24 429/5xx → retry controlado com o MESMO event_id; aceite registrado com trace id", async () => {
    await client.req("PATCH", `/v1/destinations/${destId}`, { purchase_emitter: "server" });
    received.length = 0;
    mode = ["429", "500", "ok"];
    await approve("RETRY");
    await drain(h);
    await runDue();
    await runDue();
    const [d] = await deliveriesFor("RETRY");
    expect(d.status).toBe("accepted");
    expect(d.attempts).toBe(3);
    expect(d.last_trace_id).toBe("TR200");
    const ids = new Set(received.map((r) => r.body.data[0]!.event_id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBe(d.event_id);
    // Payload: modo teste envia test_event_code; e-mail normalizado com hash; horário original.
    expect(received[0]!.body.test_event_code).toBe("TEST77");
    expect(received[0]!.path).toBe("/v24.0/123456789012345/events");
    expect(received[0]!.body.data[0]!.user_data.em).toEqual([createHash("sha256").update("comprador@exemplo.com").digest("hex")]);
    expect(received[0]!.body.data[0]!.user_data.ph).toEqual([createHash("sha256").update("5511999999999").digest("hex")]);
    const attempts = client.json(await client.req("GET", `/v1/deliveries/${d.id}/attempts`)).attempts;
    expect(attempts.map((a: { outcome: string }) => a.outcome)).toEqual(["retryable_error", "retryable_error", "accepted"]);
  });

  it("T25 timeout após envio → resultado desconhecido; repetição só com o mesmo event_id", async () => {
    received.length = 0;
    mode = ["hang", "ok"];
    await approve("TIMEOUT");
    await drain(h);
    let [d] = await deliveriesFor("TIMEOUT");
    expect(d.status).toBe("unknown_outcome");
    await runDue();
    [d] = await deliveriesFor("TIMEOUT");
    expect(d.status).toBe("accepted");
    expect(new Set(received.map((r) => r.body.data[0]!.event_id)).size).toBe(1);
  });

  it("T26 falha permanente num item não bloqueia nem repete os demais; T27 reprocessar não reenvia", async () => {
    received.length = 0;
    mode = ["400", "ok"];
    await approve("BAD-1");
    await approve("GOOD-1");
    await drain(h);
    const bad = (await deliveriesFor("BAD-1"))[0];
    const good = (await deliveriesFor("GOOD-1"))[0];
    expect(bad.status).toBe("rejected");
    expect(bad.last_provider_code).toBe("100");
    expect(good.status).toBe("accepted");
    const before = received.length;
    // Reprocessamento interno (novo attribution.compute e reentrega do mesmo webhook) não cria nova entrega.
    await approve("GOOD-1");
    await h.admin.query("update public.outbox set status = 'pending', available_at = now() where topic = 'attribution.compute'");
    await drain(h);
    expect(received.length).toBe(before);
    expect(await deliveriesFor("GOOD-1")).toHaveLength(1);
  });

  it("T68 organização de demonstração nunca envia a destinos reais", async () => {
    const orgId = client.orgId!;
    await h.admin.query("update public.organizations set is_demo = true where id = $1", [orgId]);
    try {
      received.length = 0;
      await approve("DEMO-1");
      await drain(h);
      const [d] = await deliveriesFor("DEMO-1");
      expect(d.status).toBe("not_eligible");
      expect(received).toHaveLength(0);
    } finally {
      await h.admin.query("update public.organizations set is_demo = false where id = $1", [orgId]);
    }
  });

  it("circuit breaker abre após falhas consecutivas e reagenda sem chamar o destino", async () => {
    received.length = 0;
    mode = ["500", "500", "500", "500", "500"];
    for (let i = 0; i < 5; i++) await approve(`CB-${i}`);
    await drain(h);
    const br = await h.admin.query("select state from public.circuit_breakers where organization_id = $1", [client.orgId]);
    expect(br.rows[0].state).toBe("open");
    const calls = received.length;
    await approve("CB-after");
    await drain(h);
    expect(received.length).toBe(calls);
    const [d] = await deliveriesFor("CB-after");
    expect(d.status).toBe("retry_scheduled");
  });
});

describe("relay outbox → BullMQ (Redis real)", () => {
  it("T23 Redis indisponível após commit: outbox preserva; ao voltar, trabalho é entregue e processado", async () => {
    const u = await signupVerified(h, "relay");
    const { projectId: pid } = await createOrg(u.client, "Relay Org");
    const c2 = await createConnection(u.client, pid, "lowify");
    const body = { event: "sale.paid", order_id: `ord_relay_${Date.now()}`, sale_amount: 10, status: "paid", timestamp: "2026-09-20 10:00:00", product: { id: 1, name: "P", price: 10, type: "main" }, customer: null, tracking: null };
    expect((await postWebhook(h, c2.token, body)).statusCode).toBe(200);

    // Redis indisponível (porta fechada): publicação falha e o item continua pendente.
    const deadRedis = new Redis("redis://127.0.0.1:1", { maxRetriesPerRequest: 0, lazyConnect: true, enableOfflineQueue: false, retryStrategy: () => null });
    const deadQueue = new Queue(`t23-dead-${Date.now()}`, { connection: deadRedis });
    deadQueue.on("error", () => undefined);
    const fail = await relayOnce(h.worker.pools.system, deadQueue, { batch: 1000 });
    expect(fail.error).not.toBeNull();
    const pending = await h.admin.query("select count(*)::int as n from public.outbox where organization_id = $1 and status = 'pending'", [u.client.orgId]);
    expect(pending.rows[0].n).toBe(1);
    await deadQueue.close().catch(() => undefined);
    deadRedis.disconnect();

    // Redis disponível: relay publica, worker BullMQ processa, venda aparece.
    const qname = `t23-live-${Date.now()}`;
    const conn = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
    const queue = new Queue(qname, { connection: conn });
    const processed: string[] = [];
    const w = new Worker(
      qname,
      async (job) => {
        const r = await dispatchOutboxItem(h.worker, job.data.organization_id, job.data.outbox_id);
        processed.push(r);
        return r;
      },
      { connection: conn.duplicate() },
    );
    try {
      let published = 0;
      for (let i = 0; i < 10 && published === 0; i++) {
        const ok = await relayOnce(h.worker.pools.system, queue, { batch: 1000 });
        expect(ok.error).toBeNull();
        published += ok.published;
      }
      expect(published).toBeGreaterThan(0);
      for (let i = 0; i < 100; i++) {
        const done = await h.admin.query("select count(*)::int as n from public.orders where organization_id = $1", [u.client.orgId]);
        if (done.rows[0].n === 1) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const orders = await h.admin.query("select approved_minor from public.orders where organization_id = $1", [u.client.orgId]);
      expect(orders.rows[0].approved_minor).toBe(1000n);
    } finally {
      await w.close();
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
      conn.disconnect();
    }
  });
});
