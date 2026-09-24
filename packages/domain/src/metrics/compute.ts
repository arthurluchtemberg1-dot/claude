import { divRoundHalfEven } from "../money";
import { METRIC_DEFINITIONS, type MetricId, type TimeBasis } from "./definitions";
import { ratio, ratioToDecimalString, type Ratio } from "./ratio";

/**
 * Serviço de métricas (R22-01). Recebe agregados brutos (somas/contagens obtidas do banco) e aplica
 * as fórmulas do registro. Nenhuma fórmula financeira deve existir fora deste módulo (R05-11).
 */

export type MetricQuality = "complete" | "partial" | "estimated";

export type MetricResult =
  | {
      readonly id: MetricId;
      readonly status: "ok";
      readonly unit: "money";
      readonly amountMinor: bigint;
      readonly currency: string;
      readonly quality: MetricQuality;
      readonly notes: readonly string[];
    }
  | {
      readonly id: MetricId;
      readonly status: "ok";
      readonly unit: "count";
      /** Contagem inteira ou creditada (fracionada) — ver `fractional`. */
      readonly value: Ratio;
      readonly fractional: boolean;
      readonly quality: MetricQuality;
      readonly notes: readonly string[];
    }
  | {
      readonly id: MetricId;
      readonly status: "ok";
      readonly unit: "ratio" | "percent";
      readonly value: Ratio;
      readonly quality: MetricQuality;
      readonly notes: readonly string[];
    }
  | {
      readonly id: MetricId;
      /** Denominador zero/inexistente → exibir "—" com a razão (R22-05, T50). */
      readonly status: "undefined";
      readonly reason: string;
      readonly notes: readonly string[];
    }
  | {
      readonly id: MetricId;
      /** Dado ausente/indisponível: nunca convertido em zero (R03-07). */
      readonly status: "unavailable";
      readonly reason: string;
      readonly notes: readonly string[];
    };

/** Contagem que pode ser fracionada (atribuição linear): num/den. */
export type CreditCount = Ratio;

export interface FinancialInputs {
  readonly currency: string;
  readonly basis: TimeBasis;
  readonly asOf: Date;
  /** null = checkout não envia pedidos não aprovados (indisponível, não zero). */
  readonly ordersGenerated: number | null;
  readonly approvedOrders: number;
  readonly retainedOrders: number;
  readonly grossApprovedMinor: bigint;
  /** Estornos efetivos (valor positivo): reembolsos + chargebacks − disputas ganhas. */
  readonly reversalsMinor: bigint;
  readonly orgRevenue: {
    /** Participação informada pela origem, já após reversões (ledger org_share + org_share_reversal). */
    readonly withShareNetMinor: bigint;
    readonly withShareTransactions: number;
    readonly withShareHasEstimatedReversal: boolean;
    /** Transações de pedidos em que a organização é produtora, sem participação informada: bruto após estornos. */
    readonly producerNoShareNetMinor: bigint;
    readonly producerNoShareTransactions: number;
    /** Transações de afiliado/coprodutor sem participação informada: receita desconhecida. */
    readonly otherRoleNoShareTransactions: number;
  };
  readonly fees: {
    /** Taxas informadas pela origem (positivo) para transações cuja receita não veio líquida. */
    readonly providerReportedMinor: bigint;
    /** Taxas estimadas por tabela vigente (positivo). null = sem tabela configurada. */
    readonly estimatedMinor: bigint | null;
    /** Transações sem taxa informada nem estimada. */
    readonly transactionsWithoutFee: number;
  };
  /** Pedidos com tentativa de pagamento conhecida (inclui recusados/pendentes). null = conector não informa. */
  readonly ordersWithPaymentAttempt: number | null;
}

export interface AttributionInputs {
  /** Nome/versão da política usada (exibido junto às métricas). */
  readonly policyLabel: string;
  readonly attributedGrossMinor: bigint;
  readonly attributedAfterReversalsMinor: bigint;
  readonly approvedCredit: CreditCount;
  readonly retainedCredit: CreditCount;
  readonly fractional: boolean;
  readonly unattributedOrders: number;
}

export interface MediaInputs {
  /** null = sem fonte de gasto conectada/importada para o escopo (indisponível). */
  readonly spendMinor: bigint | null;
  readonly spendCurrency: string | null;
  readonly coverage: "complete" | "partial" | "none";
  readonly coverageNotes: readonly string[];
  readonly impressions: bigint | null;
  readonly linkClicks: bigint | null;
}

export interface CostInputs {
  /** Custos variáveis adicionais conhecidos (produto, frete, impostos estimados...), positivo. */
  readonly otherVariableCostsMinor: bigint;
  /** Categorias de custo material não configuradas (ex.: "impostos", "custo de produto"). */
  readonly missingCostCategories: readonly string[];
  /** Despesas operacionais incluídas no período (positivo). null = não configuradas. */
  readonly operatingExpensesMinor: bigint | null;
  readonly allocationCriteria: string | null;
}

export interface LeadInputs {
  readonly dedupedLeads: number | null;
  readonly eligibleSessions: number | null;
}

export interface MetricsInput {
  readonly financial: FinancialInputs;
  readonly attribution: AttributionInputs | null;
  readonly media: MediaInputs;
  readonly costs: CostInputs;
  readonly leads: LeadInputs;
}

const whole = (n: number | bigint): Ratio => ratio(BigInt(n), 1n);

function money(id: MetricId, amountMinor: bigint, currency: string, quality: MetricQuality, notes: string[] = []): MetricResult {
  return { id, status: "ok", unit: "money", amountMinor, currency, quality, notes };
}

function undef(id: MetricId, reason: string, notes: string[] = []): MetricResult {
  return { id, status: "undefined", reason, notes };
}

function unavailable(id: MetricId, reason: string, notes: string[] = []): MetricResult {
  return { id, status: "unavailable", reason, notes };
}

function isZero(r: Ratio): boolean {
  return r.num === 0n;
}

/** Divide dinheiro por uma contagem (possivelmente fracionada), arredondando half-even na menor unidade. */
function moneyPer(amountMinor: bigint, count: Ratio): bigint {
  return divRoundHalfEven(amountMinor * count.den, count.num);
}

export function computeMetrics(input: MetricsInput): Record<MetricId, MetricResult> {
  const f = input.financial;
  const cur = f.currency;
  const out = {} as Record<MetricId, MetricResult>;
  const spendUsable =
    input.media.spendMinor !== null && input.media.spendCurrency === cur && input.media.coverage !== "none";
  const spendQuality: MetricQuality = input.media.coverage === "complete" ? "complete" : "partial";
  const spendNotes = [...input.media.coverageNotes];
  const spendReason =
    input.media.spendMinor === null || input.media.coverage === "none"
      ? "Sem gasto de mídia sincronizado ou importado para o escopo"
      : input.media.spendCurrency !== cur
        ? `Gasto em ${input.media.spendCurrency} e receita em ${cur}: sem câmbio configurado, moedas não são misturadas`
        : "";

  out.orders_generated =
    f.ordersGenerated === null
      ? unavailable("orders_generated", "O conector não informa pedidos não aprovados")
      : { id: "orders_generated", status: "ok", unit: "count", value: whole(f.ordersGenerated), fractional: false, quality: "complete", notes: [] };

  out.approved_orders_gross = { id: "approved_orders_gross", status: "ok", unit: "count", value: whole(f.approvedOrders), fractional: false, quality: "complete", notes: [] };
  out.retained_orders = {
    id: "retained_orders",
    status: "ok",
    unit: "count",
    value: whole(f.retainedOrders),
    fractional: false,
    quality: "complete",
    notes: [`Estornos considerados até ${f.asOf.toISOString()}`],
  };
  out.gross_approved_revenue = money("gross_approved_revenue", f.grossApprovedMinor, cur, "complete");
  out.financial_reversals = money("financial_reversals", f.reversalsMinor, cur, "complete");
  const revenueAfter = f.grossApprovedMinor - f.reversalsMinor;
  out.revenue_after_reversals = money("revenue_after_reversals", revenueAfter, cur, "complete");

  // Receita da organização (R10-15, R22-04, T51)
  const or = f.orgRevenue;
  const orgKnown = or.withShareNetMinor + or.producerNoShareNetMinor;
  const orgTxKnown = or.withShareTransactions + or.producerNoShareTransactions;
  let orgRevenue: MetricResult;
  let orgRevenueMinor: bigint | null = null;
  let orgRevenueQuality: MetricQuality = "complete";
  let orgRevenueReason = "";
  if (orgTxKnown === 0 && or.otherRoleNoShareTransactions > 0) {
    orgRevenueReason = "Participação/comissão não informada pela origem para pedidos de afiliado/coprodutor";
    orgRevenue = unavailable("org_revenue", orgRevenueReason);
  } else {
    const notes: string[] = [];
    let quality: MetricQuality = "complete";
    if (or.otherRoleNoShareTransactions > 0) {
      quality = "partial";
      notes.push(`${or.otherRoleNoShareTransactions} transação(ões) de afiliado/coprodutor sem participação informada não incluídas`);
    }
    if (or.withShareHasEstimatedReversal) {
      if (quality === "complete") quality = "estimated";
      notes.push("Redução da participação por estorno estimada proporcionalmente");
    }
    orgRevenue = money("org_revenue", orgKnown, cur, quality, notes);
    orgRevenueMinor = orgKnown;
    orgRevenueQuality = quality;
  }
  out.org_revenue = orgRevenue;

  out.media_spend = spendUsable
    ? money("media_spend", input.media.spendMinor!, cur, spendQuality, spendNotes)
    : unavailable("media_spend", spendReason, spendNotes);

  // Atribuição
  const a = input.attribution;
  const spend = input.media.spendMinor ?? 0n;
  const attrNote = a ? [`Política: ${a.policyLabel}`] : [];
  if (!a) {
    for (const id of ["roas_gross", "roas_after_reversals", "cpa_approved", "cpa_retained", "unattributed_orders"] as const) {
      out[id] = unavailable(id, "Nenhuma política de atribuição aplicada ao escopo");
    }
  } else {
    out.unattributed_orders = { id: "unattributed_orders", status: "ok", unit: "count", value: whole(a.unattributedOrders), fractional: false, quality: "complete", notes: attrNote };
    if (!spendUsable) {
      for (const id of ["roas_gross", "roas_after_reversals", "cpa_approved", "cpa_retained"] as const) {
        out[id] = unavailable(id, spendReason, attrNote);
      }
    } else if (spend === 0n) {
      out.roas_gross = undef("roas_gross", "Investimento zero no período", attrNote);
      out.roas_after_reversals = undef("roas_after_reversals", "Investimento zero no período", attrNote);
      out.cpa_approved = isZero(a.approvedCredit)
        ? undef("cpa_approved", "Nenhum pedido aprovado creditado", attrNote)
        : money("cpa_approved", 0n, cur, spendQuality, attrNote);
      out.cpa_retained = isZero(a.retainedCredit)
        ? undef("cpa_retained", "Nenhum pedido retido creditado", attrNote)
        : money("cpa_retained", 0n, cur, spendQuality, attrNote);
    } else {
      out.roas_gross = { id: "roas_gross", status: "ok", unit: "ratio", value: ratio(a.attributedGrossMinor, spend), quality: spendQuality, notes: attrNote };
      out.roas_after_reversals = { id: "roas_after_reversals", status: "ok", unit: "ratio", value: ratio(a.attributedAfterReversalsMinor, spend), quality: spendQuality, notes: attrNote };
      const fracNote = a.fractional ? ["Pedidos creditados fracionados (conversões creditadas, não pedidos inteiros)"] : [];
      out.cpa_approved = isZero(a.approvedCredit)
        ? undef("cpa_approved", "Nenhum pedido aprovado creditado", attrNote)
        : money("cpa_approved", moneyPer(spend, a.approvedCredit), cur, spendQuality, [...attrNote, ...fracNote]);
      out.cpa_retained = isZero(a.retainedCredit)
        ? undef("cpa_retained", "Nenhum pedido retido creditado", attrNote)
        : money("cpa_retained", moneyPer(spend, a.retainedCredit), cur, spendQuality, [...attrNote, ...fracNote]);
    }
  }

  // MER: receita total / gasto total
  if (!spendUsable) out.mer = unavailable("mer", spendReason);
  else if (spend === 0n) out.mer = undef("mer", "Gasto total de mídia zero");
  else out.mer = { id: "mer", status: "ok", unit: "ratio", value: ratio(revenueAfter, spend), quality: spendQuality, notes: ["Receita após estornos da operação / gasto total — não é ROAS atribuído"] };

  out.avg_ticket_gross =
    f.approvedOrders === 0
      ? undef("avg_ticket_gross", "Nenhum pedido aprovado")
      : money("avg_ticket_gross", divRoundHalfEven(f.grossApprovedMinor, BigInt(f.approvedOrders)), cur, "complete");

  // Leads/CPL
  const leads = input.leads.dedupedLeads;
  if (leads === null) out.cpl = unavailable("cpl", "Leads não medidos para o escopo");
  else if (!spendUsable) out.cpl = unavailable("cpl", spendReason);
  else if (leads === 0) out.cpl = undef("cpl", "Nenhum lead deduplicado");
  else out.cpl = money("cpl", divRoundHalfEven(spend, BigInt(leads)), cur, spendQuality);

  // Métricas de entrega reportadas pela rede
  const imp = input.media.impressions;
  const clicks = input.media.linkClicks;
  if (imp === null || clicks === null) out.link_ctr = unavailable("link_ctr", "Impressões/cliques não sincronizados");
  else if (imp === 0n) out.link_ctr = undef("link_ctr", "Zero impressões");
  else out.link_ctr = { id: "link_ctr", status: "ok", unit: "percent", value: ratio(clicks * 100n, imp), quality: spendQuality, notes: [] };

  if (!spendUsable) out.link_cpc = unavailable("link_cpc", spendReason);
  else if (clicks === null) out.link_cpc = unavailable("link_cpc", "Cliques no link não sincronizados");
  else if (clicks === 0n) out.link_cpc = undef("link_cpc", "Zero cliques no link");
  else out.link_cpc = money("link_cpc", divRoundHalfEven(spend, clicks), cur, spendQuality);

  if (!spendUsable) out.cpm = unavailable("cpm", spendReason);
  else if (imp === null) out.cpm = unavailable("cpm", "Impressões não sincronizadas");
  else if (imp === 0n) out.cpm = undef("cpm", "Zero impressões");
  else out.cpm = money("cpm", divRoundHalfEven(spend * 1000n, imp), cur, spendQuality);

  const sessions = input.leads.eligibleSessions;
  if (sessions === null || !a) out.page_conversion = unavailable("page_conversion", "Sessões observadas ou atribuição indisponíveis");
  else if (sessions === 0) out.page_conversion = undef("page_conversion", "Nenhuma sessão elegível observada");
  else
    out.page_conversion = {
      id: "page_conversion",
      status: "ok",
      unit: "percent",
      value: ratio(a.approvedCredit.num * 100n, a.approvedCredit.den * BigInt(sessions)),
      quality: "partial",
      notes: ["Somente sessões observadas pelo SDK com consentimento"],
    };

  if (f.ordersWithPaymentAttempt === null) out.payment_approval_rate = unavailable("payment_approval_rate", "O conector não informa tentativas de pagamento");
  else if (f.ordersWithPaymentAttempt === 0) out.payment_approval_rate = undef("payment_approval_rate", "Nenhum pedido com tentativa de pagamento");
  else out.payment_approval_rate = { id: "payment_approval_rate", status: "ok", unit: "percent", value: ratio(BigInt(f.approvedOrders) * 100n, BigInt(f.ordersWithPaymentAttempt)), quality: "complete", notes: [] };

  // Taxas
  const feeNotes: string[] = [];
  let feeQuality: MetricQuality = "complete";
  let feesTotal = f.fees.providerReportedMinor;
  if (f.fees.estimatedMinor !== null && f.fees.estimatedMinor > 0n) {
    feesTotal += f.fees.estimatedMinor;
    feeQuality = "estimated";
    feeNotes.push("Inclui taxas estimadas por tabela vigente");
  }
  if (f.fees.transactionsWithoutFee > 0) {
    feeQuality = "partial";
    feeNotes.push(`${f.fees.transactionsWithoutFee} transação(ões) sem taxa informada nem tabela configurada`);
  }
  out.fees = money("fees", feesTotal, cur, feeQuality, feeNotes);

  // Contribuição e resultado (R22-08)
  const missing: string[] = [...input.costs.missingCostCategories];
  if (f.fees.transactionsWithoutFee > 0) missing.push("taxas de transação");
  if (orgRevenueMinor === null) {
    out.contribution_after_media = unavailable("contribution_after_media", orgRevenueReason);
    out.operating_result_estimated = unavailable("operating_result_estimated", orgRevenueReason);
    out.breakeven_roas = unavailable("breakeven_roas", orgRevenueReason);
  } else {
    const variable = feesTotal + input.costs.otherVariableCostsMinor;
    const beforeMedia = orgRevenueMinor - variable;
    const partial = missing.length > 0 || orgRevenueQuality === "partial";
    const baseQuality: MetricQuality = partial ? "partial" : feeQuality === "estimated" || orgRevenueQuality === "estimated" ? "estimated" : "complete";
    const missingNote = missing.length ? [`Resultado parcial — custos faltantes: ${missing.join(", ")}`] : [];
    if (!spendUsable) {
      out.contribution_after_media = unavailable("contribution_after_media", spendReason);
      out.operating_result_estimated = unavailable("operating_result_estimated", spendReason);
    } else {
      const contribution = beforeMedia - spend;
      const q: MetricQuality = spendQuality === "partial" ? "partial" : baseQuality;
      out.contribution_after_media = money("contribution_after_media", contribution, cur, q, [...missingNote, ...spendNotes]);
      if (input.costs.operatingExpensesMinor === null) {
        out.operating_result_estimated = unavailable("operating_result_estimated", "Despesas operacionais não configuradas para o período");
      } else {
        out.operating_result_estimated = money(
          "operating_result_estimated",
          contribution - input.costs.operatingExpensesMinor,
          cur,
          q === "complete" ? "estimated" : q,
          [...missingNote, `Rateio: ${input.costs.allocationCriteria ?? "não informado"}`],
        );
      }
    }
    // ROAS de equilíbrio = 1 / margem de contribuição antes da mídia
    if (missing.length > 0) out.breakeven_roas = unavailable("breakeven_roas", `Custos materiais ausentes: ${missing.join(", ")}`);
    else if (orgRevenueMinor <= 0n) out.breakeven_roas = undef("breakeven_roas", "Receita da organização não positiva");
    else if (beforeMedia <= 0n) out.breakeven_roas = undef("breakeven_roas", "Margem de contribuição antes da mídia não positiva");
    else out.breakeven_roas = { id: "breakeven_roas", status: "ok", unit: "ratio", value: ratio(orgRevenueMinor, beforeMedia), quality: baseQuality, notes: ["1 / (margem antes da mídia ÷ receita da organização)"] };
  }

  return out;
}

/** Serialização estável para API/JSON (bigint → string, razão → decimal com 10 casas). */
export function serializeMetric(m: MetricResult): Record<string, unknown> {
  const def = METRIC_DEFINITIONS[m.id];
  const base = { id: m.id, label: def.label, unit: def.unit, formula: def.formula, denominator: def.denominator, source: def.source };
  if (m.status === "ok") {
    if (m.unit === "money") return { ...base, status: m.status, amount_minor: m.amountMinor.toString(), currency: m.currency, quality: m.quality, notes: m.notes };
    const value = ratioToDecimalString(m.value, 10);
    return { ...base, status: m.status, value, fraction: { num: m.value.num.toString(), den: m.value.den.toString() }, ...(m.unit === "count" ? { fractional: m.fractional } : {}), quality: m.quality, notes: m.notes };
  }
  return { ...base, status: m.status, reason: m.reason, notes: m.notes };
}
