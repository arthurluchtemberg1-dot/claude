import { describe, expect, it } from "vitest";
import {
  applyFinancialEvent,
  deriveOrderStatus,
  emptyOrderState,
  orderTotals,
  type ApplyResult,
  type FinancialEvent,
  type LedgerEntry,
  type OrderAggregateState,
} from "../src";

const T0 = new Date("2026-09-20T12:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function run(events: FinancialEvent[], initial: OrderAggregateState = emptyOrderState()) {
  let state = initial;
  const ledger: LedgerEntry[] = [];
  const results: ApplyResult[] = [];
  for (const e of events) {
    const r = applyFinancialEvent(state, e);
    state = r.state;
    ledger.push(...r.ledger);
    results.push(r);
  }
  return { state, ledger, results };
}

const approved = (txKey: string, amount: bigint, minutes = 0, extra: Partial<Extract<FinancialEvent, { type: "payment.approved" }>> = {}): FinancialEvent => ({
  type: "payment.approved",
  transactionKey: txKey,
  amountMinor: amount,
  currency: "BRL",
  method: "pix",
  occurredAt: at(minutes),
  kind: "initial",
  ...extra,
});

const refund = (key: string, amount: bigint | null, minutes: number, semantics: "incremental" | "cumulative" | "full" = "incremental", txKey: string | null = "tx1"): FinancialEvent => ({
  type: "refund.succeeded",
  transactionKey: txKey,
  reversalKey: key,
  amountMinor: amount,
  semantics,
  currency: "BRL",
  occurredAt: at(minutes),
});

const sumLedger = (ledger: LedgerEntry[], types: LedgerEntry["type"][]) =>
  ledger.filter((l) => types.includes(l.type)).reduce((a, l) => a + l.amountMinor, 0n);

describe("agregado financeiro do pedido", () => {
  it("T18 parcelas: aprovação parcelada conta uma vez; notificações repetidas não criam receita", () => {
    const { state, ledger, results } = run([
      approved("tx1", 30000n, 0, { method: "credit_card", installments: 3 }),
      approved("tx1", 30000n, 30 * 24 * 60, { installments: 3 }),
      approved("tx1", 30000n, 60 * 24 * 60),
    ]);
    expect(sumLedger(ledger, ["approval"])).toBe(30000n);
    expect(ledger).toHaveLength(1);
    expect(state.transactions.tx1!.installments).toBe(3);
    expect(results.slice(1).every((r) => r.noop && r.newlyApproved.length === 0)).toBe(true);
    // Parcelas informadas só depois da aprovação completam o dado sem gerar lançamento.
    const late = run([approved("tx2", 1000n), approved("tx2", 1000n, 1, { installments: 2 })]);
    expect(late.state.transactions.tx2!.installments).toBe(2);
    expect(late.ledger).toHaveLength(1);
  });

  it("T01 pagamento aprovado gera uma venda com valor correto", () => {
    const { state, ledger, results } = run([approved("tx1", 1799n)]);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ type: "approval", amountMinor: 1799n, semanticKey: "approval:tx1" });
    expect(results[0]!.newlyApproved).toEqual(["tx1"]);
    expect(deriveOrderStatus(state)).toBe("approved");
  });

  it("T02 mesmo evento várias vezes → uma atualização financeira", () => {
    const e = approved("tx1", 1000n);
    const { ledger, results } = run([e, e, e]);
    expect(ledger).toHaveLength(1);
    expect(results.slice(1).every((r) => r.noop && r.newlyApproved.length === 0)).toBe(true);
  });

  it("T04 dois event IDs para a mesma cobrança não duplicam receita", () => {
    // Ex.: provedor envia order.paid e charge.paid; o conector mapeia ambos para a mesma transactionKey.
    const { ledger, results } = run([approved("tx1", 5000n), approved("tx1", 5000n, 1)]);
    expect(sumLedger(ledger, ["approval"])).toBe(5000n);
    expect(results[1]!.newlyApproved).toEqual([]);
  });

  it("T06 Pix gerado/pendente não soma receita nem dispara Purchase", () => {
    const { ledger, state, results } = run([
      { type: "payment.pending", transactionKey: "tx1", amountMinor: 1799n, currency: "BRL", method: "pix", occurredAt: at(0) },
    ]);
    expect(ledger).toHaveLength(0);
    expect(results[0]!.newlyApproved).toEqual([]);
    expect(deriveOrderStatus(state)).toBe("pending");
  });

  it("T07 boleto emitido e cartão recusado preservam tentativa sem venda", () => {
    const { ledger, state } = run([
      { type: "payment.pending", transactionKey: "boleto-1", amountMinor: 9700n, currency: "BRL", method: "boleto", occurredAt: at(0) },
      { type: "payment.failed", transactionKey: "card-1", amountMinor: 9700n, currency: "BRL", method: "credit_card", occurredAt: at(1) },
    ]);
    expect(ledger).toHaveLength(0);
    expect(Object.keys(state.transactions)).toEqual(["boleto-1", "card-1"]);
    expect(state.transactions["card-1"]!.status).toBe("failed");
  });

  it("T08 evento pendente depois do aprovado não rebaixa pagamento", () => {
    const { state, results } = run([
      approved("tx1", 1000n, 5),
      { type: "payment.pending", transactionKey: "tx1", amountMinor: 1000n, currency: "BRL", method: "pix", occurredAt: at(0) },
      { type: "payment.failed", transactionKey: "tx1", amountMinor: 1000n, currency: "BRL", method: "pix", occurredAt: at(10) },
    ]);
    expect(state.transactions["tx1"]!.status).toBe("approved");
    expect(results[1]!.conflicts[0]!.code).toBe("status_regression_ignored");
    expect(results[2]!.conflicts[0]!.code).toBe("status_regression_ignored");
  });

  it("T09 reembolso parcial repetido deduz uma única vez", () => {
    const { ledger, state } = run([approved("tx1", 10000n), refund("r1", 2000n, 10), refund("r1", 2000n, 10), refund("r1", 2000n, 11)]);
    expect(sumLedger(ledger, ["refund"])).toBe(-2000n);
    expect(deriveOrderStatus(state)).toBe("partially_reversed");
  });

  it("T10 reembolso integral após parcial — semântica cumulativa da origem", () => {
    const { ledger } = run([approved("tx1", 10000n), refund("r1", 2000n, 10, "cumulative"), refund("r2", 10000n, 20, "cumulative")]);
    expect(sumLedger(ledger, ["refund"])).toBe(-10000n);
    expect(ledger.filter((l) => l.type === "refund").map((l) => l.amountMinor)).toEqual([-2000n, -8000n]);
  });

  it("T10 reembolso integral após parcial — semântica incremental e 'full' sem valor", () => {
    const inc = run([approved("tx1", 10000n), refund("r1", 2000n, 10), refund("r2", 8000n, 20)]);
    expect(sumLedger(inc.ledger, ["refund"])).toBe(-10000n);
    const full = run([approved("tx1", 10000n), refund("r1", 2000n, 10), refund("r2", null, 20, "full")]);
    expect(sumLedger(full.ledger, ["refund"])).toBe(-10000n);
    expect(deriveOrderStatus(full.state)).toBe("fully_reversed");
  });

  it("T11 reembolso e chargeback sobre a mesma perda não deduzem duas vezes", () => {
    const full = run([
      approved("tx1", 10000n),
      refund("r1", 10000n, 10),
      { type: "chargeback.confirmed", transactionKey: "tx1", reversalKey: "cb1", amountMinor: 10000n, currency: "BRL", occurredAt: at(20) },
    ]);
    expect(sumLedger(full.ledger, ["refund", "chargeback"])).toBe(-10000n);
    expect(full.results[2]!.conflicts[0]!.code).toBe("reversal_exceeds_remaining");

    // Parcial comprovadamente coberto: chargeback de 30 que cobre o reembolso r1 de 30.
    const covered = run([
      approved("tx1", 10000n),
      refund("r1", 3000n, 10),
      { type: "chargeback.confirmed", transactionKey: "tx1", reversalKey: "cb1", amountMinor: 3000n, currency: "BRL", occurredAt: at(20), coversRefundKey: "r1" },
    ]);
    expect(sumLedger(covered.ledger, ["refund", "chargeback"])).toBe(-3000n);
  });

  it("T12 disputa ganha restaura somente o valor confirmado e preserva histórico", () => {
    const { ledger, state } = run([
      approved("tx1", 10000n),
      { type: "chargeback.confirmed", transactionKey: "tx1", reversalKey: "cb1", amountMinor: null, currency: "BRL", occurredAt: at(10) },
      { type: "dispute.won", winKey: "win1", reversalKey: "cb1", amountMinor: 6000n, currency: "BRL", occurredAt: at(20) },
      { type: "dispute.won", winKey: "win1", reversalKey: "cb1", amountMinor: 6000n, currency: "BRL", occurredAt: at(20) },
    ]);
    expect(ledger.map((l) => [l.type, l.amountMinor])).toEqual([
      ["approval", 10000n],
      ["chargeback", -10000n],
      ["chargeback_reversal", 6000n],
    ]);
    expect(orderTotals(state).netMinor).toBe(6000n);
  });

  it("T13 estorno antes do pagamento: guardado e conciliado sem fabricar receita", () => {
    const early = run([refund("r1", 1500n, 5)]);
    expect(early.ledger).toHaveLength(0);
    expect(deriveOrderStatus(early.state)).toBe("reversal_pending_reconciliation");
    const later = run([approved("tx1", 10000n, 0)], early.state);
    expect(later.ledger.map((l) => [l.type, l.amountMinor])).toEqual([
      ["approval", 10000n],
      ["refund", -1500n],
    ]);
  });

  it("T14 múltiplas tentativas do mesmo pedido: um pedido, cobranças corretas", () => {
    const { state, ledger } = run([
      { type: "payment.failed", transactionKey: "att-1", amountMinor: 5000n, currency: "BRL", method: "credit_card", occurredAt: at(0) },
      { type: "payment.pending", transactionKey: "att-2", amountMinor: 5000n, currency: "BRL", method: "pix", occurredAt: at(1) },
      approved("att-3", 5000n, 2, { method: "credit_card" }),
    ]);
    expect(Object.keys(state.transactions)).toHaveLength(3);
    expect(sumLedger(ledger, ["approval"])).toBe(5000n);
    expect(orderTotals(state).approvedMinor).toBe(5000n);
  });

  it("T15 order bump no mesmo pedido soma itens sem nova compra", () => {
    const { state, ledger } = run([
      { type: "order.items", items: [{ externalProductId: "main-1", name: "Curso", itemType: "main", unitAmountMinor: 9700n, quantity: 1, currency: "BRL" }] },
      { type: "order.items", items: [{ externalProductId: "bump-1", name: "Bônus", itemType: "bump", unitAmountMinor: 1990n, quantity: 1, currency: "BRL" }] },
      approved("tx1", 11690n),
      approved("tx1", 11690n),
    ]);
    expect(Object.keys(state.items)).toHaveLength(2);
    expect(ledger.filter((l) => l.type === "approval")).toHaveLength(1);
    expect(orderTotals(state).approvedMinor).toBe(11690n);
  });

  it("T17 renovação de assinatura separável da aquisição inicial", () => {
    const { ledger } = run([approved("sub-1-cycle-1", 4990n, 0), approved("sub-1-cycle-2", 4990n, 60 * 24 * 30, { kind: "renewal" })]);
    expect(ledger.map((l) => l.revenueKind)).toEqual(["initial", "renewal"]);
  });

  it("T51 afiliado: participação informada separada do valor pago pelo consumidor", () => {
    const { ledger } = run([approved("tx1", 10000n, 0, { orgShareMinor: 4000n }), refund("r1", 5000n, 10)]);
    expect(sumLedger(ledger, ["approval"])).toBe(10000n);
    expect(sumLedger(ledger, ["org_share", "org_share_reversal"])).toBe(2000n);
    expect(ledger.find((l) => l.type === "org_share_reversal")!.estimated).toBe(true);
  });

  it("não mistura moedas no mesmo pedido", () => {
    const r = run([approved("tx1", 1000n), { ...approved("tx2", 500n), currency: "USD" } as FinancialEvent]);
    expect(r.results[1]!.conflicts[0]!.code).toBe("currency_mismatch");
    expect(r.ledger).toHaveLength(1);
  });
});
