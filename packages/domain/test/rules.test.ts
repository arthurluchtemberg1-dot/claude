import { describe, expect, it } from "vitest";
import { RULE_PRESETS, baseDefinition, decideEntity, entityRuleMetrics, evaluateCondition, ratio, rulePeriodRange, thresholdToRatio, validateRuleDefinition, type RuleDefinition } from "../src";

const metrics = (over: Partial<Parameters<typeof entityRuleMetrics>[0]> = {}) =>
  entityRuleMetrics({ spendMinor: 15000n, impressions: null, linkClicks: null, ordersCredit: ratio(0n, 1n), grossMinor: 0n, netMinor: 0n, ageDays: 10, status: null, ...over });
const def = (over: Partial<RuleDefinition> = {}): RuleDefinition => ({
  ...baseDefinition("campaign", "BRL"),
  condition: { op: "and", items: [{ metric: "spend", op: "gte", value: "100" }, { metric: "approved_orders", op: "eq", value: "0" }] },
  ...over,
});
const ctx = { mode: "execute" as const, freshness: { ok: true as const }, minutesSinceLastAction: null, actionsToday: 0, conflictingAction: null };

describe("motor de regras: domínio (R26)", () => {
  it("limiares exatos na moeda: R$ 100,00 = 10000 centavos; percentual e razão decimais", () => {
    expect(thresholdToRatio("spend", "100", "BRL")).toEqual({ num: 10000n, den: 1n });
    expect(thresholdToRatio("ctr", "1.5", "BRL")).toEqual({ num: 15n, den: 10n });
    expect(() => thresholdToRatio("roas", "1,5", "BRL")).toThrow(/inválido/);
  });

  it("CPA e ROAS exatos; gasto ausente = indisponível; zero vendas = CPA indefinido", () => {
    const m = metrics({ ordersCredit: ratio(3n, 1n), grossMinor: 59100n });
    expect(m.cpa).toEqual({ status: "ok", value: { num: 15000n, den: 3n } });
    expect(m.roas).toEqual({ status: "ok", value: { num: 59100n, den: 15000n } });
    expect(metrics().cpa.status).toBe("undefined");
    expect(metrics({ spendMinor: null }).roas.status).toBe("unavailable");
    expect(metrics().ctr.status).toBe("unavailable");
  });

  it("lógica de três valores: desconhecido contamina E; OU com verdadeiro decide", () => {
    const m = metrics();
    const and = evaluateCondition({ op: "and", items: [{ metric: "spend", op: "gte", value: "100" }, { metric: "ctr", op: "lt", value: "1" }] }, m, "BRL");
    expect(and.result).toBe("unknown");
    const andFalse = evaluateCondition({ op: "and", items: [{ metric: "spend", op: "gte", value: "200" }, { metric: "ctr", op: "lt", value: "1" }] }, m, "BRL");
    expect(andFalse.result).toBe(false);
    const or = evaluateCondition({ op: "or", items: [{ metric: "ctr", op: "lt", value: "1" }, { metric: "spend", op: "gte", value: "100" }] }, m, "BRL");
    expect(or.result).toBe(true);
  });

  it("ordem das travas: atraso, idade, amostra, dado ausente, cooldown, teto, conflito", () => {
    expect(decideEntity(def(), metrics(), { ...ctx, freshness: { ok: false, reason: "gasto até ontem" } }).kind).toBe("skip_stale");
    expect(decideEntity(def(), metrics({ ageDays: 1 }), ctx).kind).toBe("skip_learning");
    expect(decideEntity(def({ evaluation: { ...def().evaluation, min_spend: "200" } }), metrics(), ctx).kind).toBe("skip_sample");
    expect(decideEntity(def(), metrics(), { ...ctx, minutesSinceLastAction: 30 }).kind).toBe("skip_cooldown");
    expect(decideEntity(def(), metrics(), { ...ctx, actionsToday: 20 }).kind).toBe("skip_daily_cap");
    expect(decideEntity(def(), metrics(), { ...ctx, conflictingAction: "A regra X pausou" }).kind).toBe("skip_conflict");
    expect(decideEntity(def({ conflict: "override" }), metrics(), { ...ctx, conflictingAction: "A regra X pausou" }).kind).toBe("execute");
    expect(decideEntity(def(), metrics(), { ...ctx, mode: "simulate" }).kind).toBe("would_execute");
    expect(decideEntity(def(), metrics({ ordersCredit: ratio(1n, 2n) }), ctx).kind).toBe("no_match"); // venda fracionada ≠ 0
  });

  it("exemplos não passam na validação sem os valores do usuário; combinações inválidas recusadas", () => {
    for (const p of RULE_PRESETS) expect(validateRuleDefinition(p.definition("BRL")).join(" ")).toMatch(/Preencha/);
    expect(validateRuleDefinition(def({ actions: [{ type: "pause" }, { type: "activate" }] }))).toContain("Pausar e ativar na mesma regra se anulam");
    expect(validateRuleDefinition({ ...def(), level: "project", actions: [{ type: "pause" }] })).toContain("Regras de projeto só podem notificar ou chamar webhook");
    expect(validateRuleDefinition(def({ condition: { op: "and", items: [{ metric: "age_days", op: "gt", value: "1" }] }, level: "project" }))).toContain("Dias desde o primeiro gasto não se aplica ao nível project");
    expect(validateRuleDefinition(def())).toEqual([]);
  });

  it("períodos no calendário local", () => {
    expect(rulePeriodRange("last_7d", "2026-10-24")).toEqual({ from: "2026-10-18", to: "2026-10-24" });
    expect(rulePeriodRange("yesterday", "2026-03-01")).toEqual({ from: "2026-02-28", to: "2026-02-28" });
  });
});
