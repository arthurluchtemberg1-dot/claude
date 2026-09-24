import { signCanonicalBody } from "@tracker/connectors";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConnection, createHarness, createOrg, drain, postWebhook, signupVerified, type Client, type Harness } from "../helpers";

/**
 * T39 (renomear campanha preserva junção por ID), T46 (níveis mistos de gasto sem multiplicar) e R06-07
 * (membro restrito a projeto não vê dados de outro projeto em nenhuma superfície).
 */

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

const uid = () => Math.random().toString(36).slice(2, 10);

async function send(conn: { token: string; signing_secret: string }, body: Record<string, unknown>) {
  const raw = JSON.stringify({ schema_version: "1.0", source: { provider: "erp", event_id: `evt-${uid()}` }, ...body });
  const r = await postWebhook(h, conn.token, raw, { "x-tracker-signature": signCanonicalBody(conn.signing_secret, raw, Math.floor(Date.now() / 1000)) });
  expect(r.statusCode).toBe(200);
}

const sale = (ext: string, amount: number, occurredAt: string, attribution: Record<string, unknown>) => ({
  event_type: "payment.approved",
  occurred_at: occurredAt,
  order: { external_order_id: ext, currency: "BRL", amount_minor: amount, payment_method: "pix" },
  attribution,
});

async function importSpend(c: Client, adAccountId: string, level: string, csv: string, mapping: Record<string, string>) {
  const p = await c.req("POST", "/v1/imports/spend/preview", { ad_account_id: adAccountId, level, csv, mapping });
  expect(p.statusCode, p.body).toBe(200);
  const prev = c.json(p);
  expect(prev.error_count).toBe(0);
  const cm = await c.req("POST", `/v1/imports/${prev.import_id}/commit`);
  expect(cm.statusCode, cm.body).toBe(200);
}

async function adAccount(c: Client, projectId: string, name: string) {
  const r = await c.req("POST", "/v1/ad-accounts", { project_id: projectId, network: "meta", external_account_id: `act_${uid()}`, name, currency: "BRL", timezone: "America/Sao_Paulo" });
  expect(r.statusCode, r.body).toBe(201);
  return c.json(r).id as string;
}

async function breakdown(c: Client, qs: string) {
  const r = await c.req("GET", `/v1/reports/breakdown?${qs}`);
  expect(r.statusCode, r.body).toBe(200);
  return c.json(r).groups[0];
}

const byId = (rows: { id: string | null }[]) => Object.fromEntries(rows.map((r) => [r.id ?? "(sem id)", r])) as Record<string, any>;

describe("T39 campanha renomeada", () => {
  it("gasto e vendas de nomes diferentes permanecem no mesmo ID; nome vigente é o mais recente", async () => {
    const u = await signupVerified(h, "t39");
    const { projectId } = await createOrg(u.client, "T39 Org");
    const acc = await adAccount(u.client, projectId, "Conta Meta T39");
    await importSpend(
      u.client,
      acc,
      "campaign",
      "data;campanha_id;campanha;gasto\n2026-09-10;120000000000001;Campanha Antiga;100,00\n2026-09-10;120000000000002;Outra;30,00\n2026-09-11;120000000000001;Campanha Nova;50,00\n",
      { date: "data", entity_id: "campanha_id", entity_name: "campanha", spend: "gasto" },
    );
    const conn = await createConnection(u.client, projectId, "custom");
    const paid = { utm_source: "facebook", utm_medium: "paid_social" };
    await send(conn, sale(`A-${uid()}`, 19700, "2026-09-10T15:00:00-03:00", { ...paid, utm_campaign: "Campanha Antiga|120000000000001" }));
    await send(conn, sale(`B-${uid()}`, 9700, "2026-09-11T10:00:00-03:00", { ...paid, utm_campaign: "Campanha Nova|120000000000001" }));
    await send(conn, sale(`C-${uid()}`, 5000, "2026-09-11T11:00:00-03:00", { ...paid, campaign_id: "999999" }));
    await drain(h);

    const g = await breakdown(u.client, "dimension=campaign&from=2026-09-10&to=2026-09-11");
    const rows = byId(g.rows);
    expect(rows["120000000000001"]).toMatchObject({
      name: "Campanha Nova",
      previous_names: ["Campanha Antiga"],
      known_entity: true,
      entity_source: "csv",
      spend_minor: "15000",
      orders: 2,
      orders_credit: "2",
      attributed_gross_minor: "29400",
      roas_gross: { status: "ok", value: "1.96" },
      cpa_minor: { status: "ok", value: "7500" },
    });
    expect(rows["120000000000002"]).toMatchObject({ name: "Outra", spend_minor: "3000", orders: 0, roas_gross: { status: "ok", value: "0" }, cpa_minor: { status: "undefined" } });
    // ID declarado sem gasto importado: indisponível, nunca zero.
    expect(rows["999999"]).toMatchObject({ known_entity: false, spend_minor: null, orders: 1, roas_gross: { status: "unavailable" } });
    expect(g.totals).toMatchObject({ spend_minor: "18000", allocated_spend_minor: "18000", approved_orders: 3, gross_minor: "34400" });

    // A lista de vendas mostra a campanha pela junção de ID, não pelo nome declarado.
    const orders = u.client.json(await u.client.req("GET", "/v1/orders")).orders;
    expect(orders.filter((o: { campaign_id: string }) => o.campaign_id === "120000000000001")).toHaveLength(2);
  });
});

describe("T46 campanha, conjunto, anúncio e conta no mesmo período", () => {
  it("um nível por conta e dia no total; detalhamento agrega antes de combinar com vendas", async () => {
    const u = await signupVerified(h, "t46");
    const { projectId } = await createOrg(u.client, "T46 Org");
    await u.client.req("PATCH", "/v1/org/cost-policy", { declared_zero: ["impostos", "custo de produto"] });
    const acc = await adAccount(u.client, projectId, "Conta Meta T46");
    await importSpend(u.client, acc, "account", "data;gasto\n2026-09-10;150,00\n", { date: "data", spend: "gasto" });
    await importSpend(u.client, acc, "campaign", "data;id;nome;gasto\n2026-09-10;C1;Camp 1;100,00\n2026-09-10;C2;Camp 2;50,00\n", { date: "data", entity_id: "id", entity_name: "nome", spend: "gasto" });
    await importSpend(
      u.client,
      acc,
      "ad",
      "data;anuncio;nome;campanha;gasto;impressoes\n2026-09-10;A1;Anúncio 1;C1;60,00;1000\n2026-09-10;A2;Anúncio 2;C1;40,00;500\n2026-09-10;A3;Anúncio 3;C2;50,00;700\n2026-09-11;A1;Anúncio 1;C1;20,00;300\n",
      { date: "data", entity_id: "anuncio", entity_name: "nome", campaign_id: "campanha", spend: "gasto", impressions: "impressoes" },
    );
    const conn = await createConnection(u.client, projectId, "custom");
    await send(conn, sale(`S-${uid()}`, 20000, "2026-09-11T12:00:00-03:00", { utm_source: "facebook", utm_medium: "paid_social", campaign_id: "C1", ad_id: "A1" }));
    await drain(h);

    // Resumo: 10/09 usa o nível conta (150), 11/09 só tem anúncio (20) → 170, sem somar níveis.
    const s = u.client.json(await u.client.req("GET", "/v1/metrics/summary?from=2026-09-10&to=2026-09-11"));
    const spend = s.groups[0].metrics.find((m: { id: string }) => m.id === "media_spend");
    expect(spend.amount_minor).toBe("17000");

    // Campanha: 10/09 nível campanha (C1 100, C2 50); 11/09 anúncios agregados por campanha (C1 +20).
    const camp = await breakdown(u.client, "dimension=campaign&from=2026-09-10&to=2026-09-11");
    const cr = byId(camp.rows);
    expect(cr.C1).toMatchObject({ spend_minor: "12000", orders: 1, attributed_gross_minor: "20000", roas_gross: { value: "1.6667" } });
    expect(cr.C2).toMatchObject({ spend_minor: "5000", orders: 0 });
    expect(camp.totals).toMatchObject({ spend_minor: "17000", allocated_spend_minor: "17000", approved_orders: 1 });
    expect(camp.notes.join(" ")).not.toMatch(/não distribuído/);

    // Anúncio: somente linhas de anúncio; impressões por entidade; drill-down pela campanha.
    const ads = byId((await breakdown(u.client, "dimension=ad&from=2026-09-10&to=2026-09-11")).rows);
    expect(ads.A1).toMatchObject({ spend_minor: "8000", impressions: "1300", orders: 1, attributed_gross_minor: "20000" });
    expect(ads.A2).toMatchObject({ spend_minor: "4000" });
    const drill = await breakdown(u.client, "dimension=ad&from=2026-09-10&to=2026-09-11&campaign_id=C1");
    expect(drill.rows.map((r: { id: string }) => r.id).sort()).toEqual(["A1", "A2"]);

    // Conjunto: nenhum gasto nesse nível → total não distribuído é explicitado, não inventado.
    const adsets = await breakdown(u.client, "dimension=adset&from=2026-09-10&to=2026-09-11");
    expect(adsets.totals).toMatchObject({ spend_minor: "17000", allocated_spend_minor: "0" });
    expect(adsets.notes.join(" ")).toMatch(/não distribuído/);

    // Rede: mesma regra do resumo.
    const net = byId((await breakdown(u.client, "dimension=network&from=2026-09-10&to=2026-09-11")).rows);
    expect(net.meta.spend_minor).toBe("17000");
  });
});

describe("R06-07 membro restrito a projeto", () => {
  it("não enxerga pedidos, métricas, detalhamentos, conexões nem exportações de outro projeto", async () => {
    const owner = await signupVerified(h, "owner-proj");
    const { orgId, projectId: p1 } = await createOrg(owner.client, "Projetos Org");
    const p2r = await owner.client.req("POST", "/v1/projects", { name: "Projeto 2" });
    expect(p2r.statusCode, p2r.body).toBe(201);
    const p2 = owner.client.json(p2r).id as string;
    const c1 = await createConnection(owner.client, p1, "custom");
    const c2 = await createConnection(owner.client, p2, "custom");
    const o1 = `P1-${uid()}`;
    const o2 = `P2-${uid()}`;
    await send(c1, sale(o1, 1000, "2026-09-10T12:00:00-03:00", { utm_source: "google", utm_medium: "cpc" }));
    await send(c2, sale(o2, 7000, "2026-09-10T12:00:00-03:00", { utm_source: "google", utm_medium: "cpc" }));
    await drain(h);

    const analyst = await signupVerified(h, "restrito");
    await owner.client.req("POST", "/v1/invites", { email: analyst.email, role: "analyst" });
    const token = new URL([...h.emails].reverse().find((m) => m.to === analyst.email && m.kind === "invite")!.actionUrl!).searchParams.get("token")!;
    expect((await analyst.client.req("POST", "/v1/invites/accept", { token })).statusCode).toBe(200);
    analyst.client.orgId = orgId;
    const members = owner.client.json(await owner.client.req("GET", "/v1/members")).members;
    const m = members.find((x: { user_id: string }) => x.user_id === analyst.userId);
    expect((await owner.client.req("PUT", `/v1/members/${m.id}/projects`, { project_ids: ["00000000-0000-4000-8000-000000000000"] })).statusCode).toBe(400);
    expect((await owner.client.req("PUT", `/v1/members/${m.id}/projects`, { project_ids: [p1] })).statusCode).toBe(200);

    const a = analyst.client;
    expect(a.json(await a.req("GET", "/v1/projects")).projects.map((p: { id: string }) => p.id)).toEqual([p1]);
    const orders = a.json(await a.req("GET", "/v1/orders")).orders.map((o: { external_order_id: string }) => o.external_order_id);
    expect(orders).toEqual([o1]);
    const ownerOrders = owner.client.json(await owner.client.req("GET", "/v1/orders")).orders;
    const other = ownerOrders.find((o: { external_order_id: string }) => o.external_order_id === o2);
    expect((await a.req("GET", `/v1/orders/${other.id}`)).statusCode).toBe(403);
    expect((await a.req("GET", `/v1/orders?project_id=${p2}`)).statusCode).toBe(403);

    const sum = a.json(await a.req("GET", "/v1/metrics/summary?from=2026-09-10&to=2026-09-10"));
    expect(sum.groups[0].metrics.find((x: { id: string }) => x.id === "gross_approved_revenue").amount_minor).toBe("1000");
    expect((await a.req("GET", `/v1/metrics/summary?from=2026-09-10&to=2026-09-10&project_id=${p2}`)).statusCode).toBe(403);
    const ts = a.json(await a.req("GET", "/v1/metrics/timeseries?from=2026-09-10&to=2026-09-10"));
    expect(JSON.stringify(ts)).not.toContain("7000");
    const bd = await breakdown(a, "dimension=network&from=2026-09-10&to=2026-09-10");
    expect(bd.totals).toMatchObject({ approved_orders: 1, gross_minor: "1000" });
    expect((await a.req("GET", `/v1/reports/breakdown?from=2026-09-10&to=2026-09-10&project_id=${p2}`)).statusCode).toBe(403);

    const csv = await a.req("GET", "/v1/exports/orders.csv?from=2026-09-01T00:00:00Z&to=2026-09-30T00:00:00Z");
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain(o1);
    expect(csv.body).not.toContain(o2);

    const conns = a.json(await a.req("GET", "/v1/connections")).connections.map((x: { project_id: string }) => x.project_id);
    expect(conns.every((pid: string) => pid === p1)).toBe(true);
    const receipts = await a.req("GET", "/v1/diagnostics/receipts");
    if (receipts.statusCode === 200) {
      expect(JSON.stringify(a.json(receipts))).not.toContain(o2);
    } else {
      expect(receipts.statusCode).toBe(403);
    }
  });
});
