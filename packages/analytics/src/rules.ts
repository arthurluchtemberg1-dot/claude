import type { PoolClient } from "@tracker/db";
import {
  decideEntity,
  entityRuleMetrics,
  formatRuleValue,
  localDateOf,
  moneyValue,
  countValue,
  parseRatio,
  rulePeriodRange,
  RULE_METRICS,
  type DecisionContext,
  type MetricResult,
  type RuleDecision,
  type RuleDefinition,
  type RuleMetricKey,
  type RuleMetricValue,
} from "@tracker/domain";
import { computeBreakdown, type BreakdownDimension } from "./breakdown";
import { computeScopeMetrics } from "./metrics-repo";

/**
 * Avaliação de regras SEM efeitos (R26-04): carrega as entidades do escopo com as mesmas consultas do painel
 * (detalhamento por campanha/conjunto/anúncio ou resumo do projeto), calcula as métricas no domínio e decide.
 * Usada pela simulação na API e pela execução no worker (que então aplica as ações).
 */

export interface RuleEvalInput {
  organizationId: string;
  ruleId: string | null;
  definition: RuleDefinition;
  mode: "simulate" | "execute";
  now: Date;
  timezone: string;
  declaredZeroCosts: string[];
  /** Projetos excluídos por parada de emergência (R26-11). */
  pausedProjectIds?: string[];
}

export interface EvaluatedEntity {
  level: RuleDefinition["level"];
  id: string | null;
  name: string;
  projectId: string | null;
  metrics: Record<string, string>;
  rawMetrics: Record<RuleMetricKey, RuleMetricValue>;
  decision: RuleDecision;
}

export interface RuleEvaluation {
  asOf: Date;
  window: { from: string; to: string };
  freshness: DecisionContext["freshness"] & { spend_through: string | null };
  entities: EvaluatedEntity[];
  truncated: boolean;
  notes: string[];
}

const MAX_ENTITIES = 500;

function fromMetric(m: MetricResult | undefined): RuleMetricValue {
  if (!m) return { status: "unavailable", reason: "Métrica não calculada" };
  if (m.status !== "ok") return { status: m.status, reason: m.reason };
  if (m.unit === "money") return moneyValue(m.amountMinor);
  return countValue(m.value);
}

async function recentActionContext(c: PoolClient, orgId: string, ruleId: string | null, def: RuleDefinition, entityIds: (string | null)[], now: Date, timezone: string) {
  const last = new Map<string, number>();
  const conflicts = new Map<string, string>();
  let actionsToday = 0;
  if (!ruleId) return { last, conflicts, actionsToday };
  const ids = entityIds.map((e) => e ?? "");
  for (const r of (
    await c.query(
      "select coalesce(entity_id, '') as entity_id, max(executed_at) as at from public.rule_actions where organization_id = $1 and rule_id = $2 and status = 'executed' and coalesce(entity_id, '') = any($3) group by 1",
      [orgId, ruleId, ids],
    )
  ).rows)
    last.set(r.entity_id, (now.getTime() - new Date(r.at).getTime()) / 60_000);
  const today = localDateOf(now, timezone);
  actionsToday = (
    await c.query(
      "select count(distinct coalesce(entity_id, '') || ':' || run_id)::int as n from public.rule_actions where organization_id = $1 and rule_id = $2 and status = 'executed' and (executed_at at time zone $3)::date = $4::date",
      [orgId, ruleId, timezone, today],
    )
  ).rows[0].n;
  // Conflito (R26-08): ação oposta de OUTRA regra na mesma entidade dentro do intervalo mínimo desta regra.
  const opposite: Record<string, string> = { pause: "activate", activate: "pause" };
  const mine = def.actions.map((a) => a.type).filter((t) => opposite[t]);
  if (mine.length) {
    for (const r of (
      await c.query(
        `select a.entity_id, a.action_type, r.name, a.executed_at from public.rule_actions a join public.rules r on r.organization_id = a.organization_id and r.id = a.rule_id
          where a.organization_id = $1 and a.rule_id <> $2 and a.entity_level = $3 and a.entity_id = any($4) and a.status = 'executed'
            and a.action_type = any($5) and a.executed_at > $6::timestamptz - make_interval(mins => $7)`,
        [orgId, ruleId, def.level, ids, mine.map((t) => opposite[t]), now, def.limits.cooldown_minutes],
      )
    ).rows)
      conflicts.set(r.entity_id, `A regra "${r.name}" executou "${r.action_type}" nesta entidade em ${new Date(r.executed_at).toISOString()}`);
  }
  return { last, conflicts, actionsToday };
}

export async function evaluateRule(c: PoolClient, input: RuleEvalInput): Promise<RuleEvaluation> {
  const def = input.definition;
  const asOf = new Date(input.now.getTime() - def.evaluation.conversion_delay_hours * 3600_000);
  const window = rulePeriodRange(def.evaluation.period, localDateOf(asOf, input.timezone));
  const paused = new Set(input.pausedProjectIds ?? []);
  let projectIds: string[] | null = def.scope.project_ids.length ? def.scope.project_ids.filter((p) => !paused.has(p)) : null;
  if (!projectIds && paused.size) projectIds = (await c.query("select id from public.projects where organization_id = $1 and archived_at is null", [input.organizationId])).rows.map((r) => r.id).filter((id: string) => !paused.has(id));
  const notes: string[] = [];
  if (paused.size) notes.push(`${paused.size} projeto(s) com regras pausadas excluído(s) da avaliação`);
  if (projectIds && !projectIds.length) return { asOf, window, freshness: { ok: false, reason: "Todos os projetos do escopo estão com regras pausadas", spend_through: null }, entities: [], truncated: false, notes };

  // Atualidade do gasto (R26-09): o gasto do escopo precisa cobrir a janela até o fim.
  const fr = (
    await c.query(
      `select max(s.spend_date)::text as through from public.ad_spend_daily s join public.ad_accounts a on a.organization_id = s.organization_id and a.id = s.ad_account_id
        where s.organization_id = $1 and s.currency = $2 and ($3::uuid[] is null or s.project_id is null or s.project_id = any($3)) and ($4::text is null or a.network = $4)`,
      [input.organizationId, def.currency, projectIds, def.scope.network],
    )
  ).rows[0];
  const through: string | null = fr?.through ?? null;
  const freshness: RuleEvaluation["freshness"] = !through
    ? { ok: false, reason: "Nenhum gasto importado/sincronizado para o escopo; regras com investimento, CPA ou ROAS não decidem sem esse dado", spend_through: null }
    : through < window.to
      ? { ok: false, reason: `Gasto disponível só até ${through.split("-").reverse().join("/")}; a janela avaliada vai até ${window.to.split("-").reverse().join("/")}`, spend_through: through }
      : { ok: true, spend_through: through };

  const base = { organizationId: input.organizationId, projectIds, from: window.from, to: window.to, timezone: input.timezone, basis: "approval" as const, asOf, includeTest: false, policyKey: def.evaluation.attribution_policy };
  const rows: (Omit<EvaluatedEntity, "decision" | "metrics"> & { learning?: boolean | null })[] = [];
  let truncated = false;
  if (def.level === "project") {
    const targets: { id: string | null; name: string; projects: string[] | null }[] = def.scope.project_ids.length
      ? (await c.query("select id, name from public.projects where organization_id = $1 and id = any($2)", [input.organizationId, projectIds])).rows.map((p) => ({ id: p.id, name: p.name, projects: [p.id] }))
      : [{ id: null, name: "Todos os projetos", projects: projectIds }];
    for (const t of targets) {
      const groups = await computeScopeMetrics(c, { ...base, projectIds: t.projects, declaredZeroCosts: input.declaredZeroCosts });
      const g = groups.find((x) => x.currency === def.currency);
      const m = new Map<string, MetricResult>(Object.entries(g?.metrics ?? {}));
      const raw: Record<RuleMetricKey, RuleMetricValue> = Object.fromEntries(
        (Object.keys(RULE_METRICS) as RuleMetricKey[]).map((k) => [k, { status: "unavailable", reason: (RULE_METRICS[k] as { unavailableReason?: string }).unavailableReason ?? "Não se aplica ao projeto" } as RuleMetricValue]),
      ) as Record<RuleMetricKey, RuleMetricValue>;
      Object.assign(raw, {
        spend: fromMetric(m.get("media_spend")),
        approved_orders: fromMetric(m.get("approved_orders_gross")),
        revenue: fromMetric(m.get("gross_approved_revenue")),
        revenue_net: fromMetric(m.get("revenue_after_reversals")),
        cpa: fromMetric(m.get("cpa_approved")),
        roas: fromMetric(m.get("roas_gross")),
        contribution: fromMetric(m.get("contribution_after_media")),
        ctr: fromMetric(m.get("link_ctr")),
        cpc: fromMetric(m.get("link_cpc")),
        cpm: fromMetric(m.get("cpm")),
      });
      // Sem pedidos e sem gasto na moeda: grupo ausente — receita/vendas zero são fatos do registro (não dado ausente).
      if (!g) {
        raw.revenue = moneyValue(0n);
        raw.revenue_net = moneyValue(0n);
        raw.approved_orders = countValue(0n);
      }
      rows.push({ level: "project", id: t.id, name: t.name, projectId: t.id, rawMetrics: raw });
    }
  } else {
    const groups = await computeBreakdown(c, { ...base, dimension: def.level as BreakdownDimension, campaignId: null });
    const g = groups.find((x) => x.currency === def.currency);
    let list = (g?.rows ?? []).filter((r) => r.id);
    truncated = !!g?.truncated;
    if (def.scope.network) list = list.filter((r) => r.network === def.scope.network);
    if (def.scope.entity_ids.length) list = list.filter((r) => def.scope.entity_ids.includes(r.id!));
    if (def.scope.name_contains) {
      const q = def.scope.name_contains.toLocaleLowerCase("pt-BR");
      list = list.filter((r) => (r.name ?? "").toLocaleLowerCase("pt-BR").includes(q));
    }
    if (list.length > MAX_ENTITIES) {
      truncated = true;
      list = list.slice(0, MAX_ENTITIES);
    }
    const ids = list.map((r) => r.id!);
    const ages = new Map<string, string>(
      ids.length
        ? (
            await c.query(
              "select entity_external_id as id, min(spend_date)::text as first from public.ad_spend_daily where organization_id = $1 and level = $2 and entity_external_id = any($3) group by 1",
              [input.organizationId, def.level, ids],
            )
          ).rows.map((r) => [r.id, r.first])
        : [],
    );
    // Estado na Meta (sincronização): status configurado, orçamento diário e aprendizagem (conjunto; anúncio herda do
    // conjunto; campanha em aprendizado se algum conjunto dela estiver).
    const ents = new Map<string, { status: string | null; budget: bigint | null; learning: boolean | null }>();
    if (ids.length) {
      const rowsE = (
        await c.query(
          `select e.external_id, e.status, e.daily_budget_minor,
                  case when $2 = 'adset' then e.learning_status
                       when $2 = 'ad' then (select s.learning_status from public.ad_entities s where s.organization_id = e.organization_id and s.level = 'adset' and s.external_id = e.adset_external_id limit 1)
                       else (select case when bool_or(s.learning_status = 'LEARNING') then 'LEARNING' when count(s.learning_status) > 0 then 'SUCCESS' end
                               from public.ad_entities s where s.organization_id = e.organization_id and s.level = 'adset' and s.campaign_external_id = e.external_id and s.status = 'ACTIVE') end as learning
             from public.ad_entities e where e.organization_id = $1 and e.level = $2 and e.external_id = any($3)`,
          [input.organizationId, def.level, ids],
        )
      ).rows;
      for (const r of rowsE) ents.set(r.external_id, { status: r.status, budget: r.daily_budget_minor === null ? null : BigInt(r.daily_budget_minor), learning: r.learning === null ? null : r.learning === "LEARNING" });
    }
    const today = window.to;
    for (const r of list) {
      const first = ages.get(r.id!);
      const ageDays = first ? Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${first}T12:00:00Z`)) / 86_400_000) : null;
      const raw = entityRuleMetrics({
        spendMinor: r.spend_minor,
        impressions: r.impressions,
        linkClicks: r.link_clicks,
        ordersCredit: parseRatio(r.orders_credit_fraction),
        grossMinor: r.attributed_gross_minor,
        netMinor: r.attributed_net_minor,
        ageDays,
        status: ents.get(r.id!)?.status ?? null,
        dailyBudgetMinor: ents.get(r.id!)?.budget ?? null,
      });
      rows.push({ level: def.level, id: r.id, name: r.name ?? `ID ${r.id}`, projectId: null, rawMetrics: raw, learning: ents.get(r.id!)?.learning ?? null });
    }
  }

  const ctx = await recentActionContext(c, input.organizationId, input.ruleId, def, rows.map((r) => r.id), input.now, input.timezone);
  // Teto diário aplicado de forma incremental dentro da mesma execução (R26-06).
  let actionsToday = ctx.actionsToday;
  const used = new Set<RuleMetricKey>(["spend", "approved_orders", "revenue", "cpa", "roas"]);
  for (const m of JSON.stringify(def.condition).matchAll(/"metric":"([a-z_]+)"/g)) used.add(m[1] as RuleMetricKey);
  const entities: EvaluatedEntity[] = [];
  for (const r of rows) {
    const key = r.id ?? "";
    const decision = decideEntity(def, r.rawMetrics, {
      mode: input.mode,
      freshness,
      minutesSinceLastAction: ctx.last.get(key) ?? null,
      actionsToday,
      conflictingAction: ctx.conflicts.get(key) ?? null,
      learning: r.learning ?? null,
    });
    if (decision.kind === "execute" || decision.kind === "would_execute") actionsToday++;
    const metrics = Object.fromEntries([...used].filter((k) => r.rawMetrics[k]).map((k) => [k, formatRuleValue(k, r.rawMetrics[k], def.currency)]));
    const { learning: _l, ...rest } = r;
    void _l;
    entities.push({ ...rest, metrics, decision });
  }
  return { asOf, window, freshness, entities, truncated, notes };
}
