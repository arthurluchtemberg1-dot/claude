import { isValidHhMm } from "../notifications";
import { MEDIA_ACTIONS, RULE_METRICS, RULE_PERIODS, isRuleMetric, thresholdToRatio, type RuleCondition, type RuleConditionGroup, type RuleDefinition } from "./engine";

/**
 * Exemplos de regras (R26-13): vêm DESLIGADOS, rotulados como exemplo e SEM limites prontos — não existe "CPA ideal"
 * universal. O usuário preenche os valores, simula e só então ativa.
 */

export const RULE_SCHEDULES = [15, 30, 60, 120, 360, 720, 1440] as const;

export function baseDefinition(level: RuleDefinition["level"], currency: string): RuleDefinition {
  return {
    level,
    currency,
    scope: { project_ids: [], network: null, name_contains: null, entity_ids: [] },
    evaluation: { period: "today", attribution_policy: "default", conversion_delay_hours: 0, min_spend: null, min_orders: null, min_impressions: null, min_age_days: level === "project" ? 0 : 3, require_fresh_spend: true },
    condition: { op: "and", items: [] },
    actions: [{ type: "notify" }],
    limits: { cooldown_minutes: level === "project" ? 1440 : 360, max_actions_per_day: 20, max_budget_change_pct: 20, budget_ceiling: null },
    schedule: { every_minutes: 60, active_hours: null },
    conflict: "skip",
  };
}

export interface RulePreset {
  key: string;
  name: string;
  description: string;
  /** Campos que o usuário PRECISA preencher antes de simular. */
  required: string[];
  definition: (currency: string) => RuleDefinition;
}

const cond = (metric: RuleCondition["metric"], op: RuleCondition["op"], value = ""): RuleCondition => ({ metric, op, value });

export const RULE_PRESETS: RulePreset[] = [
  {
    key: "spend_without_sales",
    name: "Exemplo: campanha gastando sem vendas",
    description: "Avisa quando uma campanha passa de um gasto que você define sem nenhuma venda aprovada atribuída no dia.",
    required: ["Investimento a partir do qual avisar"],
    definition: (cur) => ({ ...baseDefinition("campaign", cur), condition: { op: "and", items: [cond("spend", "gte"), cond("approved_orders", "eq", "0")] } }),
  },
  {
    key: "cpa_above_limit",
    name: "Exemplo: CPA acima do seu limite",
    description: "Avisa quando o CPA de um conjunto passa do limite do seu negócio (com ao menos uma venda para o CPA existir).",
    required: ["CPA máximo"],
    definition: (cur) => ({ ...baseDefinition("adset", cur), evaluation: { ...baseDefinition("adset", cur).evaluation, period: "last_3d", min_orders: "1" }, condition: { op: "and", items: [cond("cpa", "gt")] } }),
  },
  {
    key: "roas_below_min",
    name: "Exemplo: ROAS abaixo do mínimo",
    description: "Avisa quando o ROAS de uma campanha cai abaixo do mínimo, exigindo um gasto mínimo para não decidir com poucos dados.",
    required: ["ROAS mínimo", "Investimento mínimo para avaliar"],
    definition: (cur) => ({ ...baseDefinition("campaign", cur), evaluation: { ...baseDefinition("campaign", cur).evaluation, period: "last_3d", min_spend: "" }, condition: { op: "and", items: [cond("roas", "lt")] } }),
  },
  {
    key: "daily_revenue_goal",
    name: "Exemplo: meta de receita do dia atingida",
    description: "Avisa uma vez por dia quando a receita aprovada do projeto atinge a meta que você definir. Meta não é promessa de resultado.",
    required: ["Meta de receita"],
    definition: (cur) => ({ ...baseDefinition("project", cur), condition: { op: "and", items: [cond("revenue", "gte")] } }),
  },
  {
    key: "daily_spend_ceiling",
    name: "Exemplo: investimento do dia acima do teto",
    description: "Avisa quando o investimento importado/sincronizado do dia passa do teto definido.",
    required: ["Teto de investimento"],
    definition: (cur) => ({ ...baseDefinition("project", cur), condition: { op: "and", items: [cond("spend", "gt")] } }),
  },
  {
    key: "pause_ad_without_sales",
    name: "Exemplo: pausar anúncio sem vendas",
    description: "Pausaria o anúncio que passar do gasto definido sem vendas. Depende da conexão de gestão Meta; até lá só simula.",
    required: ["Investimento a partir do qual pausar"],
    definition: (cur) => ({ ...baseDefinition("ad", cur), actions: [{ type: "notify" }, { type: "pause" }], condition: { op: "and", items: [cond("spend", "gte"), cond("approved_orders", "eq", "0")] } }),
  },
];

/** Validação semântica (a estrutural fica no servidor). Retorna a lista de problemas em linguagem simples. */
export function validateRuleDefinition(def: RuleDefinition): string[] {
  const errors: string[] = [];
  let count = 0;
  const walk = (g: RuleConditionGroup, depth: number) => {
    if (depth > 3) errors.push("Grupos de condições aninhados em mais de 3 níveis");
    if (!g.items.length) errors.push("Grupo de condições vazio");
    for (const it of g.items) {
      if ("items" in it) {
        walk(it, depth + 1);
        continue;
      }
      count++;
      if (!isRuleMetric(it.metric)) {
        errors.push(`Métrica desconhecida: ${String(it.metric)}`);
        continue;
      }
      const m = RULE_METRICS[it.metric];
      if (!(m.levels as readonly string[]).includes(def.level)) errors.push(`${m.label} não se aplica ao nível ${def.level}`);
      if (m.unit === "status") {
        if (!["eq", "neq"].includes(it.op)) errors.push(`${m.label} aceita apenas = ou ≠`);
        if (!/^[A-Z_]{2,40}$/i.test(it.value.trim())) errors.push(`${m.label}: valor de status inválido`);
        continue;
      }
      if (!it.value.trim()) errors.push(`Preencha o valor de "${m.label}"`);
      else {
        try {
          const r = thresholdToRatio(it.metric, it.value, def.currency);
          if (r.num < 0n && it.metric !== "contribution") errors.push(`${m.label} não pode ser negativo`);
          if ((m.unit === "count" || m.unit === "days") && r.den !== 1n && it.metric !== "approved_orders") errors.push(`${m.label} deve ser inteiro`);
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
    }
  };
  walk(def.condition, 1);
  if (count > 10) errors.push("No máximo 10 condições por regra");
  if (!(RULE_PERIODS as readonly string[]).includes(def.evaluation.period)) errors.push("Período inválido");
  for (const [k, metric] of [["min_spend", "spend"], ["min_orders", "approved_orders"], ["min_impressions", "impressions"]] as const) {
    const v = def.evaluation[k];
    if (v === null) continue;
    if (!v.trim()) errors.push(`Preencha o mínimo de ${RULE_METRICS[metric].label.toLowerCase()} (ou remova o mínimo)`);
    else {
      try {
        thresholdToRatio(metric, v, def.currency);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
  }
  if (!def.actions.length) errors.push("Escolha ao menos uma ação");
  if (def.actions.length > 5) errors.push("No máximo 5 ações por regra");
  const types = def.actions.map((a) => a.type);
  if (new Set(types).size !== types.length) errors.push("Ação repetida");
  if (types.includes("pause") && types.includes("activate")) errors.push("Pausar e ativar na mesma regra se anulam");
  if (def.level === "project" && types.some((t) => MEDIA_ACTIONS.has(t) || t === "tag")) errors.push("Regras de projeto só podem notificar ou chamar webhook");
  for (const a of def.actions) {
    if (a.type === "tag" && !/^[\p{L}\p{N} _-]{1,40}$/u.test(a.tag)) errors.push("Tag inválida (até 40 letras, números, espaço, _ ou -)");
    if (a.type === "budget") {
      if (a.mode === "percent" && !/^-?\d{1,3}(\.\d+)?$/.test(a.value)) errors.push("Ajuste percentual inválido");
      if (a.mode === "absolute" && !/^\d+(\.\d+)?$/.test(a.value)) errors.push("Orçamento absoluto inválido");
      if (def.limits.max_budget_change_pct === null) errors.push("Ajuste de orçamento exige variação máxima");
    }
  }
  if (def.limits.cooldown_minutes < 15 || def.limits.cooldown_minutes > 7 * 1440) errors.push("Intervalo mínimo entre ações deve ficar entre 15 min e 7 dias");
  if (def.limits.max_actions_per_day < 1 || def.limits.max_actions_per_day > 500) errors.push("Limite diário de ações deve ficar entre 1 e 500");
  if (!(RULE_SCHEDULES as readonly number[]).includes(def.schedule.every_minutes)) errors.push("Frequência de avaliação inválida");
  if (def.schedule.active_hours && (!isValidHhMm(def.schedule.active_hours.start) || !isValidHhMm(def.schedule.active_hours.end))) errors.push("Horário de atuação inválido (HH:MM)");
  if (def.evaluation.conversion_delay_hours < 0 || def.evaluation.conversion_delay_hours > 72) errors.push("Atraso de conversão deve ficar entre 0 e 72 h");
  if (def.evaluation.min_age_days < 0 || def.evaluation.min_age_days > 60) errors.push("Idade mínima deve ficar entre 0 e 60 dias");
  return [...new Set(errors)];
}
