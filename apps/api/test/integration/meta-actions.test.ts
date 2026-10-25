import { randomUUID } from "node:crypto";
import { withTx } from "@tracker/db";
import { scheduleTicks } from "@tracker/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeMeta, sampleAccount, type FakeMeta } from "../fake-meta";
import { createHarness, createOrg, drain, signupVerified, type Client, type Harness } from "../helpers";

/**
 * Gerenciador de campanhas e ações na Meta (R25, R26) contra Graph API FALSA local: listagem com estado e métricas,
 * bloqueio enquanto a gestão não é liberada, pausar/ativar/orçamento/duplicar com confirmação por leitura,
 * idempotência, travas de orçamento, reconciliação após resposta perdida, limite de taxa, falha de permissão e regra
 * que pausa anúncio (respeitando a fase de aprendizado). Nenhuma chamada sai para a Meta real.
 */

let h: Harness;
let meta: FakeMeta;
let c: Client;
let orgId: string;
let today = "";
let yesterday = "";
const TOKEN = "EAAgestao1234567890abcdefghijkl";

const act = (body: Record<string, unknown>) => c.req("POST", "/v1/media/actions", { request_id: randomUUID(), ...body });
const fakeEntity = (level: "campaigns" | "adsets" | "ads", id: string) => meta.accounts.get("act_111")![level].find((e) => e.id === id)!;
const posts = (id: string) => meta.requests.filter((r) => r.method === "POST" && r.path === id).length;
const change = async (entity: string) => (await h.admin.query("select status, attempts, after, error, actor_type, rule_id from public.media_changes where organization_id = $1 and entity_id = $2 order by created_at desc limit 1", [orgId, entity])).rows[0];
/** Libera itens da outbox agendados para depois (novas tentativas) sem esperar o relógio real. */
const releaseRetries = () => h.admin.query("update public.outbox set available_at = now() - interval '1 second' where organization_id = $1 and status = 'pending'", [orgId]);

beforeAll(async () => {
  meta = await startFakeMeta("v26.0");
  h = await createHarness({ META_GRAPH_BASE_URL: meta.url, META_GRAPH_API_VERSION: "v26.0", ALLOW_EXTERNAL_DELIVERY: "true" });
  const u = await signupVerified(h, "metaact");
  c = u.client;
  ({ orgId } = await createOrg(c, "Gestão Org"));
  today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  meta.accounts.set("act_111", sampleAccount("act_111", [yesterday, today]));
  meta.tokens.set(TOKEN, { permissions: ["ads_read", "ads_management"], accounts: ["act_111"], userName: "Sistema" });
  expect((await c.req("POST", "/v1/meta/connect", { access_token: TOKEN })).statusCode).toBe(201);
  await drain(h);
  h.clock.now = new Date(Date.now() + 1000);
});
afterAll(async () => {
  await h?.close();
  await meta?.close();
});

describe("gerenciador de campanhas", () => {
  it("lista campanhas, conjuntos e anúncios com estado da Meta e métricas do período", async () => {
    const r = await c.req("GET", `/v1/media/entities?level=campaign&from=${yesterday}&to=${today}`);
    expect(r.statusCode, r.body).toBe(200);
    const g = c.json(r).groups[0];
    const c1 = g.rows.find((x: { id: string }) => x.id === "C1");
    expect(c1).toMatchObject({ name: "[VENDAS] Produto X", status: "ACTIVE", daily_budget_minor: "10000", spend_minor: "9050", manageable: true, account: { external_id: "act_111" } });
    // Sem venda confirmada: CPA indefinido (nunca zero), lucro negativo; compras reportadas pela Meta separadas.
    expect(c1.metrics.cpa).toMatchObject({ status: "undefined" });
    expect(c1.metrics.profit).toEqual({ status: "ok", value: "-9050" });
    expect(c1).toMatchObject({ reported_purchases: "2", reported_purchase_value_minor: "39400" });
    expect(c1.metrics.meta_roas).toEqual({ status: "ok", value: "4.35" });
    expect(g.totals.spend_minor).toBe("11550");
    const adsets = c.json(await c.req("GET", `/v1/media/entities?level=adset&from=${yesterday}&to=${today}`)).groups[0].rows;
    expect(adsets.find((x: { id: string }) => x.id === "S2")).toMatchObject({ learning_status: "LEARNING", campaign_name: "[TESTE] Público Y", daily_budget_minor: "5000" });
    const ads = c.json(await c.req("GET", `/v1/media/entities?level=ad&adset_id=S1&from=${yesterday}&to=${today}`)).groups[0].rows;
    expect(ads.map((x: { id: string }) => x.id).sort()).toEqual(["A1", "A2"]);
    expect(ads.find((x: { id: string }) => x.id === "A1")).toMatchObject({ adset_name: "Conjunto Aberto", campaign_name: "[VENDAS] Produto X" });
  });

  it("ações ficam bloqueadas até o proprietário liberar a gestão", async () => {
    const st = c.json(await c.req("GET", `/v1/media/entities?level=campaign&from=${today}&to=${today}`));
    expect(st.writes).toMatchObject({ enabled: false, reasons: [expect.stringMatching(/desligadas nesta organização/)] });
    const r = await act({ action: "pause", level: "campaign", entity_ids: ["C1"] });
    expect(r.statusCode).toBe(409);
    expect(c.json(r).error.code).toBe("capability_unavailable");
    expect(posts("C1")).toBe(0);
    expect((await c.req("PUT", "/v1/meta/settings", { media_writes: true })).statusCode).toBe(200);
    expect(c.json(await c.req("GET", "/v1/meta")).writes).toMatchObject({ enabled: true, reasons: [] });
  });

  it("pausa na Meta, confirma lendo de volta, atualiza o painel e registra o histórico (idempotente)", async () => {
    const request_id = randomUUID();
    const r = await c.req("POST", "/v1/media/actions", { action: "pause", level: "campaign", entity_ids: ["C1"], request_id });
    expect(r.statusCode, r.body).toBe(202);
    expect(c.json(r).results[0]).toMatchObject({ ok: true, summary: "Pausar" });
    await drain(h);
    expect(fakeEntity("campaigns", "C1").status).toBe("PAUSED");
    expect(await change("C1")).toMatchObject({ status: "succeeded", attempts: 1, actor_type: "user", after: { status: "PAUSED" } });
    expect(meta.requests.find((x) => x.method === "POST" && x.path === "C1")!.body).toEqual({ status: "PAUSED" });
    // Mesmo pedido repetido (duplo clique, nova tentativa do navegador): nenhuma escrita nova.
    const again = await c.req("POST", "/v1/media/actions", { action: "pause", level: "campaign", entity_ids: ["C1"], request_id });
    expect(c.json(again).results[0]).toMatchObject({ ok: true, duplicate: true });
    await drain(h);
    expect(posts("C1")).toBe(1);
    // Pedido novo sobre algo já pausado: nada a fazer.
    expect(c.json(await act({ action: "pause", level: "campaign", entity_ids: ["C1"] })).results[0]).toMatchObject({ ok: false, noop: true, error: "Já está pausada" });
    const rows = c.json(await c.req("GET", `/v1/media/entities?level=campaign&status=paused&from=${today}&to=${today}`)).groups[0].rows;
    expect(rows.map((x: { id: string }) => x.id)).toEqual(["C1"]);
    const hist = c.json(await c.req("GET", "/v1/media/changes")).changes;
    expect(hist[0]).toMatchObject({ entity_id: "C1", action: "pause", status: "succeeded", actor_type: "user", actor_name: expect.any(String), account_name: "Conta Loja" });
  });

  it("orçamento: percentual exato, mínimo da conta e nível errado são tratados", async () => {
    const r = c.json(await act({ action: "budget", level: "campaign", entity_ids: ["C1"], budget: { mode: "percent", value: "20" } })).results[0];
    expect(r).toMatchObject({ ok: true, summary: expect.stringMatching(/R\$\s100,00 → R\$\s120,00/) });
    await drain(h);
    expect(fakeEntity("campaigns", "C1").daily_budget).toBe("12000");
    expect((await h.admin.query("select daily_budget_minor::text as b from public.ad_entities where organization_id = $1 and external_id = 'C1'", [orgId])).rows[0].b).toBe("12000");
    expect(c.json(await act({ action: "budget", level: "campaign", entity_ids: ["C1"], budget: { mode: "absolute", value: "0.50" } })).results[0].error).toMatch(/mínimo da conta/);
    expect(c.json(await act({ action: "budget", level: "adset", entity_ids: ["S1"], budget: { mode: "absolute", value: "80" } })).results[0].error).toMatch(/está na campanha/);
    expect(c.json(await act({ action: "budget", level: "ad", entity_ids: ["A1"], budget: { mode: "absolute", value: "80" } })).results[0].error).toMatch(/Anúncio não tem orçamento/);
    expect(c.json(await act({ action: "pause", level: "campaign", entity_ids: ["NAOEXISTE"] })).results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/não encontrada/) });
  });

  it("resposta perdida após a escrita: reconcilia lendo a entidade, sem escrever de novo", async () => {
    meta.failNext.push({ match: /^POST C2$/, status: 0, error: {}, hang: true, apply: true });
    expect(c.json(await act({ action: "pause", level: "campaign", entity_ids: ["C2"] })).results[0].ok).toBe(true);
    await drain(h);
    expect(fakeEntity("campaigns", "C2").status).toBe("PAUSED");
    expect(await change("C2")).toMatchObject({ status: "unknown" });
    await releaseRetries();
    await drain(h);
    expect(await change("C2")).toMatchObject({ status: "succeeded", after: { status: "PAUSED", reconciled: true } });
    expect(posts("C2")).toBe(1);
  });

  it("limite de taxa: nova tentativa com espera; permissão negada: falha com motivo e aviso a quem pediu", async () => {
    meta.failNext.push({ match: /^POST C2$/, status: 400, error: { message: "(#17) User request limit reached", code: 17, type: "OAuthException" } });
    expect(c.json(await act({ action: "activate", level: "campaign", entity_ids: ["C2"] })).results[0].ok).toBe(true);
    await drain(h);
    expect(await change("C2")).toMatchObject({ status: "pending", error: expect.stringMatching(/limit/i) });
    expect(fakeEntity("campaigns", "C2").status).toBe("PAUSED");
    await releaseRetries();
    await drain(h);
    expect(await change("C2")).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(fakeEntity("campaigns", "C2").status).toBe("ACTIVE");

    meta.failNext.push({ match: /^POST A2$/, status: 403, error: { message: "(#200) Requires ads_management permission", code: 200, type: "OAuthException" } });
    await act({ action: "pause", level: "ad", entity_ids: ["A2"] });
    await drain(h);
    expect(await change("A2")).toMatchObject({ status: "failed", error: expect.stringMatching(/ads_management|permiss/i) });
    expect(fakeEntity("ads", "A2").status).toBe("ACTIVE");
    const n = c.json(await c.req("GET", "/v1/notifications")).notifications;
    expect(n.find((x: { title: string }) => x.title === "Alteração não aplicada: Imagem 2")).toBeTruthy();
  });

  it("duplicar cria cópia PAUSADA (com conjuntos e anúncios) e sincroniza a cópia", async () => {
    expect(c.json(await act({ action: "duplicate", level: "adset", entity_ids: ["S2"] })).results[0]).toMatchObject({ ok: true, summary: "Duplicar (cópia pausada)" });
    await drain(h);
    expect(meta.requests.find((x) => x.method === "POST" && x.path === "S2/copies")!.body).toEqual({ status_option: "PAUSED", deep_copy: true });
    const ch = await change("S2");
    expect(ch).toMatchObject({ status: "succeeded", after: { status: "PAUSED" } });
    const copy = (await h.admin.query("select name, status from public.ad_entities where organization_id = $1 and level = 'adset' and external_id = $2", [orgId, ch.after.copy_id])).rows[0];
    expect(copy).toMatchObject({ status: "PAUSED", name: "Conjunto Interesses - Cópia" });
  });

  it("regra com ação de pausar executa na Meta e respeita a fase de aprendizado", async () => {
    const def = {
      level: "ad",
      currency: "BRL",
      scope: { project_ids: [], network: null, name_contains: null, entity_ids: [] },
      evaluation: { period: "today", attribution_policy: "default", conversion_delay_hours: 0, min_spend: null, min_orders: null, min_impressions: null, min_age_days: 0, require_fresh_spend: true, exclude_learning: true },
      condition: { op: "and", items: [{ metric: "spend", op: "gte", value: "5" }, { metric: "approved_orders", op: "eq", value: "0" }] },
      actions: [{ type: "notify" }, { type: "pause" }],
      limits: { cooldown_minutes: 360, max_actions_per_day: 20, max_budget_change_pct: 20, budget_ceiling: null },
      schedule: { every_minutes: 60, active_hours: null },
      conflict: "skip",
    };
    const cat = c.json(await c.req("GET", "/v1/rules/catalog"));
    expect(cat.actions.find((a: { type: string }) => a.type === "pause")).toMatchObject({ availability: "active" });
    const id = c.json(await c.req("POST", "/v1/rules", { name: "Pausar anúncio sem venda", definition: def })).id;
    const sim = c.json(await c.req("POST", `/v1/rules/${id}/simulate`, {})).evaluations[0].entities;
    const byId = Object.fromEntries(sim.map((e: { id: string }) => [e.id, e]));
    expect(byId.A1.decision).toBe("would_execute");
    expect(byId.A3.decision).toBe("skip_learning");
    const a = await c.req("POST", `/v1/rules/${id}/activate`);
    expect(a.statusCode, a.body).toBe(200);
    await withTx(h.worker.pools.system, null, (cl) => scheduleTicks(cl, [orgId], new Date(h.clock.now.getTime() + 3_600_000)));
    await drain(h);
    expect(fakeEntity("ads", "A1").status).toBe("PAUSED");
    expect(fakeEntity("ads", "A3").status).toBe("ACTIVE");
    expect(await change("A1")).toMatchObject({ status: "succeeded", actor_type: "rule", rule_id: id });
    const ra = (await h.admin.query("select status, media_change_id from public.rule_actions where rule_id = $1 and entity_id = 'A1' and action_type = 'pause'", [id])).rows[0];
    expect(ra.status).toBe("executed");
    expect(ra.media_change_id).toBeTruthy();
  });
});
