import { formatMoney, parseDecimalToMinor } from "../money";
import { ratio, ratioToDecimalString, roundRatioHalfEven, type Ratio } from "../metrics/ratio";

/**
 * Motor de regras (R26): definição declarativa (sem código arbitrário — R26-01), avaliação com lógica de três
 * valores (dado ausente/indefinido = "desconhecido", nunca zero — R26-09) e decisão explicada (R26-12).
 * Cálculos exatos com frações; arredondamento só na explicação.
 */

export const RULE_LEVELS = ["campaign", "adset", "ad", "project"] as const;
export type RuleLevel = (typeof RULE_LEVELS)[number];

export const RULE_PERIODS = ["today", "yesterday", "last_3d", "last_7d", "last_14d", "last_30d"] as const;
export type RulePeriod = (typeof RULE_PERIODS)[number];

export const RULE_OPS = ["gt", "gte", "lt", "lte", "eq", "neq"] as const;
export type RuleOp = (typeof RULE_OPS)[number];
const OP_LABEL: Record<RuleOp, string> = { gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=", neq: "≠" };

export type RuleMetricUnit = "money" | "count" | "ratio" | "percent" | "days" | "status";

export interface RuleMetricDef {
  label: string;
  unit: RuleMetricUnit;
  levels: readonly RuleLevel[];
  description: string;
  /** "planned" = depende de integração indisponível; a condição fica sempre "desconhecida". */
  availability: "active" | "planned";
  unavailableReason?: string;
}

const ENTITY: readonly RuleLevel[] = ["campaign", "adset", "ad"];
const ALL: readonly RuleLevel[] = ["campaign", "adset", "ad", "project"];

export const RULE_METRICS = {
  spend: { label: "Investimento", unit: "money", levels: ALL, description: "Gasto importado/sincronizado no período (nível da entidade).", availability: "active" },
  approved_orders: { label: "Vendas aprovadas (atribuídas)", unit: "count", levels: ALL, description: "Pedidos aprovados creditados pela política de atribuição (pode ser fracionado no modelo linear).", availability: "active" },
  revenue: { label: "Receita aprovada (atribuída)", unit: "money", levels: ALL, description: "Receita bruta aprovada creditada à entidade; no projeto, receita bruta aprovada do período.", availability: "active" },
  revenue_net: { label: "Receita após estornos", unit: "money", levels: ALL, description: "Receita aprovada menos reembolsos/chargebacks conhecidos até agora.", availability: "active" },
  cpa: { label: "CPA", unit: "money", levels: ALL, description: "Investimento ÷ vendas aprovadas atribuídas.", availability: "active" },
  roas: { label: "ROAS", unit: "ratio", levels: ALL, description: "Receita aprovada atribuída ÷ investimento.", availability: "active" },
  contribution: { label: "Contribuição após mídia", unit: "money", levels: ["project"], description: "Receita após estornos menos taxas e mídia (custos conhecidos).", availability: "active" },
  impressions: { label: "Impressões", unit: "count", levels: ALL, description: "Reportadas pela rede (quando importadas).", availability: "active" },
  link_clicks: { label: "Cliques no link", unit: "count", levels: ALL, description: "Reportados pela rede (quando importados).", availability: "active" },
  ctr: { label: "CTR de link (%)", unit: "percent", levels: ALL, description: "Cliques no link ÷ impressões × 100.", availability: "active" },
  cpc: { label: "CPC de link", unit: "money", levels: ALL, description: "Investimento ÷ cliques no link.", availability: "active" },
  cpm: { label: "CPM", unit: "money", levels: ALL, description: "Investimento ÷ impressões × 1.000.", availability: "active" },
  age_days: { label: "Dias desde o primeiro gasto", unit: "days", levels: ENTITY, description: "Idade observada pela primeira data de gasto importado.", availability: "active" },
  status: { label: "Status na rede", unit: "status", levels: ENTITY, description: "Status configurado na Meta (ACTIVE, PAUSED), lido na sincronização.", availability: "active" },
  daily_budget: { label: "Orçamento diário", unit: "money", levels: ["campaign", "adset"], description: "Orçamento diário atual na Meta (só no nível em que está definido).", availability: "active" },
  frequency: { label: "Frequência", unit: "ratio", levels: ENTITY, description: "Impressões ÷ alcance do período.", availability: "planned", unavailableReason: "O alcance de um período não é a soma do alcance diário; leitura por período ainda não implementada" },
  budget_change_pct: { label: "Variação de orçamento (%)", unit: "percent", levels: ENTITY, description: "Mudança de orçamento no período.", availability: "planned", unavailableReason: "Histórico de orçamento ainda não comparado entre sincronizações" },
  balance: { label: "Saldo da conta", unit: "money", levels: ENTITY, description: "Saldo disponível quando a rede expõe o campo.", availability: "planned", unavailableReason: "Depende da sincronização de contas Meta (DEP-META-APP); ausência nunca vira saldo zero" },
} as const satisfies Record<string, RuleMetricDef>;

export type RuleMetricKey = keyof typeof RULE_METRICS;
export function isRuleMetric(v: unknown): v is RuleMetricKey {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(RULE_METRICS, v);
}

export type RuleMetricValue =
  | { status: "ok"; value: Ratio; text?: string }
  | { status: "unavailable" | "undefined"; reason: string };

export interface RuleCondition {
  metric: RuleMetricKey;
  op: RuleOp;
  /** Valor em unidade de exibição: dinheiro em reais ("50.00"), % ("1.5"), razão ("2"), contagem/dias inteiros; status em texto. */
  value: string;
}
export interface RuleConditionGroup {
  op: "and" | "or";
  items: (RuleCondition | RuleConditionGroup)[];
}

export const RULE_ACTIONS = ["notify", "webhook", "tag", "pause", "activate", "budget", "duplicate"] as const;
export type RuleActionType = (typeof RULE_ACTIONS)[number];
export type RuleAction =
  | { type: "notify" }
  | { type: "webhook"; subscription_id: string }
  | { type: "tag"; tag: string }
  | { type: "pause" }
  | { type: "activate" }
  | { type: "budget"; mode: "percent" | "absolute"; value: string; min?: string; max?: string }
  | { type: "duplicate" };

/** Ações que escrevem na rede de anúncios: exigem conector de gestão (R25) e permissão media.execute. */
export const MEDIA_ACTIONS: ReadonlySet<RuleActionType> = new Set(["pause", "activate", "budget", "duplicate"]);

export interface RuleDefinition {
  level: RuleLevel;
  /** Moeda das condições monetárias e dos agrupamentos avaliados. */
  currency: string;
  scope: { project_ids: string[]; network: string | null; name_contains: string | null; entity_ids: string[] };
  evaluation: {
    period: RulePeriod;
    attribution_policy: string;
    /** Ignora as últimas N horas (atraso de conversão — R26-10). */
    conversion_delay_hours: number;
    min_spend: string | null;
    min_orders: string | null;
    min_impressions: string | null;
    /** Exclui entidades mais novas que N dias (aproximação de "aprendizagem" enquanto a rede não informa o status). */
    min_age_days: number;
    /** Gasto deve estar importado/sincronizado até o fim da janela (R26-09). */
    require_fresh_spend: boolean;
    /** Não agir em entidades em fase de aprendizado na Meta (R26-10). Padrão: sim. */
    exclude_learning?: boolean;
  };
  condition: RuleConditionGroup;
  actions: RuleAction[];
  limits: { cooldown_minutes: number; max_actions_per_day: number; max_budget_change_pct: number | null; budget_ceiling: string | null };
  schedule: { every_minutes: number; active_hours: { start: string; end: string } | null };
  /** Política de conflito: por padrão não reverte ação de outra regra na mesma entidade dentro do cooldown (R26-08). */
  conflict: "skip" | "override";
}

// ------------------------------------------------------------------ valores

export function moneyValue(minor: bigint | Ratio | null | undefined, reason = "Sem dado no período"): RuleMetricValue {
  if (minor === null || minor === undefined) return { status: "unavailable", reason };
  return { status: "ok", value: typeof minor === "bigint" ? ratio(minor, 1n) : minor };
}

export function countValue(n: bigint | Ratio | null | undefined, reason = "Sem dado no período"): RuleMetricValue {
  if (n === null || n === undefined) return { status: "unavailable", reason };
  return { status: "ok", value: typeof n === "bigint" ? ratio(n, 1n) : n };
}

/** Métricas por entidade a partir dos agregados brutos (fórmulas no domínio — R05-11). */
export function entityRuleMetrics(row: {
  spendMinor: bigint | null;
  impressions: bigint | null;
  linkClicks: bigint | null;
  ordersCredit: Ratio;
  grossMinor: bigint;
  netMinor: bigint;
  ageDays: number | null;
  status: string | null;
  dailyBudgetMinor?: bigint | null;
}): Record<RuleMetricKey, RuleMetricValue> {
  const noSpend = "Sem gasto importado/sincronizado para esta entidade no período";
  const s = row.spendMinor;
  const planned = (k: RuleMetricKey): RuleMetricValue => ({ status: "unavailable", reason: (RULE_METRICS[k] as RuleMetricDef).unavailableReason ?? "Indisponível" });
  return {
    spend: moneyValue(s, noSpend),
    approved_orders: countValue(row.ordersCredit),
    revenue: moneyValue(row.grossMinor),
    revenue_net: moneyValue(row.netMinor),
    cpa: s === null ? { status: "unavailable", reason: noSpend } : row.ordersCredit.num === 0n ? { status: "undefined", reason: "Nenhuma venda atribuída (CPA indefinido)" } : { status: "ok", value: ratio(s * row.ordersCredit.den, row.ordersCredit.num) },
    roas: s === null ? { status: "unavailable", reason: noSpend } : s === 0n ? { status: "undefined", reason: "Gasto zero no período" } : { status: "ok", value: ratio(row.grossMinor, s) },
    contribution: { status: "unavailable", reason: "Contribuição só no nível de projeto (custos não são alocados por campanha)" },
    impressions: countValue(row.impressions, "Impressões não importadas"),
    link_clicks: countValue(row.linkClicks, "Cliques não importados"),
    ctr: row.impressions === null || row.linkClicks === null ? { status: "unavailable", reason: "Impressões/cliques não importados" } : row.impressions === 0n ? { status: "undefined", reason: "Sem impressões" } : { status: "ok", value: ratio(row.linkClicks * 100n, row.impressions) },
    cpc: s === null || row.linkClicks === null ? { status: "unavailable", reason: "Gasto/cliques não importados" } : row.linkClicks === 0n ? { status: "undefined", reason: "Sem cliques" } : { status: "ok", value: ratio(s, row.linkClicks) },
    cpm: s === null || row.impressions === null ? { status: "unavailable", reason: "Gasto/impressões não importados" } : row.impressions === 0n ? { status: "undefined", reason: "Sem impressões" } : { status: "ok", value: ratio(s * 1000n, row.impressions) },
    age_days: row.ageDays === null ? { status: "unavailable", reason: "Sem histórico de gasto para estimar a idade" } : { status: "ok", value: ratio(BigInt(row.ageDays), 1n) },
    status: row.status ? { status: "ok", value: ratio(0n, 1n), text: row.status } : { status: "unavailable", reason: "Status não sincronizado (conecte a Meta ou importe as entidades)" },
    daily_budget: row.dailyBudgetMinor === undefined || row.dailyBudgetMinor === null ? { status: "unavailable", reason: "Orçamento diário não definido neste nível (ou não sincronizado)" } : moneyValue(row.dailyBudgetMinor),
    frequency: planned("frequency"),
    budget_change_pct: planned("budget_change_pct"),
    balance: planned("balance"),
  };
}

// ------------------------------------------------------------------ avaliação

/** Converte o limiar da condição para a mesma unidade interna do valor (dinheiro em menor unidade). */
export function thresholdToRatio(metric: RuleMetricKey, value: string, currency: string): Ratio {
  const unit = RULE_METRICS[metric].unit;
  const v = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(v)) throw new Error(`Valor inválido para ${RULE_METRICS[metric].label}: ${value}`);
  if (unit === "money") return ratio(parseDecimalToMinor(v, currency), 1n);
  const [i, f = ""] = v.replace("-", "").split(".");
  const den = 10n ** BigInt(f.length);
  const num = BigInt(`${i}${f}`) * (v.startsWith("-") ? -1n : 1n);
  return ratio(num, den);
}

function cmp(a: Ratio, b: Ratio): number {
  const l = a.num * b.den;
  const r = b.num * a.den;
  return l === r ? 0 : l > r ? 1 : -1;
}

export function formatRuleValue(metric: RuleMetricKey, v: RuleMetricValue, currency: string): string {
  if (v.status !== "ok") return v.status === "undefined" ? `indefinido (${v.reason})` : `indisponível (${v.reason})`;
  if (v.text !== undefined) return v.text;
  const unit = RULE_METRICS[metric].unit;
  // Arredondamento só na exibição (dinheiro para a menor unidade; demais com 2 casas, sem zeros à direita).
  if (unit === "money") return formatMoney({ amountMinor: roundRatioHalfEven(v.value), currency });
  const raw = ratioToDecimalString(v.value, 2);
  const s = raw.includes(".") ? raw.replace(/0+$/, "").replace(/\.$/, "") : raw;
  return unit === "percent" ? `${s}%` : s;
}

export type Tri = true | false | "unknown";
export interface EvalNode {
  label: string;
  result: Tri;
  children?: EvalNode[];
}

export function evaluateCondition(group: RuleConditionGroup, metrics: Record<RuleMetricKey, RuleMetricValue>, currency: string): EvalNode {
  const children = group.items.map((it): EvalNode => {
    if ("items" in it) return evaluateCondition(it, metrics, currency);
    const v = metrics[it.metric];
    const def = RULE_METRICS[it.metric];
    const shown = formatRuleValue(it.metric, v, currency);
    if (v.status !== "ok") return { label: `${def.label} ${OP_LABEL[it.op]} ${it.value}: ${shown}`, result: "unknown" };
    let result: boolean;
    if (def.unit === "status") {
      const eq = (v.text ?? "").toUpperCase() === it.value.trim().toUpperCase();
      result = it.op === "eq" ? eq : it.op === "neq" ? !eq : false;
    } else {
      const c = cmp(v.value, thresholdToRatio(it.metric, it.value, currency));
      result = { gt: c > 0, gte: c >= 0, lt: c < 0, lte: c <= 0, eq: c === 0, neq: c !== 0 }[it.op];
    }
    const thr = def.unit === "money" ? formatRuleValue(it.metric, { status: "ok", value: thresholdToRatio(it.metric, it.value, currency) }, currency) : def.unit === "percent" ? `${it.value}%` : it.value;
    return { label: `${def.label} ${shown} ${OP_LABEL[it.op]} ${thr}`, result };
  });
  // Lógica de três valores: E com falso = falso; OU com verdadeiro = verdadeiro; caso contrário, desconhecido contamina.
  let result: Tri;
  if (group.op === "and") result = children.some((c) => c.result === false) ? false : children.some((c) => c.result === "unknown") ? "unknown" : true;
  else result = children.some((c) => c.result === true) ? true : children.some((c) => c.result === "unknown") ? "unknown" : false;
  return { label: group.op === "and" ? "TODAS" : "QUALQUER", result, children };
}

export function explainEval(n: EvalNode, depth = 0): string {
  if (!n.children) return `${n.label} → ${n.result === "unknown" ? "?" : n.result ? "sim" : "não"}`;
  const inner = n.children.map((c) => explainEval(c, depth + 1)).join(n.label === "TODAS" ? " E " : " OU ");
  return depth ? `(${inner})` : inner;
}

// ------------------------------------------------------------------ decisão

export type RuleDecisionKind =
  | "execute"
  | "would_execute"
  | "no_match"
  | "skip_stale"
  | "skip_learning"
  | "skip_sample"
  | "skip_missing_data"
  | "skip_cooldown"
  | "skip_daily_cap"
  | "skip_conflict";

export const DECISION_LABEL: Record<RuleDecisionKind, string> = {
  execute: "Executada",
  would_execute: "Executaria (simulação)",
  no_match: "Condições não atendidas",
  skip_stale: "Não executada: dados atrasados",
  skip_learning: "Não executada: em aprendizado ou entidade nova",
  skip_sample: "Não executada: amostra insuficiente",
  skip_missing_data: "Não executada: dados ausentes",
  skip_cooldown: "Não executada: em intervalo mínimo (cooldown)",
  skip_daily_cap: "Não executada: limite diário de ações atingido",
  skip_conflict: "Não executada: conflito com outra regra",
};

export interface DecisionContext {
  mode: "simulate" | "execute";
  freshness: { ok: true } | { ok: false; reason: string };
  /** Minutos desde a última ação desta regra nesta entidade (null = nunca). */
  minutesSinceLastAction: number | null;
  actionsToday: number;
  /** Ação oposta recente de outra regra na mesma entidade (ex.: pausou e esta quer ativar). */
  conflictingAction: string | null;
  /** Em aprendizado segundo a Meta (true/false) ou desconhecido (null → usa a idade como aproximação). */
  learning?: boolean | null;
}

export interface RuleDecision {
  kind: RuleDecisionKind;
  explanation: string;
  evaluation: EvalNode;
}

export function decideEntity(def: RuleDefinition, metrics: Record<RuleMetricKey, RuleMetricValue>, ctx: DecisionContext): RuleDecision {
  const ev = evaluateCondition(def.condition, metrics, def.currency);
  const cond = explainEval(ev);
  const mk = (kind: RuleDecisionKind, why: string): RuleDecision => ({ kind, evaluation: ev, explanation: `${DECISION_LABEL[kind]}. ${why}` });
  const usesSpend = JSON.stringify(def.condition).match(/"metric":"(spend|cpa|roas|cpc|cpm|contribution)"/) !== null;
  if (usesSpend && def.evaluation.require_fresh_spend && !ctx.freshness.ok) return mk("skip_stale", ctx.freshness.reason);
  if (def.level !== "project" && (def.evaluation.exclude_learning ?? true) && ctx.learning === true) {
    return mk("skip_learning", "Em fase de aprendizado na Meta: mudanças agora reiniciam o aprendizado. Desmarque \"não agir em aprendizado\" para incluir.");
  }
  if (def.level !== "project" && def.evaluation.min_age_days > 0 && (ctx.learning === null || ctx.learning === undefined)) {
    const age = metrics.age_days;
    if (age.status === "ok" && cmp(age.value, ratio(BigInt(def.evaluation.min_age_days), 1n)) < 0) {
      return mk("skip_learning", `Primeiro gasto há ${formatRuleValue("age_days", age, def.currency)} dia(s); mínimo configurado ${def.evaluation.min_age_days}. O status de aprendizagem da rede não está disponível, por isso a idade é usada como aproximação.`);
    }
  }
  const sample: string[] = [];
  const below = (m: RuleMetricKey, min: string | null) => {
    if (min === null) return;
    const v = metrics[m];
    if (v.status !== "ok" || cmp(v.value, thresholdToRatio(m, min, def.currency)) < 0) sample.push(`${RULE_METRICS[m].label} ${formatRuleValue(m, v, def.currency)} abaixo do mínimo ${RULE_METRICS[m].unit === "money" ? formatRuleValue(m, { status: "ok", value: thresholdToRatio(m, min, def.currency) }, def.currency) : min}`);
  };
  below("spend", def.evaluation.min_spend);
  below("approved_orders", def.evaluation.min_orders);
  below("impressions", def.evaluation.min_impressions);
  if (sample.length) return mk("skip_sample", `${sample.join("; ")}. Poucos dados não permitem concluir.`);
  if (ev.result === "unknown") return mk("skip_missing_data", `${cond}. Dado ausente não é tratado como zero.`);
  if (ev.result === false) return mk("no_match", cond);
  if (ctx.minutesSinceLastAction !== null && ctx.minutesSinceLastAction < def.limits.cooldown_minutes) {
    return mk("skip_cooldown", `${cond}. Última ação há ${Math.floor(ctx.minutesSinceLastAction)} min; intervalo mínimo ${def.limits.cooldown_minutes} min.`);
  }
  if (ctx.actionsToday >= def.limits.max_actions_per_day) return mk("skip_daily_cap", `${cond}. ${ctx.actionsToday} ação(ões) hoje; limite ${def.limits.max_actions_per_day}.`);
  if (ctx.conflictingAction && def.conflict === "skip") return mk("skip_conflict", `${cond}. ${ctx.conflictingAction}; a política de conflito desta regra é não reverter ações de outras regras.`);
  return mk(ctx.mode === "simulate" ? "would_execute" : "execute", cond);
}

// ------------------------------------------------------------------ períodos

/** Intervalo local (inclusivo) do período, a partir da data local de referência. */
export function rulePeriodRange(period: RulePeriod, todayLocal: string): { from: string; to: string } {
  const add = (d: string, n: number) => {
    const t = new Date(`${d}T12:00:00Z`);
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  };
  switch (period) {
    case "today":
      return { from: todayLocal, to: todayLocal };
    case "yesterday":
      return { from: add(todayLocal, -1), to: add(todayLocal, -1) };
    case "last_3d":
      return { from: add(todayLocal, -2), to: todayLocal };
    case "last_7d":
      return { from: add(todayLocal, -6), to: todayLocal };
    case "last_14d":
      return { from: add(todayLocal, -13), to: todayLocal };
    case "last_30d":
      return { from: add(todayLocal, -29), to: todayLocal };
  }
}

export const RULE_PERIOD_LABEL: Record<RulePeriod, string> = {
  today: "Hoje",
  yesterday: "Ontem",
  last_3d: "Últimos 3 dias",
  last_7d: "Últimos 7 dias",
  last_14d: "Últimos 14 dias",
  last_30d: "Últimos 30 dias",
};
