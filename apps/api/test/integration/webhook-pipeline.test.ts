import { readFileSync } from "node:fs";
import { join } from "node:path";
import { signCanonicalBody } from "@tracker/connectors";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConnection, createHarness, createOrg, drain, postWebhook, signupVerified, type Client, type Harness } from "../helpers";

const documented = JSON.parse(readFileSync(join(import.meta.dirname, "../../../../packages/connectors/test/fixtures/lowify/documented-example.json"), "utf8"));

let h: Harness;
let client: Client;
let projectId: string;
beforeAll(async () => {
  h = await createHarness();
  const u = await signupVerified(h, "pipeline");
  client = u.client;
  ({ projectId } = await createOrg(client, "Pipeline Org"));
  await client.req("PATCH", "/v1/org/cost-policy", { declared_zero: ["impostos", "custo de produto"] });
});
afterAll(async () => h.close());

const lowify = (over: Record<string, unknown> = {}) => ({ ...documented, order_id: `ord_${Math.random().toString(36).slice(2, 10)}`, ...over });

function canonical(over: Record<string, unknown>): Record<string, any> {
  return {
    schema_version: "1.0",
    source: { provider: "erp", event_id: `evt-${Math.random().toString(36).slice(2)}` },
    occurred_at: new Date().toISOString(),
    ...over,
  };
}

async function sendCanonical(token: string, secret: string, body: unknown) {
  const raw = JSON.stringify(body);
  const sig = signCanonicalBody(secret, raw, Math.floor(h.clock.now.getTime() / 1000));
  return postWebhook(h, token, raw, { "x-tracker-signature": sig });
}

async function orderByExternal(ext: string) {
  const list = client.json(await client.req("GET", `/v1/orders?q=${encodeURIComponent(ext)}&include_test=true`)).orders;
  return list.find((o: { external_order_id: string }) => o.external_order_id === ext);
}

describe("pipeline Lowify (exemplo documentado)", () => {
  it("T01 venda aprovada autenticada pela URL → uma venda com valor correto", async () => {
    const conn = await createConnection(client, projectId, "lowify");
    const body = lowify();
    const r = await postWebhook(h, conn.token, body, { "idempotency-key": `${body.order_id}:sale.paid:321` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ received: true, duplicate: false });
    await drain(h);
    const order = await orderByExternal(body.order_id);
    expect(order).toMatchObject({ financial_status: "approved", approved_minor: "19990", currency: "BRL" });
    const detail = client.json(await client.req("GET", `/v1/orders/${order.id}`));
    expect(detail.ledger).toHaveLength(1);
    // Dados pessoais mascarados por padrão; revelar exige pii.read e é auditado.
    expect(detail.customer.masked).toBe(true);
    const revealed = client.json(await client.req("GET", `/v1/orders/${order.id}?reveal=true`));
    expect(revealed.customer).toMatchObject({ masked: false, email: "cliente@dominio.com" });
    expect(detail.order.declared_tracking.utm.source).toBe("facebook");
    const conns = client.json(await client.req("GET", "/v1/connections")).connections;
    expect(conns.find((c: { id: string }) => c.id === conn.id).status).toBe("connected");
  });

  it("T02/T03 mesmo evento várias vezes e em paralelo → uma atualização financeira", async () => {
    const conn = await createConnection(client, projectId, "lowify");
    const body = lowify();
    const results = await Promise.all(Array.from({ length: 5 }, () => postWebhook(h, conn.token, body)));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(results.filter((r) => r.json().duplicate === false)).toHaveLength(1);
    await drain(h);
    await postWebhook(h, conn.token, body);
    await drain(h);
    const order = await orderByExternal(body.order_id);
    const detail = client.json(await client.req("GET", `/v1/orders/${order.id}`));
    expect(detail.ledger.filter((l: { entry_type: string }) => l.entry_type === "approval")).toHaveLength(1);
    expect(detail.receipts[0].delivery_count).toBe(6);
  });

  it("T06 + bump: pendente não soma; itens por produto na mesma venda sem nova compra (T15)", async () => {
    const conn = await createConnection(client, projectId, "lowify");
    const id = `ord_bump_${Date.now()}`;
    await postWebhook(h, conn.token, lowify({ order_id: id, event: "sale.pending", status: "pending", sale_amount: 219.8 }));
    await drain(h);
    let order = await orderByExternal(id);
    expect(order.financial_status).toBe("pending");
    expect(order.approved_minor).toBe("0");
    await postWebhook(h, conn.token, lowify({ order_id: id, sale_amount: 219.8 }));
    await postWebhook(h, conn.token, lowify({ order_id: id, sale_amount: 219.8, product: { id: 555, name: "Bump", price: 19.9, type: "bump" } }));
    await drain(h);
    order = await orderByExternal(id);
    expect(order).toMatchObject({ financial_status: "approved", approved_minor: "21980" });
    const detail = client.json(await client.req("GET", `/v1/orders/${order.id}`));
    expect(detail.items).toHaveLength(2);
    expect(detail.ledger.filter((l: { entry_type: string }) => l.entry_type === "approval")).toHaveLength(1);
  });

  it("T08 pendente atrasado não rebaixa; T13-like reembolso integral registrado", async () => {
    const conn = await createConnection(client, projectId, "lowify");
    const id = `ord_late_${Date.now()}`;
    await postWebhook(h, conn.token, lowify({ order_id: id, timestamp: "2026-03-10 14:30:00" }));
    await postWebhook(h, conn.token, lowify({ order_id: id, event: "sale.pending", status: "pending", timestamp: "2026-03-10 14:00:00" }));
    await drain(h);
    let order = await orderByExternal(id);
    expect(order.financial_status).toBe("approved");
    await postWebhook(h, conn.token, lowify({ order_id: id, event: "sale.refunded", status: "refunded", timestamp: "2026-03-12 10:00:00" }));
    await drain(h);
    order = await orderByExternal(id);
    expect(order).toMatchObject({ financial_status: "fully_reversed", reversed_minor: "19990" });
  });

  it("T19 token inválido ou endpoint revogado: rejeitado sem alterar finanças", async () => {
    const r = await postWebhook(h, "whk_" + "x".repeat(40), lowify());
    expect(r.statusCode).toBe(404);
    const conn = await createConnection(client, projectId, "lowify");
    await client.req("DELETE", `/v1/connections/${conn.id}/endpoints/${conn.endpoint_id}`);
    expect((await postWebhook(h, conn.token, lowify())).statusCode).toBe(404);
    const wrongType = await h.app.inject({ method: "POST", url: `/v1/webhooks/${conn.token}`, headers: { "content-type": "text/plain" }, payload: "x" });
    expect([404, 415]).toContain(wrongType.statusCode);
  });

  it("T20 schema desconhecido/valor ausente → quarentena visível, sem venda", async () => {
    const conn = await createConnection(client, projectId, "lowify");
    const id = `ord_q_${Date.now()}`;
    const { sale_amount: _x, ...noAmount } = lowify({ order_id: id });
    await postWebhook(h, conn.token, noAmount);
    await postWebhook(h, conn.token, lowify({ order_id: `${id}b`, event: "sale.chargeback" }));
    await postWebhook(h, conn.token, "{not json");
    await drain(h);
    expect(await orderByExternal(id)).toBeUndefined();
    const q = client.json(await client.req("GET", "/v1/diagnostics/receipts?status=quarantined")).receipts;
    expect(q.length).toBeGreaterThanOrEqual(3);
    const overview = client.json(await client.req("GET", "/v1/diagnostics/overview"));
    expect(overview.alerts.map((a: { code: string }) => a.code)).toContain("quarantined_receipts");
  });

  it("T05 reconexão/dois endpoints da mesma conta lógica não criam nova venda", async () => {
    const account = `lowify-seller-${Date.now()}`;
    const c1 = await createConnection(client, projectId, "lowify", { account_external_id: account });
    const c2 = await createConnection(client, projectId, "lowify", { account_external_id: account });
    expect(c2.provider_account_id).toBe(c1.provider_account_id);
    const rot = client.json(await client.req("POST", `/v1/connections/${c1.id}/endpoints`, {}));
    const token3 = String(rot.webhook_url).split("/").pop()!;
    const body = lowify();
    await postWebhook(h, c1.token, body);
    await postWebhook(h, c2.token, body);
    await postWebhook(h, token3, body);
    await drain(h);
    const list = client.json(await client.req("GET", `/v1/orders?q=${body.order_id}`)).orders;
    expect(list).toHaveLength(1);
  });

  it("URL do webhook e segredo não reaparecem na listagem (R09-21)", async () => {
    const conn = await createConnection(client, projectId, "custom");
    expect(conn.signing_secret).toMatch(/^whsec_/);
    const listRaw = (await client.req("GET", "/v1/connections")).body;
    expect(listRaw).not.toContain(conn.token);
    expect(listRaw).not.toContain(conn.signing_secret);
  });
});

describe("pipeline canônico assinado e fixture financeira via API", () => {
  it("T21 organização falsa no corpo é ignorada; T19 assinatura inválida rejeitada", async () => {
    const conn = await createConnection(client, projectId, "custom");
    const body = canonical({ organization_id: "00000000-0000-0000-0000-000000000000", event_type: "payment.approved", order: { external_order_id: `T21-${Date.now()}`, currency: "BRL", amount_minor: 1000 } });
    const bad = await postWebhook(h, conn.token, body, { "x-tracker-signature": signCanonicalBody("segredo-errado", JSON.stringify(body), Math.floor(Date.now() / 1000)) });
    expect(bad.statusCode).toBe(401);
    expect((await sendCanonical(conn.token, conn.signing_secret, body)).statusCode).toBe(200);
    await drain(h);
    const order = await orderByExternal((body.order as { external_order_id: string }).external_order_id);
    expect(order.approved_minor).toBe("1000");
    const overview = client.json(await client.req("GET", "/v1/diagnostics/overview"));
    expect(overview.rejections.length).toBeGreaterThan(0);
  });

  it("R43-02 fixture obrigatória ponta a ponta: webhooks repetidos mantêm exatamente os resultados", async () => {
    const u = await signupVerified(h, "fixture");
    const { projectId: pid } = await createOrg(u.client, "Fixture Org");
    await u.client.req("PATCH", "/v1/org/cost-policy", { declared_zero: ["impostos", "custo de produto"] });
    const conn = await createConnection(u.client, pid, "custom");
    const day = "2026-09-10";
    const events = [
      canonical({ source: { event_id: "A-paid" }, event_type: "payment.approved", occurred_at: `${day}T13:00:00Z`, order: { external_order_id: "A", external_transaction_id: "A-tx", currency: "BRL", amount_minor: 10000, fee_minor: 300 }, attribution: { utm_source: "facebook", utm_medium: "paid_social", utm_campaign: "fixture" } }),
      canonical({ source: { event_id: "B-paid" }, event_type: "payment.approved", occurred_at: `${day}T14:00:00Z`, order: { external_order_id: "B", external_transaction_id: "B-tx", currency: "BRL", amount_minor: 5000, fee_minor: 200 }, attribution: { utm_source: "facebook", utm_medium: "paid_social", utm_campaign: "fixture" } }),
      canonical({ source: { event_id: "A-refund" }, event_type: "refund.succeeded", occurred_at: "2026-09-12T13:00:00Z", order: { external_order_id: "A", external_transaction_id: "A-tx", currency: "BRL" }, refund: { external_refund_id: "A-r1", amount_minor: 2000, semantics: "incremental" } }),
      canonical({ source: { event_id: "B-refund" }, event_type: "refund.succeeded", occurred_at: "2026-09-13T13:00:00Z", order: { external_order_id: "B", external_transaction_id: "B-tx", currency: "BRL" }, refund: { external_refund_id: "B-r1", semantics: "full" } }),
    ];
    // Investimento R$30 por importação CSV de gasto diário.
    const acc = u.client.json(await u.client.req("POST", "/v1/ad-accounts", { network: "meta", external_account_id: "act_fixture", name: "Conta Fixture", currency: "BRL", timezone: "America/Sao_Paulo" }));
    const preview = u.client.json(
      await u.client.req("POST", "/v1/imports/spend/preview", { ad_account_id: acc.id, level: "account", csv: `data;gasto\n${day};30,00\n`, mapping: { date: "data", spend: "gasto" } }),
    );
    expect(preview).toMatchObject({ row_count: 1, error_count: 0, total_spend: "30.00" });
    await u.client.req("POST", `/v1/imports/${preview.import_id}/commit`, {});

    for (let round = 0; round < 3; round++) {
      for (const e of events) expect((await sendCanonical(conn.token, conn.signing_secret, e)).statusCode).toBe(200);
      await drain(h);
    }
    const sres = await u.client.req("GET", `/v1/metrics/summary?from=${day}&to=${day}&basis=approval`);
    if (sres.statusCode !== 200) throw new Error(sres.body);
    const summary = u.client.json(sres);
    const m = Object.fromEntries(summary.groups[0].metrics.map((x: { id: string }) => [x.id, x]));
    expect(m.gross_approved_revenue.amount_minor).toBe("15000");
    expect(m.financial_reversals.amount_minor).toBe("7000");
    expect(m.revenue_after_reversals.amount_minor).toBe("8000");
    expect(m.approved_orders_gross.value).toBe("2");
    expect(m.retained_orders.value).toBe("1");
    expect(m.cpa_approved.amount_minor).toBe("1500");
    expect(m.cpa_retained.amount_minor).toBe("3000");
    expect(m.avg_ticket_gross.amount_minor).toBe("7500");
    expect(m.roas_gross.value).toBe("5");
    expect(m.roas_after_reversals.fraction).toEqual({ num: "8000", den: "3000" });
    expect(m.fees.amount_minor).toBe("500");
    expect(m.contribution_after_media.amount_minor).toBe("4500");
    expect(m.contribution_after_media.quality).toBe("complete");
    expect(m.media_spend.amount_minor).toBe("3000");
    // Período maior que a cobertura do gasto importado → parcial, com a razão explícita (R21-04).
    const wide = u.client.json(await u.client.req("GET", `/v1/metrics/summary?from=${day}&to=2026-09-30`));
    const wideSpend = wide.groups[0].metrics.find((x: { id: string }) => x.id === "media_spend");
    expect(wideSpend.quality).toBe("partial");
    expect(wideSpend.notes.join(" ")).toMatch(/Conta Fixture/);

    // T45 reimportar o mesmo gasto não soma.
    const again = u.client.json(await u.client.req("POST", "/v1/imports/spend/preview", { ad_account_id: acc.id, level: "account", csv: `data;gasto\n${day};30,00\n`, mapping: { date: "data", spend: "gasto" } }));
    expect(again.will_replace_existing).toBe(1);
    await u.client.req("POST", `/v1/imports/${again.import_id}/commit`, {});
    const s2 = u.client.json(await u.client.req("GET", `/v1/metrics/summary?from=${day}&to=2026-09-30`));
    expect(s2.groups[0].metrics.find((x: { id: string }) => x.id === "media_spend").amount_minor).toBe("3000");

    // Base por movimento financeiro difere e não é apresentada como igual (R22-02).
    const mov = u.client.json(await u.client.req("GET", `/v1/metrics/summary?from=2026-09-12&to=2026-09-13&basis=financial_movement`));
    const mm = Object.fromEntries(mov.groups[0].metrics.map((x: { id: string }) => [x.id, x]));
    expect(mm.gross_approved_revenue.amount_minor).toBe("0");
    expect(mm.financial_reversals.amount_minor).toBe("7000");
  });

  it("T09/T11/T12 reembolso repetido, chargeback sobre mesma perda e disputa ganha via webhook", async () => {
    const conn = await createConnection(client, projectId, "custom");
    const ext = `CB-${Date.now()}`;
    const base = { order: { external_order_id: ext, external_transaction_id: `${ext}-tx`, currency: "BRL", amount_minor: 10000 } };
    const send = (e: Record<string, unknown>) => sendCanonical(conn.token, conn.signing_secret, canonical({ ...base, ...e }));
    await send({ event_type: "payment.approved" });
    const refund = canonical({ ...base, source: { event_id: `${ext}-r` }, event_type: "refund.succeeded", refund: { external_refund_id: "r1", amount_minor: 3000, semantics: "incremental" } });
    await sendCanonical(conn.token, conn.signing_secret, refund);
    await sendCanonical(conn.token, conn.signing_secret, { ...refund, source: { event_id: `${ext}-r-dup` } }); // outro event id, mesmo reembolso
    await send({ event_type: "chargeback.confirmed", dispute: { external_dispute_id: "d1", amount_minor: 3000, covers_refund_id: "r1" } });
    await send({ event_type: "chargeback.confirmed", dispute: { external_dispute_id: "d2", amount_minor: 7000 } });
    await send({ event_type: "dispute.won", dispute: { external_dispute_id: "d2", amount_minor: 7000 } });
    await drain(h);
    const order = await orderByExternal(ext);
    const detail = client.json(await client.req("GET", `/v1/orders/${order.id}`));
    const sum = (t: string) => detail.ledger.filter((l: { entry_type: string }) => l.entry_type === t).reduce((a: bigint, l: { amount_minor: string }) => a + BigInt(l.amount_minor), 0n);
    expect(sum("refund")).toBe(-3000n);
    expect(sum("chargeback")).toBe(-7000n);
    expect(sum("chargeback_reversal")).toBe(7000n);
    expect(order.financial_status).toBe("partially_reversed");
    expect(order.reversed_minor).toBe("3000");
  });

  it("T17 renovação separada e T13 estorno antes do pagamento conciliado", async () => {
    const conn = await createConnection(client, projectId, "custom");
    const ext = `SUB-${Date.now()}`;
    await sendCanonical(conn.token, conn.signing_secret, canonical({ event_type: "refund.succeeded", occurred_at: "2026-09-20T10:05:00Z", order: { external_order_id: ext, external_transaction_id: `${ext}-c1`, currency: "BRL" }, refund: { external_refund_id: "early", amount_minor: 1000, semantics: "incremental" } }));
    await drain(h);
    let order = await orderByExternal(ext);
    expect(order.financial_status).toBe("reversal_pending_reconciliation");
    expect(order.approved_minor).toBe("0");
    await sendCanonical(conn.token, conn.signing_secret, canonical({ event_type: "payment.approved", occurred_at: "2026-09-20T10:00:00Z", order: { external_order_id: ext, external_transaction_id: `${ext}-c1`, currency: "BRL", amount_minor: 4990 } }));
    await sendCanonical(conn.token, conn.signing_secret, canonical({ event_type: "subscription.renewed", occurred_at: "2026-10-20T10:00:00Z", order: { external_order_id: ext, external_transaction_id: `${ext}-c2`, currency: "BRL", amount_minor: 4990 } }));
    await drain(h);
    order = await orderByExternal(ext);
    const detail = client.json(await client.req("GET", `/v1/orders/${order.id}`));
    expect(detail.ledger.map((l: { entry_type: string; revenue_kind: string }) => `${l.entry_type}:${l.revenue_kind}`)).toEqual(["approval:initial", "refund:initial", "approval:renewal"]);
  });

  it("T22 falha no meio do processamento não perde nem duplica; T27 reprocessamento não gera novo fanout", async () => {
    const conn = await createConnection(client, projectId, "custom");
    const ext = `CRASH-${Date.now()}`;
    await sendCanonical(conn.token, conn.signing_secret, canonical({ event_type: "payment.approved", order: { external_order_id: ext, currency: "BRL", amount_minor: 777 } }));
    // Simula queda: trigger que falha na inserção do razão desta organização.
    await h.admin.query(`create or replace function public.fail_once() returns trigger language plpgsql as $$ begin if new.transaction_key like '%${ext}%' then raise exception 'queda simulada do worker'; end if; return new; end $$`);
    await h.admin.query("create trigger fail_once before insert on public.financial_entries for each row execute function public.fail_once()");
    try {
      await drain(h);
    } finally {
      await h.admin.query("drop trigger fail_once on public.financial_entries");
    }
    expect(await orderByExternal(ext)).toBeUndefined(); // transação desfeita
    await h.admin.query("update public.outbox set available_at = now() where dedup_key like 'receipt:%' and status = 'pending'");
    await drain(h);
    const order = await orderByExternal(ext);
    expect(order.approved_minor).toBe("777");
    const fanouts = await h.admin.query("select count(*)::int as n from public.outbox where dedup_key like $1", [`fanout:${order.id}%`]);
    expect(fanouts.rows[0].n).toBe(1);
    // Reprocessar manualmente um recebimento já processado é recusado; quarentenado pode ser reprocessado.
    const detail = client.json(await client.req("GET", `/v1/orders/${order.id}`));
    const rr = await client.req("POST", `/v1/diagnostics/receipts/${detail.receipts[0].id}/reprocess`, {});
    expect(rr.statusCode).toBe(400);
  });

  it("T66 exportação neutraliza fórmulas; vendas manuais auditadas e distintas do checkout", async () => {
    const r = await client.req("POST", "/v1/orders/manual", { project_id: projectId, external_order_id: "=HYPERLINK(\"http://x\")", amount_minor: 5000, currency: "BRL", occurred_at: new Date().toISOString(), reference: "Comprovante 123" });
    expect(r.statusCode).toBe(202);
    await drain(h);
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const csv = await client.req("GET", `/v1/exports/orders.csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv.body).not.toMatch(/(^|,)=HYPERLINK/m);
    const logs = client.json(await client.req("GET", "/v1/audit-logs")).entries.map((e: { action: string }) => e.action);
    expect(logs).toContain("order.manual_created");
    expect(logs).toContain("export.orders_csv");
    const order = await orderByExternal("=HYPERLINK(\"http://x\")");
    expect(order.provider).toBe("manual");
  });
});
