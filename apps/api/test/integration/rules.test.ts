import { signCanonicalBody } from "@tracker/connectors";
import { withTx } from "@tracker/db";
import { scheduleTicks } from "@tracker/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConnection, createHarness, createOrg, drain, postWebhook, signupVerified, type Client, type Harness } from "../helpers";

/**
 * Motor de regras (R26, R23-11): validação sem limites prontos, simulação sem efeitos, ativação só após simulação,
 * execução agendada com notificação/tag/webhook, cooldown e idempotência, teto diário, dados atrasados/ausentes
 * (nunca zero), metas de projeto, parada de emergência, permissão perdida, circuit breaker e versões imutáveis.
 */

let h: Harness;
let owner: { client: Client; userId: string; email: string };
let c: Client;
let orgId: string;
let projectId: string;
let today = "";
const uid = () => Math.random().toString(36).slice(2, 8);

function definition(over: Record<string, any> = {}) {
  return {
    level: "campaign",
    currency: "BRL",
    scope: { project_ids: [], network: null, name_contains: null, entity_ids: [] },
    evaluation: { period: "today", attribution_policy: "default", conversion_delay_hours: 0, min_spend: null, min_orders: null, min_impressions: null, min_age_days: 0, require_fresh_spend: true },
    condition: { op: "and", items: [{ metric: "spend", op: "gte", value: "100" }, { metric: "approved_orders", op: "eq", value: "0" }] },
    actions: [{ type: "notify" }, { type: "tag", tag: "sem-venda" }],
    limits: { cooldown_minutes: 360, max_actions_per_day: 20, max_budget_change_pct: 20, budget_ceiling: null },
    schedule: { every_minutes: 60, active_hours: null },
    conflict: "skip",
    ...over,
  };
}

async function create(name: string, def: Record<string, any>) {
  const r = await c.req("POST", "/v1/rules", { name, definition: def });
  expect(r.statusCode, r.body).toBe(201);
  return c.json(r).id as string;
}

/** Ciclo do agendador para esta organização: monitores + regras vencidas, processados pelo worker. */
async function tick() {
  await withTx(h.worker.pools.system, null, (cl) => scheduleTicks(cl, [orgId], new Date(h.clock.now.getTime() + Math.random() * 1e9)));
  await drain(h);
}

async function forceDue(ruleId: string) {
  await h.admin.query("update public.rules set next_run_at = now() - interval '1 minute' where id = $1", [ruleId]);
}

async function lastRun(ruleId: string) {
  const runs = c.json(await c.req("GET", `/v1/rules/${ruleId}/runs`)).runs.filter((r: { trigger: string }) => r.trigger === "schedule");
  const run = runs[0];
  if (!run) return null;
  return c.json(await c.req("GET", `/v1/rule-runs/${run.id}`));
}

beforeAll(async () => {
  // Rede privada liberada só para cadastrar o destino local do webhook (envio externo continua desligado).
  h = await createHarness({ OUTBOUND_ALLOW_PRIVATE_NETWORKS: "true" });
  owner = await signupVerified(h, "rules");
  c = owner.client;
  ({ orgId, projectId } = await createOrg(c, "Regras Org"));
  today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  const acc = c.json(await c.req("POST", "/v1/ad-accounts", { project_id: projectId, network: "meta", external_account_id: `act_${uid()}`, name: "Conta", currency: "BRL", timezone: "America/Sao_Paulo" })).id;
  const csv = `data;id;nome;gasto\n${today};C1;Campanha Fria;150,00\n${today};C2;Campanha Boa;50,00\n${today};C3;Campanha Nova;120,00\n`;
  const p = c.json(await c.req("POST", "/v1/imports/spend/preview", { ad_account_id: acc, level: "campaign", csv, mapping: { date: "data", entity_id: "id", entity_name: "nome", spend: "gasto" } }));
  expect((await c.req("POST", `/v1/imports/${p.import_id}/commit`)).statusCode).toBe(200);
  // Histórico de gasto antigo de C1 e C2 (idade); C3 aparece só hoje.
  const old = new Date(Date.parse(`${today}T12:00:00Z`) - 10 * 86_400_000).toISOString().slice(0, 10);
  const p2 = c.json(await c.req("POST", "/v1/imports/spend/preview", { ad_account_id: acc, level: "campaign", csv: `data;id;nome;gasto\n${old};C1;Campanha Fria;10,00\n${old};C2;Campanha Boa;10,00\n`, mapping: { date: "data", entity_id: "id", entity_name: "nome", spend: "gasto" } }));
  expect((await c.req("POST", `/v1/imports/${p2.import_id}/commit`)).statusCode).toBe(200);
  const conn = await createConnection(c, projectId, "custom");
  const raw = JSON.stringify({
    schema_version: "1.0",
    source: { provider: "erp", event_id: `evt-${uid()}` },
    event_type: "payment.approved",
    occurred_at: new Date().toISOString(),
    order: { external_order_id: `R-${uid()}`, currency: "BRL", amount_minor: 19700 },
    attribution: { utm_source: "facebook", utm_medium: "paid_social", campaign_id: "C2" },
  });
  expect((await postWebhook(h, conn.token, raw, { "x-tracker-signature": signCanonicalBody(conn.signing_secret, raw, Math.floor(h.clock.now.getTime() / 1000)) })).statusCode).toBe(200);
  await drain(h);
  h.clock.now = new Date(Date.now() + 1000);
});
afterAll(async () => h.close());

describe("regras: definição, simulação e ativação (R26-01, R26-04, R26-12, R26-13)", () => {
  it("exemplos vêm sem limites prontos; regra sem valor é recusada com motivo", async () => {
    const cat = c.json(await c.req("GET", "/v1/rules/catalog"));
    const preset = cat.presets.find((p: { key: string }) => p.key === "spend_without_sales");
    expect(preset.name).toMatch(/^Exemplo:/);
    expect(preset.definition.condition.items[0].value).toBe("");
    expect(cat.actions.find((a: { type: string }) => a.type === "pause")).toMatchObject({ availability: "planned", unavailable_reason: expect.stringMatching(/DEP-META-APP/) });
    const bad = await c.req("POST", "/v1/rules", { name: "x", definition: preset.definition });
    expect(bad.statusCode).toBe(400);
    expect(c.json(bad).error.message).toMatch(/Preencha o valor de "Investimento"/);
    // Código arbitrário/campos desconhecidos não passam.
    expect((await c.req("POST", "/v1/rules", { name: "x", definition: { ...definition(), script: "process.exit()" } })).statusCode).toBe(400);
    expect((await c.req("POST", "/v1/rules", { name: "x", definition: definition({ condition: { op: "and", items: [{ metric: "eval", op: "gt", value: "1" }] } }) })).statusCode).toBe(400);
  });

  it("simulação mostra o que faria, com explicação e sem efeito nenhum", async () => {
    const id = await create("Gasto sem venda", definition());
    const r = await c.req("POST", `/v1/rules/${id}/simulate`, {});
    expect(r.statusCode, r.body).toBe(200);
    const ents = c.json(r).evaluations[0].entities as Array<Record<string, any>>;
    const byId = Object.fromEntries(ents.map((e) => [e.id, e]));
    expect(byId.C1).toMatchObject({ decision: "would_execute", name: "Campanha Fria" });
    expect(byId.C1.explanation).toMatch(/Investimento R\$\s150,00 ≥ R\$\s100,00/);
    expect(byId.C2).toMatchObject({ decision: "no_match" }); // tem venda atribuída
    expect(byId.C3.decision).toBe("would_execute");
    expect((await h.admin.query("select count(*)::int as n from public.rule_actions where rule_id = $1", [id])).rows[0].n).toBe(0);
    expect((await h.admin.query("select count(*)::int as n from public.notifications where organization_id = $1 and kind = 'rule.triggered'", [orgId])).rows[0].n).toBe(0);
  });

  it("ativação exige simulação da versão atual; ações de mídia não ativam (capacidade indisponível)", async () => {
    const id = await create("Sem simular", definition());
    const a = await c.req("POST", `/v1/rules/${id}/activate`);
    expect(a.statusCode).toBe(409);
    expect(c.json(a).error.code).toBe("simulation_required");
    const media = await create("Pausar sem venda", definition({ level: "ad", actions: [{ type: "notify" }, { type: "pause" }] }));
    await c.req("POST", `/v1/rules/${media}/simulate`, {});
    const m = await c.req("POST", `/v1/rules/${media}/activate`);
    expect(m.statusCode).toBe(409);
    expect(c.json(m).error.message).toMatch(/DEP-META-APP/);
  });
});

describe("regras: execução agendada (R26-03, R26-05..R26-11)", () => {
  let ruleId = "";
  it("executa notificação e tag na entidade, com idade mínima excluindo a campanha nova", async () => {
    ruleId = await create("Gasto sem venda (ativa)", definition({ evaluation: { ...definition().evaluation, min_age_days: 3 } }));
    await c.req("POST", `/v1/rules/${ruleId}/simulate`, {});
    expect((await c.req("POST", `/v1/rules/${ruleId}/activate`)).statusCode).toBe(200);
    await tick();
    const run = await lastRun(ruleId);
    expect(run.run).toMatchObject({ mode: "execute", status: "ok", version: 1 });
    const d = Object.fromEntries(run.decisions.map((x: { entity_id: string }) => [x.entity_id, x]));
    expect(d.C1).toMatchObject({ decision: "execute" });
    expect(d.C1.actions.map((a: { type: string; status: string }) => [a.type, a.status])).toEqual([["notify", "executed"], ["tag", "executed"]]);
    expect(d.C3).toMatchObject({ decision: "skip_learning" });
    expect(d.C3.explanation).toMatch(/aproximação/);
    const n = c.json(await c.req("GET", "/v1/notifications")).notifications.filter((x: { kind: string }) => x.kind === "rule.triggered");
    expect(n).toHaveLength(1);
    expect(n[0].title).toBe("Gasto sem venda (ativa): Campanha Fria");
    expect(n[0].link).toBe(`/automacao/${ruleId}`);
    const tags = (await h.admin.query("select entity_id, tag from public.entity_tags where organization_id = $1", [orgId])).rows;
    expect(tags).toEqual([{ entity_id: "C1", tag: "sem-venda" }]);
  });

  it("nova execução dentro do intervalo mínimo não repete a ação (cooldown)", async () => {
    await forceDue(ruleId);
    await tick();
    const run = await lastRun(ruleId);
    expect(run.decisions.find((x: { entity_id: string }) => x.entity_id === "C1")).toMatchObject({ decision: "skip_cooldown" });
    expect(c.json(await c.req("GET", "/v1/notifications")).notifications.filter((x: { kind: string }) => x.kind === "rule.triggered")).toHaveLength(1);
  });

  it("teto diário aplicado dentro da mesma execução", async () => {
    const id = await create("Teto 1", definition({ limits: { ...definition().limits, max_actions_per_day: 1 }, actions: [{ type: "tag", tag: "teto" }] }));
    await c.req("POST", `/v1/rules/${id}/simulate`, {});
    await c.req("POST", `/v1/rules/${id}/activate`);
    await tick();
    const kinds = (await lastRun(id)).decisions.map((x: { decision: string }) => x.decision).sort();
    expect(kinds).toEqual(["execute", "no_match", "skip_daily_cap"]);
    await c.req("POST", `/v1/rules/${id}/pause`, {});
  });

  it("métrica sem dado fica desconhecida (nunca zero) e não executa", async () => {
    const id = await create("CTR", definition({ condition: { op: "and", items: [{ metric: "ctr", op: "lt", value: "1" }] } }));
    const ents = c.json(await c.req("POST", `/v1/rules/${id}/simulate`, {})).evaluations[0].entities;
    expect(ents.every((e: { decision: string }) => e.decision === "skip_missing_data")).toBe(true);
    expect(ents[0].explanation).toMatch(/Dado ausente não é tratado como zero/);
    // OU com uma condição verdadeira decide mesmo com a outra desconhecida (lógica de três valores).
    const or = await create("CTR ou gasto", definition({ condition: { op: "or", items: [{ metric: "ctr", op: "lt", value: "1" }, { metric: "spend", op: "gte", value: "100" }] } }));
    const e2 = c.json(await c.req("POST", `/v1/rules/${or}/simulate`, {})).evaluations[0].entities;
    expect(e2.find((e: { id: string }) => e.id === "C1").decision).toBe("would_execute");
  });

  it("gasto não importado até o fim da janela: não decide (dados atrasados)", async () => {
    const tomorrowRule = await create("Ontem sem gasto?", definition({ evaluation: { ...definition().evaluation, period: "last_3d" } }));
    const ev = c.json(await c.req("POST", `/v1/rules/${tomorrowRule}/simulate`, { days: 1 })).evaluations;
    // Agora: gasto até hoje (ok). Simulação do fim de ontem também cobre (janela até ontem).
    expect(ev[0].freshness.ok).toBe(true);
    const noSpend = await create("Moeda sem gasto", definition({ currency: "USD" }));
    const e = c.json(await c.req("POST", `/v1/rules/${noSpend}/simulate`, {})).evaluations[0];
    expect(e.freshness).toMatchObject({ ok: false, reason: expect.stringMatching(/Nenhum gasto importado/) });
  });

  it("meta de receita do projeto (R23-11) notifica uma vez", async () => {
    const id = await create("Meta do dia", definition({ level: "project", condition: { op: "and", items: [{ metric: "revenue", op: "gte", value: "150" }] }, actions: [{ type: "notify" }], limits: { ...definition().limits, cooldown_minutes: 1440 } }));
    await c.req("POST", `/v1/rules/${id}/simulate`, {});
    await c.req("POST", `/v1/rules/${id}/activate`);
    await tick();
    const run = await lastRun(id);
    expect(run.decisions[0]).toMatchObject({ entity_name: "Todos os projetos", decision: "execute" });
    expect(run.decisions[0].explanation).toMatch(/Receita aprovada \(atribuída\) R\$\s197,00 ≥ R\$\s150,00/);
    await forceDue(id);
    await tick();
    expect((await lastRun(id)).decisions[0].decision).toBe("skip_cooldown");
    await c.req("POST", `/v1/rules/${id}/pause`, {});
  });

  it("parada de emergência da organização impede execução; simulação continua", async () => {
    expect((await c.req("PUT", "/v1/rules/kill-switch", { organization: true })).statusCode).toBe(200);
    await forceDue(ruleId);
    await tick();
    expect((await lastRun(ruleId)).run).toMatchObject({ status: "skipped", skip_reason: "Regras pausadas para toda a organização" });
    expect((await c.req("POST", `/v1/rules/${ruleId}/simulate`, {})).statusCode).toBe(200);
    expect(c.json(await c.req("GET", "/v1/rules/kill-switch"))).toMatchObject({ organization: true, system: false });
    await c.req("PUT", "/v1/rules/kill-switch", { organization: false });
  });

  it("webhook inativo falha a ação; 3 execuções com falha suspendem a regra (circuit breaker)", async () => {
    const sub = c.json(await c.req("POST", "/v1/webhook-subscriptions", { name: "Regras", url: "http://127.0.0.1:9/hook", events: ["rule.triggered"] }));
    expect(sub.id).toBeTruthy(); // nasce pausada (sem teste assinado)
    const id = await create("Webhook", definition({ actions: [{ type: "webhook", subscription_id: sub.id }], limits: { ...definition().limits, cooldown_minutes: 15 } }));
    await c.req("POST", `/v1/rules/${id}/simulate`, {});
    await c.req("POST", `/v1/rules/${id}/activate`);
    for (let i = 0; i < 3; i++) {
      await forceDue(id);
      await tick();
    }
    const r = c.json(await c.req("GET", `/v1/rules/${id}`)).rule;
    expect(r).toMatchObject({ status: "suspended", status_reason: expect.stringMatching(/3 execuções seguidas com falha/) });
    expect(c.json(await c.req("GET", "/v1/notifications")).notifications.some((n: { title: string }) => n.title === "Regra suspensa: Webhook")).toBe(true);
  });

  it("quem ativou perde a permissão: regra suspensa sem executar", async () => {
    const mgr = await signupVerified(h, "rules-mgr");
    await c.req("POST", "/v1/invites", { email: mgr.email, role: "manager" });
    const token = new URL([...h.emails].reverse().find((m) => m.to === mgr.email && m.kind === "invite")!.actionUrl!).searchParams.get("token")!;
    await mgr.client.req("POST", "/v1/invites/accept", { token });
    mgr.client.orgId = orgId;
    const r = await mgr.client.req("POST", "/v1/rules", { name: "Do gestor", definition: definition({ actions: [{ type: "tag", tag: "gestor" }] }) });
    expect(r.statusCode, r.body).toBe(201);
    const id = mgr.client.json(r).id;
    await mgr.client.req("POST", `/v1/rules/${id}/simulate`, {});
    expect((await mgr.client.req("POST", `/v1/rules/${id}/activate`)).statusCode).toBe(200);
    const m = c.json(await c.req("GET", "/v1/members")).members.find((x: { user_id: string }) => x.user_id === mgr.userId);
    expect((await c.req("PATCH", `/v1/members/${m.id}`, { role: "analyst" })).statusCode).toBe(200);
    await tick();
    expect(c.json(await c.req("GET", `/v1/rules/${id}`)).rule).toMatchObject({ status: "suspended", status_reason: expect.stringMatching(/não tem mais permissão/) });
    expect((await h.admin.query("select count(*)::int as n from public.entity_tags where tag = 'gestor'")).rows[0].n).toBe(0);
    // Analista não cria nem simula regras.
    expect((await mgr.client.req("POST", "/v1/rules", { name: "x", definition: definition() })).statusCode).toBe(403);
  });

  it("editar cria nova versão imutável; regra ativa volta a só simular; tag pode ser desfeita", async () => {
    const u = await c.req("PUT", `/v1/rules/${ruleId}`, { definition: definition({ condition: { op: "and", items: [{ metric: "spend", op: "gte", value: "140" }] } }) });
    expect(c.json(u)).toMatchObject({ version: 2, status: "simulate" });
    const detail = c.json(await c.req("GET", `/v1/rules/${ruleId}`));
    expect(detail.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(detail.versions[1].definition.condition.items[0].value).toBe("100");
    await expect(h.admin.query("update public.rule_versions set definition = '{}' where rule_id = $1", [ruleId])).rejects.toThrow(/imutáveis/);
    const acts = c.json(await c.req("GET", `/v1/rules/${ruleId}/runs`)).actions;
    const tagAction = acts.find((a: { action_type: string }) => a.action_type === "tag");
    expect((await c.req("POST", `/v1/rule-actions/${tagAction.id}/undo`)).statusCode).toBe(200);
    expect((await h.admin.query("select count(*)::int as n from public.entity_tags where organization_id = $1 and tag = 'sem-venda'", [orgId])).rows[0].n).toBe(0);
    const notify = acts.find((a: { action_type: string }) => a.action_type === "notify");
    expect((await c.req("POST", `/v1/rule-actions/${notify.id}/undo`)).statusCode).toBe(400);
  });
});
