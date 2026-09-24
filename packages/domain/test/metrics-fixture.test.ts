import { describe, expect, it } from "vitest";
import {
  applyFinancialEvent,
  computeMetrics,
  emptyOrderState,
  ratioToDecimalString,
  serializeMetric,
  type FinancialEvent,
  type LedgerEntry,
  type MetricResult,
  type MetricsInput,
  type OrderAggregateState,
} from "../src";

/**
 * Fixture financeira sintética obrigatória (seção 43, R43-02).
 * Dois pedidos confirmados de R$100 e R$50; investimento R$30; taxas totais efetivas R$5;
 * estorno parcial de R$20 no primeiro e integral de R$50 no segundo. Mesma moeda, projeto, período e fonte;
 * demais custos explicitamente zero apenas nesta fixture.
 */

const d = (s: string) => new Date(s);

const ORDER_A: FinancialEvent[] = [
  { type: "payment.approved", transactionKey: "A-tx", amountMinor: 10000n, currency: "BRL", method: "pix", occurredAt: d("2026-09-10T13:00:00Z"), kind: "initial", feeMinor: 300n },
  { type: "refund.succeeded", transactionKey: "A-tx", reversalKey: "A-r1", amountMinor: 2000n, semantics: "incremental", currency: "BRL", occurredAt: d("2026-09-12T13:00:00Z") },
];
const ORDER_B: FinancialEvent[] = [
  { type: "payment.approved", transactionKey: "B-tx", amountMinor: 5000n, currency: "BRL", method: "credit_card", occurredAt: d("2026-09-11T13:00:00Z"), kind: "initial", feeMinor: 200n },
  { type: "refund.succeeded", transactionKey: "B-tx", reversalKey: "B-r1", amountMinor: null, semantics: "full", currency: "BRL", occurredAt: d("2026-09-13T13:00:00Z") },
];

function replay(events: FinancialEvent[], times: number) {
  let state: OrderAggregateState = emptyOrderState();
  const ledger: LedgerEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < times; i++) {
    for (const e of events) {
      const r = applyFinancialEvent(state, e);
      state = r.state;
      for (const l of r.ledger) {
        // O banco garante unicidade da chave semântica; aqui reproduzimos a mesma regra.
        if (!seen.has(l.semanticKey)) {
          seen.add(l.semanticKey);
          ledger.push(l);
        }
      }
    }
  }
  return { state, ledger };
}

function aggregate(orders: { state: OrderAggregateState; ledger: LedgerEntry[] }[]): MetricsInput {
  const all = orders.flatMap((o) => o.ledger);
  const sum = (types: LedgerEntry["type"][]) => all.filter((l) => types.includes(l.type)).reduce((a, l) => a + l.amountMinor, 0n);
  const approvedOrders = orders.filter((o) => o.ledger.some((l) => l.type === "approval")).length;
  const retained = orders.filter((o) => {
    const net = o.ledger.filter((l) => ["approval", "refund", "chargeback", "chargeback_reversal"].includes(l.type)).reduce((a, l) => a + l.amountMinor, 0n);
    return net > 0n;
  }).length;
  const gross = sum(["approval"]);
  const reversals = -sum(["refund", "chargeback", "chargeback_reversal"]);
  return {
    financial: {
      currency: "BRL",
      basis: "approval",
      asOf: d("2026-09-30T00:00:00Z"),
      ordersGenerated: null,
      approvedOrders,
      retainedOrders: retained,
      grossApprovedMinor: gross,
      reversalsMinor: reversals,
      orgRevenue: {
        withShareNetMinor: 0n,
        withShareTransactions: 0,
        withShareHasEstimatedReversal: false,
        producerNoShareNetMinor: gross - reversals,
        producerNoShareTransactions: 2,
        otherRoleNoShareTransactions: 0,
      },
      fees: { providerReportedMinor: -sum(["fee"]), estimatedMinor: null, transactionsWithoutFee: 0 },
      ordersWithPaymentAttempt: null,
    },
    attribution: {
      policyLabel: "Último clique pago elegível · 7 dias · v1",
      attributedGrossMinor: gross,
      attributedAfterReversalsMinor: gross - reversals,
      approvedCredit: { num: BigInt(approvedOrders), den: 1n },
      retainedCredit: { num: BigInt(retained), den: 1n },
      fractional: false,
      unattributedOrders: 0,
    },
    media: { spendMinor: 3000n, spendCurrency: "BRL", coverage: "complete", coverageNotes: [], impressions: null, linkClicks: null },
    costs: { otherVariableCostsMinor: 0n, missingCostCategories: [], operatingExpensesMinor: null, allocationCriteria: null },
    leads: { dedupedLeads: null, eligibleSessions: null },
  };
}

function moneyOf(m: MetricResult): bigint {
  if (m.status !== "ok" || m.unit !== "money") throw new Error(`${m.id} não é dinheiro ok: ${JSON.stringify(serializeMetric(m))}`);
  return m.amountMinor;
}
function ratioOf(m: MetricResult): string {
  if (m.status !== "ok" || m.unit === "money") throw new Error(`${m.id} não é razão ok`);
  return ratioToDecimalString(m.value, 10);
}

describe("fixture financeira obrigatória (R43-02)", () => {
  for (const times of [1, 3]) {
    it(`produz exatamente os valores esperados (webhooks repetidos ${times}x)`, () => {
      const m = computeMetrics(aggregate([replay(ORDER_A, times), replay(ORDER_B, times)]));
      expect(moneyOf(m.gross_approved_revenue)).toBe(15000n); // R$150
      expect(moneyOf(m.financial_reversals)).toBe(7000n); // R$70
      expect(moneyOf(m.revenue_after_reversals)).toBe(8000n); // R$80
      expect(ratioOf(m.approved_orders_gross)).toBe("2");
      expect(ratioOf(m.retained_orders)).toBe("1");
      expect(moneyOf(m.cpa_approved)).toBe(1500n); // R$15
      expect(moneyOf(m.cpa_retained)).toBe(3000n); // R$30
      expect(moneyOf(m.avg_ticket_gross)).toBe(7500n); // R$75
      expect(ratioOf(m.roas_gross)).toBe("5");
      // 80/30 exato; arredondado somente na apresentação.
      const roasAfter = m.roas_after_reversals;
      expect(roasAfter.status === "ok" && roasAfter.unit === "ratio" && roasAfter.value).toEqual({ num: 8000n, den: 3000n });
      expect(ratioOf(roasAfter)).toBe("2.6666666667");
      expect(moneyOf(m.fees)).toBe(500n); // R$5
      expect(moneyOf(m.contribution_after_media)).toBe(4500n); // R$45
      expect(m.contribution_after_media.status === "ok" && m.contribution_after_media.quality).toBe("complete");
    });
  }

  it("T50 denominador zero e métrica ausente → indefinido/indisponível com motivo", () => {
    const input = aggregate([replay(ORDER_A, 1), replay(ORDER_B, 1)]);
    const zeroSpend = computeMetrics({ ...input, media: { ...input.media, spendMinor: 0n } });
    expect(zeroSpend.roas_gross.status).toBe("undefined");
    expect(zeroSpend.roas_gross.status !== "ok" && zeroSpend.roas_gross.reason).toMatch(/zero/i);
    const noSpend = computeMetrics({ ...input, media: { ...input.media, spendMinor: null, coverage: "none" } });
    expect(noSpend.media_spend.status).toBe("unavailable");
    expect(noSpend.cpa_approved.status).toBe("unavailable");
    expect(noSpend.orders_generated.status).toBe("unavailable");
    const noOrders = computeMetrics({
      ...input,
      financial: { ...input.financial, approvedOrders: 0, retainedOrders: 0, grossApprovedMinor: 0n, reversalsMinor: 0n },
    });
    expect(noOrders.avg_ticket_gross.status).toBe("undefined");
  });

  it("T49 gasto em USD e receita em BRL sem câmbio não são misturados", () => {
    const input = aggregate([replay(ORDER_A, 1)]);
    const m = computeMetrics({ ...input, media: { ...input.media, spendCurrency: "USD" } });
    expect(m.media_spend.status).toBe("unavailable");
    expect(m.roas_gross.status).toBe("unavailable");
    expect(m.media_spend.status !== "ok" && m.media_spend.reason).toMatch(/USD/);
  });

  it("R22-08 custos materiais ausentes → resultado parcial com lista de custos", () => {
    const input = aggregate([replay(ORDER_A, 1), replay(ORDER_B, 1)]);
    const m = computeMetrics({ ...input, costs: { ...input.costs, missingCostCategories: ["impostos"] } });
    expect(m.contribution_after_media.status === "ok" && m.contribution_after_media.quality).toBe("partial");
    expect(m.contribution_after_media.notes.join(" ")).toMatch(/impostos/);
    expect(m.breakeven_roas.status).toBe("unavailable");
  });

  it("T51 afiliado sem participação informada: receita da organização indisponível, não igual ao bruto", () => {
    const input = aggregate([replay(ORDER_A, 1)]);
    const m = computeMetrics({
      ...input,
      financial: {
        ...input.financial,
        orgRevenue: { withShareNetMinor: 0n, withShareTransactions: 0, withShareHasEstimatedReversal: false, producerNoShareNetMinor: 0n, producerNoShareTransactions: 0, otherRoleNoShareTransactions: 1 },
      },
    });
    expect(m.org_revenue.status).toBe("unavailable");
    expect(moneyOf(m.gross_approved_revenue)).toBe(10000n);
    expect(m.contribution_after_media.status).toBe("unavailable");
  });

  it("CPA com crédito fracionado é rotulado", () => {
    const input = aggregate([replay(ORDER_A, 1), replay(ORDER_B, 1)]);
    const m = computeMetrics({ ...input, attribution: { ...input.attribution!, approvedCredit: { num: 3n, den: 2n }, fractional: true } });
    expect(moneyOf(m.cpa_approved)).toBe(2000n);
    expect(m.cpa_approved.notes.join(" ")).toMatch(/fracionados/);
  });
});
