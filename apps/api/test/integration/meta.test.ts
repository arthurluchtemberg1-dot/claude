import { withTx } from "@tracker/db";
import { scheduleTicks } from "@tracker/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeMeta, sampleAccount, type FakeMeta } from "../fake-meta";
import { createHarness, createOrg, drain, signupVerified, type Client, type Harness } from "../helpers";

/**
 * Integração Meta (R19, R21) contra Graph API FALSA local: conexão por token validada, contas e ativos,
 * sincronização de entidades (estado, orçamento, aprendizagem) e insights em 3 níveis com paginação, gasto no
 * painel e por campanha, compras reportadas separadas, alertas de conta e de token, reconexão e desconexão.
 */

let h: Harness;
let meta: FakeMeta;
let c: Client;
let orgId: string;
let today = "";
let yesterday = "";
const GOOD = "EAAtokenvalido1234567890abcdef";
const READONLY = "EAAtokenleitura1234567890abcd";

beforeAll(async () => {
  meta = await startFakeMeta("v26.0");
  h = await createHarness({ META_GRAPH_BASE_URL: meta.url, META_GRAPH_API_VERSION: "v26.0" });
  const u = await signupVerified(h, "meta");
  c = u.client;
  ({ orgId } = await createOrg(c, "Meta Org"));
  today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  meta.accounts.set("act_111", sampleAccount("act_111", [yesterday, today]));
  meta.accounts.set("act_222", { ...sampleAccount("act_222", [yesterday, today]), name: "Conta Antiga", account_status: 2, campaigns: [], adsets: [], ads: [], spend: {} });
  meta.tokens.set(GOOD, { permissions: ["ads_read", "ads_management", "business_management"], accounts: ["act_111", "act_222"], userName: "Sistema Loja" });
  meta.tokens.set(READONLY, { permissions: ["ads_read"], accounts: ["act_111"], userName: "Leitor" });
  meta.tokens.set("EAAsempermissao1234567890abcdef", { permissions: ["public_profile"], accounts: ["act_111"], userName: "Sem" });
});
afterAll(async () => {
  await h?.close();
  await meta?.close();
});

describe("conexão Meta", () => {
  it("token inválido ou sem permissão de anúncios é recusado sem gravar nada", async () => {
    const bad = await c.req("POST", "/v1/meta/connect", { access_token: "EAAinvalido1234567890abcdefgh" });
    expect(bad.statusCode).toBe(400);
    expect(c.json(bad).error.code).toBe("meta_auth");
    const noPerm = await c.req("POST", "/v1/meta/connect", { access_token: "EAAsempermissao1234567890abcdef" });
    expect(noPerm.statusCode).toBe(400);
    expect(c.json(noPerm).error.message).toMatch(/ads_read/);
    expect(c.json(await c.req("GET", "/v1/meta")).connection).toBeNull();
  });

  it("conecta, lista contas (com paginação) e nunca devolve o token", async () => {
    const r = await c.req("POST", "/v1/meta/connect", { access_token: GOOD });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.body).not.toContain(GOOD);
    const body = c.json(r);
    expect(body).toMatchObject({ meta_user: { name: "Sistema Loja" }, permissions: expect.arrayContaining(["ads_management"]) });
    expect(body.accounts.map((a: { id: string }) => a.id).sort()).toEqual(["act_111", "act_222"]);
    const raw = await c.req("GET", "/v1/meta");
    expect(raw.statusCode, raw.body).toBe(200);
    const st = c.json(raw);
    expect(st.connection).toMatchObject({ status: "connected", permissions: expect.arrayContaining(["ads_read"]) });
    // Conta ativa sincroniza por padrão; conta desativada (status 2) fica desligada.
    expect(st.accounts.map((a: { external_account_id: string; sync_enabled: boolean }) => [a.external_account_id, a.sync_enabled]).sort()).toEqual([["act_111", true], ["act_222", false]]);
    expect(st.writes).toMatchObject({ enabled: false, reasons: expect.arrayContaining([expect.stringMatching(/desligadas nesta organização/)]) });
    const cred = (await h.admin.query("select ciphertext from private.credentials where organization_id = $1 and purpose = 'oauth_access_token' and revoked_at is null", [orgId])).rows;
    expect(cred).toHaveLength(1);
    expect(cred[0].ciphertext).not.toContain(GOOD);
  });

  it("sincroniza entidades, aprendizagem, gasto diário em 3 níveis, pixels e páginas", async () => {
    await drain(h);
    const acc = (await h.admin.query("select id, account_status, amount_spent_minor::text, spend_cap_minor::text, synced_to::text, last_sync_error from public.ad_accounts where organization_id = $1 and external_account_id = 'act_111'", [orgId])).rows[0];
    expect(acc).toMatchObject({ account_status: 1, amount_spent_minor: "95000", spend_cap_minor: "100000", synced_to: today, last_sync_error: null });
    const ents = (await h.admin.query("select level, external_id, status, daily_budget_minor::text, learning_status, campaign_external_id from public.ad_entities where organization_id = $1 order by level, external_id", [orgId])).rows;
    expect(ents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "campaign", external_id: "C1", status: "ACTIVE", daily_budget_minor: "10000" }),
        expect.objectContaining({ level: "adset", external_id: "S2", daily_budget_minor: "5000", learning_status: "LEARNING", campaign_external_id: "C2" }),
        expect.objectContaining({ level: "ad", external_id: "A3", campaign_external_id: "C2" }),
      ]),
    );
    // Paginação: a conta falsa devolve 2 itens por página (3 anúncios exigem 2 páginas).
    expect(meta.requests.filter((r) => r.path === "act_111/ads").length).toBeGreaterThanOrEqual(2);
    expect(meta.requests.find((r) => r.path === "act_111/insights")!.query).toMatchObject({ level: "campaign", time_increment: "1" });
    const spend = (await h.admin.query("select level, entity_external_id, spend_date::text, spend_minor::text, reported_purchases::text, reported_purchase_value_minor::text from public.ad_spend_daily where organization_id = $1 and source = 'api' order by level, entity_external_id, spend_date", [orgId])).rows;
    expect(spend.filter((s) => s.level === "campaign" && s.entity_external_id === "C1").map((s) => s.spend_minor)).toEqual(["6050", "3000"]);
    expect(spend.find((s) => s.level === "ad" && s.entity_external_id === "A1" && s.spend_date === yesterday)).toMatchObject({ reported_purchases: "2", reported_purchase_value_minor: "39400" });
    const st = c.json(await c.req("GET", "/v1/meta"));
    expect(st.pixels).toEqual([expect.objectContaining({ external_id: "PX1", name: "Pixel Loja" })]);
    expect(st.pages).toEqual([expect.objectContaining({ external_id: "PG1" })]);
  });

  it("gasto sincronizado aparece no painel e no detalhamento por campanha (nomes da Meta)", async () => {
    h.clock.now = new Date(Date.now() + 1000);
    const s = c.json(await c.req("GET", `/v1/metrics/summary?from=${yesterday}&to=${today}`));
    const m = Object.fromEntries(s.groups[0].metrics.map((x: { id: string }) => [x.id, x]));
    expect(m.media_spend.amount_minor).toBe("11550");
    const b = c.json(await c.req("GET", `/v1/reports/breakdown?dimension=campaign&from=${yesterday}&to=${today}`)).groups[0];
    expect(b.rows.find((r: { id: string }) => r.id === "C1")).toMatchObject({ name: "[VENDAS] Produto X", spend_minor: "9050" });
    const ads = c.json(await c.req("GET", `/v1/reports/breakdown?dimension=ad&from=${yesterday}&to=${today}`)).groups[0];
    expect(ads.rows.find((r: { id: string }) => r.id === "A1")).toMatchObject({ name: "Vídeo 1", spend_minor: "7000" });
  });

  it("nova sincronização substitui o snapshot (correção tardia da Meta não duplica)", async () => {
    meta.accounts.get("act_111")!.spend[today] = { A1: "35.00", A3: "10.00" };
    expect((await c.req("POST", "/v1/meta/sync", {})).statusCode).toBe(200);
    await drain(h);
    const row = (await h.admin.query("select spend_minor::text from public.ad_spend_daily where organization_id = $1 and level = 'campaign' and entity_external_id = 'C1' and spend_date = $2", [orgId, today])).rows;
    expect(row).toEqual([{ spend_minor: "3500" }]);
  });

  it("alertas: limite de gasto perto do fim e conta com problema", async () => {
    await withTx(h.worker.pools.system, null, (cl) => scheduleTicks(cl, [orgId], new Date(Date.now() + 3_600_000)));
    await drain(h);
    const n = c.json(await c.req("GET", "/v1/notifications")).notifications;
    expect(n.find((x: { kind: string }) => x.kind === "balance.low")).toMatchObject({ title: "Limite de gasto quase no fim: Conta Loja" });
    expect(n.find((x: { kind: string }) => x.kind === "balance.low").body).toMatch(/Restam R\$\s50,00 do limite de R\$\s1\.000,00/);
    // Conta desativada só alerta se estiver sincronizando.
    const a2 = c.json(await c.req("GET", "/v1/meta")).accounts.find((a: { external_account_id: string }) => a.external_account_id === "act_222");
    expect((await c.req("PUT", `/v1/meta/accounts/${a2.id}`, { sync_enabled: true })).statusCode).toBe(200);
    await c.req("POST", "/v1/meta/sync", {});
    await drain(h);
    await withTx(h.worker.pools.system, null, (cl) => scheduleTicks(cl, [orgId], new Date(Date.now() + 7_200_000)));
    await drain(h);
    const n2 = c.json(await c.req("GET", "/v1/notifications")).notifications;
    expect(n2.find((x: { kind: string }) => x.kind === "ad_account.issue")).toMatchObject({ title: "Conta de anúncios desativada: Conta Antiga" });
  });

  it("token revogado na Meta: conexão marcada, aviso enviado; reconectar restabelece", async () => {
    meta.tokens.delete(GOOD);
    await c.req("POST", "/v1/meta/sync", {});
    h.clock.now = new Date(Date.now() + 61_000);
    await c.req("POST", "/v1/meta/sync", {});
    await drain(h);
    expect(c.json(await c.req("GET", "/v1/meta")).connection).toMatchObject({ status: "token_expired", last_error: expect.stringMatching(/Token da Meta inválido/) });
    expect(c.json(await c.req("GET", "/v1/notifications")).notifications.some((x: { kind: string; title: string }) => x.kind === "token.expiring" && x.title === "Acesso à Meta perdido")).toBe(true);
    const r = await c.req("POST", "/v1/meta/connect", { access_token: READONLY });
    expect(r.statusCode).toBe(201);
    const st = c.json(await c.req("GET", "/v1/meta"));
    expect(st.connection.status).toBe("connected");
    expect(st.writes.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/ads_management/)]));
    expect((await h.admin.query("select count(*)::int as n from public.provider_connections where organization_id = $1 and provider = 'meta_ads'", [orgId])).rows[0].n).toBe(1);
  });

  it("desconectar revoga o token e para a sincronização", async () => {
    expect((await c.req("DELETE", "/v1/meta")).statusCode).toBe(200);
    expect(c.json(await c.req("GET", "/v1/meta")).connection).toBeNull();
    expect((await h.admin.query("select count(*)::int as n from private.credentials where organization_id = $1 and purpose = 'oauth_access_token' and revoked_at is null", [orgId])).rows[0].n).toBe(0);
  });
});
