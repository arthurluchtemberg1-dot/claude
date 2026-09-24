import { signCanonicalBody } from "@tracker/connectors";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConnection, createHarness, createOrg, drain, postWebhook, signupVerified, type Client, type Harness } from "../helpers";

/**
 * Bases temporais (R22-02) com renovação, recompra e estorno posterior; coorte de aquisição com LTV observado
 * (R16-11, R22): renovações não são creditadas à aquisição fora da coorte; a coorte acompanha o cliente.
 *
 * Linha do tempo (fuso da organização, America/Sao_Paulo):
 *   B: 20/07 primeira compra 1.500 · 15/08 segunda compra 2.000       (adquirido em julho)
 *   A: 10/08 primeira compra 4.990 (pedido A1, origem paga validada) · 05/09 recompra 3.000 (A2, sem origem)
 *      10/09 renovação de A1 4.990 · 12/09 estorno integral da transação inicial de A1 (4.990)
 */

let h: Harness;
let c: Client;
const uid = () => Math.random().toString(36).slice(2, 8);

async function send(conn: { token: string; signing_secret: string }, body: Record<string, unknown>) {
  const raw = JSON.stringify({ schema_version: "1.0", source: { provider: "erp", event_id: `evt-${uid()}` }, ...body });
  const r = await postWebhook(h, conn.token, raw, { "x-tracker-signature": signCanonicalBody(conn.signing_secret, raw, Math.floor(h.clock.now.getTime() / 1000)) });
  expect(r.statusCode).toBe(200);
}

async function summary(qs: string) {
  const r = await c.req("GET", `/v1/metrics/summary?${qs}`);
  expect(r.statusCode, r.body).toBe(200);
  const g = c.json(r).groups[0];
  return { m: Object.fromEntries(g.metrics.map((x: { id: string }) => [x.id, x])) as Record<string, any>, notes: g.notes as string[] };
}

beforeAll(async () => {
  h = await createHarness();
  const u = await signupVerified(h, "bases");
  c = u.client;
  const { projectId } = await createOrg(c, "Bases Org");
  await c.req("PATCH", "/v1/org/cost-policy", { declared_zero: ["impostos", "custo de produto"] });
  // Campanha com ID validado (importada) e gasto por conta em agosto e setembro.
  const acc = c.json(await c.req("POST", "/v1/ad-accounts", { project_id: projectId, network: "meta", external_account_id: `act_${uid()}`, name: "Conta", currency: "BRL", timezone: "America/Sao_Paulo" })).id;
  for (const [level, csv, mapping] of [
    ["campaign", "data;id;nome;gasto\n2026-08-10;777;Aquisição;50,00\n", { date: "data", entity_id: "id", entity_name: "nome", spend: "gasto" }],
    ["account", "data;gasto\n2026-09-05;10,00\n", { date: "data", spend: "gasto" }],
  ] as const) {
    const p = c.json(await c.req("POST", "/v1/imports/spend/preview", { ad_account_id: acc, level, csv, mapping }));
    expect((await c.req("POST", `/v1/imports/${p.import_id}/commit`)).statusCode).toBe(200);
  }
  const conn = await createConnection(c, projectId, "custom");
  const order = (ext: string, extra: Record<string, unknown> = {}) => ({ external_order_id: ext, currency: "BRL", ...extra });
  const b1 = `B1-${uid()}`;
  const b2 = `B2-${uid()}`;
  const a1 = `A1-${uid()}`;
  const a2 = `A2-${uid()}`;
  await send(conn, { event_type: "payment.approved", occurred_at: "2026-07-20T12:00:00-03:00", order: order(b1, { amount_minor: 1500 }), customer: { email: "b@cliente.test" } });
  await send(conn, { event_type: "payment.approved", occurred_at: "2026-08-15T12:00:00-03:00", order: order(b2, { amount_minor: 2000 }), customer: { email: "b@cliente.test" } });
  await send(conn, {
    event_type: "payment.approved",
    occurred_at: "2026-08-10T12:00:00-03:00",
    order: order(a1, { external_transaction_id: `${a1}-t1`, amount_minor: 4990 }),
    customer: { email: "a@cliente.test" },
    attribution: { utm_source: "facebook", utm_medium: "paid_social", campaign_id: "777" },
  });
  await send(conn, { event_type: "payment.approved", occurred_at: "2026-09-05T12:00:00-03:00", order: order(a2, { amount_minor: 3000 }), customer: { email: "A@Cliente.test" } });
  await send(conn, { event_type: "subscription.renewed", occurred_at: "2026-09-10T12:00:00-03:00", order: order(a1, { external_transaction_id: `${a1}-t2`, amount_minor: 4990 }) });
  await send(conn, { event_type: "refund.succeeded", occurred_at: "2026-09-12T12:00:00-03:00", order: order(a1, { external_transaction_id: `${a1}-t1` }), refund: { external_refund_id: `r-${uid()}`, amount_minor: 4990, semantics: "full" } });
  await drain(h);
  h.clock.now = new Date(Date.now() + 1000);
});
afterAll(async () => h.close());

describe("bases temporais", () => {
  it("por aprovação: cada transação no seu período; estorno posterior ajusta a venda original; renovação fora da receita atribuída", async () => {
    const aug = await summary("from=2026-08-01&to=2026-08-31&basis=approval");
    expect(aug.m.approved_orders_gross.value).toBe("2"); // A1 e B2
    expect(aug.m.gross_approved_revenue.amount_minor).toBe("6990");
    expect(aug.m.financial_reversals.amount_minor).toBe("4990"); // estorno de setembro ajusta a venda de agosto (as_of)
    expect(aug.m.roas_gross).toMatchObject({ status: "ok", value: "0.998" }); // 4.990 atribuídos / 5.000

    const sep = await summary("from=2026-09-01&to=2026-09-23&basis=approval");
    expect(sep.m.approved_orders_gross.value).toBe("1"); // A2 (renovação não é novo pedido)
    expect(sep.m.gross_approved_revenue.amount_minor).toBe("7990"); // recompra + renovação
    expect(sep.m.financial_reversals.amount_minor).toBe("0");
    expect(sep.m.roas_gross).toMatchObject({ status: "ok", value: "0" }); // renovação não creditada à aquisição
    expect(sep.notes.join(" ")).toMatch(/Renovações \(49\.90\)/);
    expect(sep.m.customers_acquired.status).toBe("undefined");
  });

  it("por movimento financeiro: lançamentos na data em que ocorreram", async () => {
    const sep = await summary("from=2026-09-01&to=2026-09-23&basis=financial_movement");
    expect(sep.m.gross_approved_revenue.amount_minor).toBe("7990");
    expect(sep.m.financial_reversals.amount_minor).toBe("4990");
    expect(sep.m.revenue_after_reversals.amount_minor).toBe("3000");
  });

  it("por coorte: clientes adquiridos no período, receita posterior até as_of creditada pela primeira compra e LTV observado", async () => {
    const aug = await summary("from=2026-08-01&to=2026-08-31&basis=acquisition_cohort");
    expect(aug.m.customers_acquired.value).toBe("1"); // A (B foi adquirido em julho)
    expect(aug.m.approved_orders_gross.value).toBe("2"); // A1 e A2
    expect(aug.m.gross_approved_revenue.amount_minor).toBe("12980"); // 4.990 + 3.000 + 4.990
    expect(aug.m.financial_reversals.amount_minor).toBe("4990");
    expect(aug.m.ltv_observed).toMatchObject({ status: "ok", amount_minor: "7990" });
    expect(aug.m.ltv_observed.notes.join(" ")).toMatch(/não é previsão/);
    expect(aug.m.roas_gross).toMatchObject({ status: "ok", value: "2.596" }); // 12.980 da coorte / 5.000 da aquisição
    expect(aug.notes.join(" ")).toMatch(/1 cliente\(s\) com primeira compra no período/);
    const jul = await summary("from=2026-07-01&to=2026-07-31&basis=acquisition_cohort");
    expect(jul.m.customers_acquired.value).toBe("1");
    expect(jul.m.gross_approved_revenue.amount_minor).toBe("3500"); // B: 1.500 + 2.000
    const sepCohort = await summary("from=2026-09-01&to=2026-09-23&basis=acquisition_cohort");
    expect(sepCohort.m.customers_acquired.value).toBe("0");
    expect(sepCohort.m.ltv_observed.status).toBe("undefined");
  });

  it("série diária e campanhas seguem a mesma regra (renovação no dia dela; fora da receita da campanha)", async () => {
    const ts = c.json(await c.req("GET", "/v1/metrics/timeseries?from=2026-09-01&to=2026-09-23"));
    const byDay = Object.fromEntries(ts.days.map((d: { day: string }) => [d.day, d]));
    expect(byDay["2026-09-10"]).toMatchObject({ gross: "4990", approved_orders: 0 });
    expect(byDay["2026-09-05"]).toMatchObject({ gross: "3000", approved_orders: 1 });
    const camp = c.json(await c.req("GET", "/v1/reports/breakdown?dimension=campaign&from=2026-09-01&to=2026-09-23")).groups[0];
    expect(camp.totals.gross_minor).toBe("7990");
    expect(camp.rows.find((r: { id: string }) => r.id === "777")?.attributed_gross_minor ?? "0").toBe("0");
    expect(camp.notes.join(" ")).toMatch(/Renovações/);
  });
});
