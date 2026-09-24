import { signCanonicalBody } from "@tracker/connectors";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConnection, createHarness, createOrg, drain, postWebhook, signupVerified, type Client, type Harness } from "../helpers";

/**
 * T16 (upsell com outra transação e vínculo comprovado) e T18 (parcelas/recebíveis/liquidações não são novas compras),
 * pelo pipeline real: webhook canônico assinado → recebimento → worker → pedido/razão → atribuição → API.
 */

let h: Harness;
let client: Client;
let projectId: string;
let publicKey: string;
beforeAll(async () => {
  h = await createHarness();
  const u = await signupVerified(h, "links");
  client = u.client;
  ({ projectId, publicKey } = await createOrg(client, "Links Org"));
});
afterAll(async () => h.close());

const uid = () => Math.random().toString(36).slice(2, 10);
const rid = (n = 22) => Array.from({ length: n }, () => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 62)]).join("");

function canonical(over: Record<string, unknown>): Record<string, any> {
  return { schema_version: "1.0", source: { provider: "erp", event_id: `evt-${uid()}` }, occurred_at: new Date().toISOString(), ...over };
}

async function send(conn: { token: string; signing_secret: string }, body: unknown) {
  const raw = JSON.stringify(body);
  const r = await postWebhook(h, conn.token, raw, { "x-tracker-signature": signCanonicalBody(conn.signing_secret, raw, Math.floor(h.clock.now.getTime() / 1000)) });
  expect(r.statusCode).toBe(200);
  return r.json();
}

async function orderByExternal(c: Client, ext: string) {
  const list = c.json(await c.req("GET", `/v1/orders?q=${encodeURIComponent(ext)}&include_test=true`)).orders;
  return list.find((o: { external_order_id: string }) => o.external_order_id === ext);
}

async function detail(c: Client, id: string) {
  const r = await c.req("GET", `/v1/orders/${id}`);
  expect(r.statusCode).toBe(200);
  return c.json(r);
}

const approved = (ext: string, amount: number, extra: Record<string, unknown> = {}, attribution?: Record<string, unknown>) =>
  canonical({
    event_type: "payment.approved",
    order: { external_order_id: ext, external_transaction_id: `${ext}-tx`, currency: "BRL", amount_minor: amount, payment_method: "credit_card", ...extra },
    ...(attribution ? { attribution } : {}),
  });

describe("T16 upsell com outra transação e vínculo comprovado", () => {
  it("vincula ao pedido original na mesma conta, gera registro próprio e um Purchase por transação", async () => {
    const conn = await createConnection(client, projectId, "custom");
    const parent = `p-${uid()}`;
    const up = `u-${uid()}`;
    await send(conn, approved(parent, 19700));
    await send(conn, approved(up, 4700, { parent_order_id: parent, transaction_kind: "upsell" }));
    await drain(h);

    const p = await orderByExternal(client, parent);
    const u = await orderByExternal(client, up);
    expect(u.id).not.toBe(p.id);
    const du = await detail(client, u.id);
    expect(du.order.parent_order_id).toBe(p.id);
    expect(du.parent_order).toMatchObject({ id: p.id, external_order_id: parent });
    expect(du.transactions).toEqual([expect.objectContaining({ kind: "upsell", status: "approved", amount_minor: "4700" })]);
    const dp = await detail(client, p.id);
    expect(dp.child_orders.map((o: { id: string }) => o.id)).toEqual([u.id]);
    expect(dp.parent_order).toBeNull();
    // Cada venda tem seu lançamento de aprovação (sem somar duas vezes a mesma cobrança).
    expect(dp.ledger.filter((l: { entry_type: string }) => l.entry_type === "approval").map((l: { amount_minor: string }) => l.amount_minor)).toEqual(["19700"]);
    expect(du.ledger.filter((l: { entry_type: string }) => l.entry_type === "approval").map((l: { amount_minor: string }) => l.amount_minor)).toEqual(["4700"]);
    const fan = await h.admin.query("select dedup_key from public.outbox where topic = 'destinations.fanout' and payload->>'order_id' = any($1)", [[p.id, u.id]]);
    expect(fan.rows.length).toBe(2);
  });

  it("upsell recebido antes do pedido original: vínculo pendente resolvido na chegada do original (idempotente)", async () => {
    const conn = await createConnection(client, projectId, "custom");
    const parent = `p-${uid()}`;
    const up = `u-${uid()}`;
    const upEvent = approved(up, 2990, { parent_order_id: parent, transaction_kind: "upsell" });
    await send(conn, upEvent);
    await drain(h);
    const pending = (await h.admin.query("select parent_order_id, parent_external_order_id from public.orders where external_order_id = $1", [up])).rows[0];
    expect(pending).toEqual({ parent_order_id: null, parent_external_order_id: parent });

    await send(conn, approved(parent, 9990));
    await send(conn, upEvent); // reenvio do upsell não altera nada
    await drain(h);
    const p = await orderByExternal(client, parent);
    const u = await orderByExternal(client, up);
    const du = await detail(client, u.id);
    expect(du.order.parent_order_id).toBe(p.id);
    expect(du.ledger.filter((l: { entry_type: string }) => l.entry_type === "approval")).toHaveLength(1);
  });

  it("R10-07 mesmo e-mail sem declaração da origem não cria vínculo; conta de outro provedor também não", async () => {
    const connA = await createConnection(client, projectId, "custom");
    const connB = await createConnection(client, projectId, "custom");
    const a = `a-${uid()}`;
    const b = `b-${uid()}`;
    const customer = { email: "mesmo@cliente.test", name: "Mesmo Cliente" };
    await send(connA, { ...approved(a, 5000), customer });
    await send(connA, { ...approved(b, 3000), customer });
    // Declaração aponta para um pedido que só existe em OUTRA conta lógica: não vincula.
    const c = `c-${uid()}`;
    await send(connB, approved(c, 1500, { parent_order_id: a, transaction_kind: "upsell" }));
    await drain(h);
    const rows = (await h.admin.query("select external_order_id, parent_order_id, parent_external_order_id from public.orders where external_order_id = any($1) order by external_order_id", [[a, b, c]])).rows;
    expect(rows).toEqual([
      { external_order_id: a, parent_order_id: null, parent_external_order_id: null },
      { external_order_id: b, parent_order_id: null, parent_external_order_id: null },
      { external_order_id: c, parent_order_id: null, parent_external_order_id: a },
    ]);
  });

  it("declaração divergente de pedido original posterior preserva o vínculo e registra conflito; auto-referência vai para quarentena", async () => {
    const conn = await createConnection(client, projectId, "custom");
    const parent = `p-${uid()}`;
    const other = `o-${uid()}`;
    const up = `u-${uid()}`;
    await send(conn, approved(parent, 10000));
    await send(conn, approved(other, 10000));
    await send(conn, approved(up, 2000, { parent_order_id: parent, transaction_kind: "upsell" }));
    await send(conn, canonical({ event_type: "payment.approved", order: { external_order_id: up, external_transaction_id: `${up}-tx`, currency: "BRL", amount_minor: 2000, parent_order_id: other } }));
    const selfRef = `s-${uid()}`;
    const q = await send(conn, approved(selfRef, 100, { parent_order_id: selfRef }));
    await drain(h);
    const u = await orderByExternal(client, up);
    const p = await orderByExternal(client, parent);
    const du = await detail(client, u.id);
    expect(du.order.parent_order_id).toBe(p.id);
    expect(du.conflicts.map((c: { code: string }) => c.code)).toContain("parent_mismatch");
    const rec = (await h.admin.query("select status, status_reason from public.webhook_receipts where id = $1", [q.receipt_id])).rows[0];
    expect(rec.status).toBe("quarantined");
    expect(rec.status_reason).toMatch(/parent_order_id/);
  });

  it("upsell sem token herda o vínculo por token do pedido original (em qualquer ordem de chegada)", async () => {
    const conn = await createConnection(client, projectId, "custom");
    const aid = rid();
    const collected = await h.app.inject({
      method: "POST",
      url: "/v1/collect",
      headers: { "content-type": "text/plain", origin: "https://loja.exemplo.test", "user-agent": "Mozilla/5.0 teste" },
      payload: JSON.stringify({
        v: 1,
        pk: publicKey,
        aid,
        sid: rid(16),
        consent: { analytics: true, ads: true, storage: true },
        ctx: { url: "https://loja.exemplo.test/oferta?utm_source=facebook&utm_medium=paid_social&utm_campaign=Campanha%20Upsell", ref: null },
        events: [{ id: rid(20), name: "PageView", ts: Date.now() - 60_000 }],
        token_request: true,
      }),
    });
    expect(collected.statusCode).toBe(200);
    const token = collected.json().token as string;

    // Ordem invertida: upsell (sem token, com UTM declarada diferente) chega antes do original com token.
    const parent = `p-${uid()}`;
    const up = `u-${uid()}`;
    await send(conn, approved(up, 3700, { parent_order_id: parent, transaction_kind: "upsell" }, { utm_source: "google", utm_medium: "cpc", utm_campaign: "outra" }));
    await drain(h);
    const u = await orderByExternal(client, up);
    let du = await detail(client, u.id);
    expect(du.attributions.find((a: { is_current: boolean }) => a.is_current).evidence).toBe("checkout_source");

    await send(conn, approved(parent, 19700, {}, { tracking_token: token }));
    await drain(h);
    const p = await orderByExternal(client, parent);
    const dp = await detail(client, p.id);
    expect(dp.attributions.find((a: { is_current: boolean }) => a.is_current)).toMatchObject({ evidence: "token_link", utm_source: "facebook" });

    du = await detail(client, u.id);
    const cur = du.attributions.find((a: { is_current: boolean }) => a.is_current);
    expect(cur).toMatchObject({ evidence: "token_link", utm_source: "facebook", category: "paid" });
    expect(cur.reason).toMatch(/herdado do pedido original/);
    expect(cur.recalculation_of).toBeTruthy(); // nova versão; histórico preservado
    expect(du.visitor_links).toEqual([expect.objectContaining({ evidence: "parent_order", inherited_from_order_id: p.id })]);
    // Recalcular atribuição nunca dispara Purchase adicional (R16-07).
    const fan = await h.admin.query("select count(*)::int as n from public.outbox where topic = 'destinations.fanout' and payload->>'order_id' = $1", [u.id]);
    expect(fan.rows[0].n).toBe(1);
  });
});

describe("T18 parcelas, recebíveis e liquidações", () => {
  it("parcelamento e repasses não geram nova compra nem receita; repetição não duplica recebível", async () => {
    // Organização própria para medir métricas sem interferência dos outros cenários.
    const u2 = await signupVerified(h, "settle");
    const { projectId: p2 } = await createOrg(u2.client, "Settlement Org");
    const conn = await createConnection(u2.client, p2, "custom");
    const ext = `ord-${uid()}`;
    const tx = `${ext}-tx`;
    const order = { external_order_id: ext, external_transaction_id: tx, currency: "BRL" };
    await send(conn, canonical({ event_type: "payment.approved", order: { ...order, amount_minor: 30000, payment_method: "credit_card", installments: 3 } }));
    const due = (m: number) => new Date(Date.now() + m * 30 * 86_400_000).toISOString();
    for (const n of [1, 2, 3]) {
      await send(conn, canonical({
        event_type: "settlement.scheduled",
        order,
        settlement: { external_settlement_id: `${tx}-p${n}`, installment_number: n, installment_count: 3, gross_amount_minor: 10000, fee_minor: 500, net_amount_minor: 9500, expected_at: due(n) },
      }));
    }
    // Mesmo recebível reenviado com outro ID de evento: não duplica.
    await send(conn, canonical({ event_type: "settlement.scheduled", order, settlement: { external_settlement_id: `${tx}-p1`, installment_number: 1, installment_count: 3, net_amount_minor: 9500 } }));
    // Liquidação da 1ª parcela e aprovação repetida (notificação por parcela) sem novo valor.
    await send(conn, canonical({ event_type: "settlement.paid", order, settlement: { external_settlement_id: `${tx}-p1`, installment_number: 1, installment_count: 3, net_amount_minor: 9500 } }));
    await send(conn, canonical({ event_type: "payment.approved", order: { ...order, amount_minor: 30000, installments: 3 } }));
    // Repasse de um pedido desconhecido: registrado, sem venda aprovada fabricada.
    const unknown = `ord-${uid()}`;
    await send(conn, canonical({ event_type: "settlement.paid", order: { external_order_id: unknown, currency: "BRL" }, settlement: { external_settlement_id: `${unknown}-s`, net_amount_minor: 5000 } }));
    await drain(h);

    const o = await orderByExternal(u2.client, ext);
    const d = await detail(u2.client, o.id);
    expect(d.transactions).toEqual([expect.objectContaining({ status: "approved", amount_minor: "30000", installments: 3 })]);
    expect(d.ledger.map((l: { entry_type: string; amount_minor: string }) => [l.entry_type, l.amount_minor])).toEqual([["approval", "30000"]]);
    expect(d.settlements.map((s: { stage: string; installment_number: number; net_minor: string }) => [s.stage, s.installment_number, s.net_minor])).toEqual([
      ["paid", 1, "9500"],
      ["scheduled", 1, "9500"],
      ["scheduled", 2, "9500"],
      ["scheduled", 3, "9500"],
    ]);
    const unk = (await u2.client.json(await u2.client.req("GET", `/v1/orders?q=${unknown}&include_test=true`))).orders[0];
    expect(unk).toMatchObject({ financial_status: "pending", approved_minor: "0" });

    // Métricas "até agora": o relógio do harness avança para depois dos eventos enviados.
    h.clock.now = new Date(Date.now() + 1000);
    const org = u2.client.json(await u2.client.req("GET", "/v1/org"));
    const day = new Date().toLocaleDateString("sv-SE", { timeZone: org.timezone });
    for (const basis of ["approval", "financial_movement"]) {
      const s = u2.client.json(await u2.client.req("GET", `/v1/metrics/summary?from=${day}&to=${day}&basis=${basis}`));
      const m = Object.fromEntries(s.groups[0].metrics.map((x: { id: string }) => [x.id, x]));
      expect(m.gross_approved_revenue.amount_minor).toBe("30000");
      expect(Number(m.approved_orders_gross.value)).toBe(1);
    }
    const fan = await h.admin.query("select count(*)::int as n from public.outbox where topic = 'destinations.fanout' and payload->>'order_id' = $1", [o.id]);
    expect(fan.rows[0].n).toBe(1);
  });

  it("recebível sem objeto settlement vai para quarentena", async () => {
    const conn = await createConnection(client, projectId, "custom");
    const r = await send(conn, canonical({ event_type: "settlement.paid", order: { external_order_id: `x-${uid()}`, currency: "BRL" } }));
    await drain(h);
    const rec = (await h.admin.query("select status, status_reason from public.webhook_receipts where id = $1", [r.receipt_id])).rows[0];
    expect(rec).toMatchObject({ status: "quarantined" });
    expect(rec.status_reason).toMatch(/settlement/);
  });
});
