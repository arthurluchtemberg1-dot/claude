import { divRoundHalfEven, maxBig, minBig } from "../money";
import type {
  ApplyResult,
  FinancialEvent,
  LedgerEntry,
  OrderAggregateState,
  OrderConflict,
  ReversalState,
  TransactionState,
  TransactionStatus,
} from "./types";

/**
 * Agregado financeiro de um pedido. Função pura: recebe o estado persistido e um evento canônico
 * e devolve o novo estado, os lançamentos a inserir (com chave semântica idempotente) e conflitos.
 *
 * Invariantes (seção 10 e cenários T02–T18):
 * - Pix gerado/boleto/cartão recusado não geram lançamento de receita (T06, T07).
 * - Aprovação é terminal para o status de pagamento: pendente/falha posterior não rebaixa (T08).
 * - Reversões nunca somam mais que o valor aprovado da transação (T09–T11).
 * - Estorno antes da aprovação fica pendente de conciliação sem fabricar receita (T13).
 * - Repetição do mesmo evento é no-op (T02, T04).
 */

function clone(state: OrderAggregateState): {
  currency: string | null;
  transactions: Record<string, TransactionState>;
  reversals: Record<string, ReversalState>;
  items: OrderAggregateState["items"];
} {
  const transactions: Record<string, TransactionState> = {};
  for (const [k, v] of Object.entries(state.transactions)) transactions[k] = { ...v };
  const reversals: Record<string, ReversalState> = {};
  for (const [k, v] of Object.entries(state.reversals)) reversals[k] = { ...v };
  const items: Record<string, OrderAggregateState["items"][string]> = {};
  for (const [k, v] of Object.entries(state.items)) items[k] = { ...v };
  return { currency: state.currency, transactions, reversals, items };
}

const NON_APPROVED: ReadonlySet<TransactionStatus> = new Set(["pending", "failed", "canceled", "expired"]);

export function applyFinancialEvent(prev: OrderAggregateState, event: FinancialEvent): ApplyResult {
  const s = clone(prev);
  const ledger: LedgerEntry[] = [];
  const conflicts: OrderConflict[] = [];
  const newlyApproved: string[] = [];
  let changed = false;

  if (event.type !== "order.items") {
    if (s.currency === null) {
      s.currency = event.currency;
      changed = true;
    } else if (s.currency !== event.currency) {
      conflicts.push({
        code: "currency_mismatch",
        message: `Evento em ${event.currency} para pedido em ${s.currency}; ignorado para não misturar moedas.`,
      });
      return { state: prev, ledger, conflicts, newlyApproved, noop: true };
    }
  }

  switch (event.type) {
    case "order.items": {
      for (const item of event.items) {
        const key = `${item.externalProductId}`;
        const existing = s.items[key];
        if (!existing) {
          s.items[key] = { key, ...item };
          changed = true;
        } else {
          const next = { ...existing, ...item, key };
          if (JSON.stringify(serializeItem(next)) !== JSON.stringify(serializeItem(existing))) {
            s.items[key] = next;
            changed = true;
          }
        }
      }
      break;
    }

    case "payment.pending":
    case "payment.failed":
    case "payment.canceled":
    case "payment.expired": {
      const status = event.type.slice("payment.".length) as TransactionStatus;
      const tx = s.transactions[event.transactionKey];
      if (!tx) {
        s.transactions[event.transactionKey] = {
          key: event.transactionKey,
          kind: event.kind ?? "initial",
          status,
          amountMinor: event.amountMinor,
          currency: event.currency,
          method: event.method,
          approvedAt: null,
          statusOccurredAt: event.occurredAt,
          reversedNetMinor: 0n,
          refundReportedTotalMinor: 0n,
          orgShareMinor: null,
          feeMinor: null,
        };
        changed = true;
      } else if (tx.status === "approved") {
        // T08: evento pendente/falha depois do aprovado não rebaixa o pagamento.
        conflicts.push({
          code: "status_regression_ignored",
          transactionKey: tx.key,
          message: `Evento "${status}" recebido para transação já aprovada; status aprovado preservado.`,
        });
      } else if (NON_APPROVED.has(tx.status)) {
        if (event.occurredAt.getTime() >= tx.statusOccurredAt.getTime() && tx.status !== status) {
          tx.status = status;
          tx.statusOccurredAt = event.occurredAt;
          if (event.amountMinor !== null) tx.amountMinor = event.amountMinor;
          if (event.method !== "unknown") tx.method = event.method;
          changed = true;
        }
      }
      break;
    }

    case "payment.approved": {
      const tx = s.transactions[event.transactionKey];
      if (tx && tx.status === "approved") {
        // T02/T04: mesma cobrança confirmada de novo (repetição ou objeto redundante).
        if (tx.amountMinor !== event.amountMinor) {
          conflicts.push({
            code: "amount_mismatch",
            transactionKey: tx.key,
            message: `Confirmação repetida com valor ${event.amountMinor} diferente do registrado ${tx.amountMinor}; valor original preservado.`,
          });
        }
        if (tx.orgShareMinor === null && event.orgShareMinor != null) {
          tx.orgShareMinor = event.orgShareMinor;
          ledger.push(orgShareEntry(tx, event.orgShareMinor));
          changed = true;
        }
        if (tx.feeMinor === null && event.feeMinor != null) {
          tx.feeMinor = event.feeMinor;
          ledger.push(feeEntry(tx, event.feeMinor));
          changed = true;
        }
        break;
      }
      const approved: TransactionState = {
        key: event.transactionKey,
        kind: event.kind,
        status: "approved",
        amountMinor: event.amountMinor,
        currency: event.currency,
        method: event.method !== "unknown" ? event.method : (tx?.method ?? "unknown"),
        approvedAt: event.occurredAt,
        statusOccurredAt: event.occurredAt,
        reversedNetMinor: 0n,
        refundReportedTotalMinor: 0n,
        orgShareMinor: event.orgShareMinor ?? null,
        feeMinor: event.feeMinor ?? null,
      };
      if (tx && tx.amountMinor !== null && tx.amountMinor !== event.amountMinor) {
        conflicts.push({
          code: "amount_mismatch",
          transactionKey: tx.key,
          message: `Valor aprovado ${event.amountMinor} difere do valor da tentativa ${tx.amountMinor}; usado o valor da confirmação.`,
        });
      }
      s.transactions[event.transactionKey] = approved;
      newlyApproved.push(approved.key);
      ledger.push({
        semanticKey: `approval:${approved.key}`,
        type: "approval",
        transactionKey: approved.key,
        amountMinor: approved.amountMinor ?? 0n,
        currency: approved.currency,
        occurredAt: event.occurredAt,
        revenueKind: approved.kind,
      });
      if (approved.orgShareMinor !== null) ledger.push(orgShareEntry(approved, approved.orgShareMinor));
      if (approved.feeMinor !== null) ledger.push(feeEntry(approved, approved.feeMinor));
      changed = true;
      // T13: reversões recebidas antes da aprovação são conciliadas agora, em ordem de ocorrência.
      const pending = Object.values(s.reversals)
        .filter(
          (r) =>
            r.status === "pending_reconciliation" &&
            (r.transactionKey === approved.key || (r.transactionKey === null && isSingleCharge(s))),
        )
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
      for (const r of pending) {
        ledger.push(...applyReversalToTx(s, approved, r, conflicts));
      }
      break;
    }

    case "refund.succeeded":
    case "chargeback.confirmed": {
      const kind = event.type === "refund.succeeded" ? "refund" : "chargeback";
      const existing = s.reversals[event.reversalKey];
      if (existing) {
        if (existing.reportedAmountMinor !== event.amountMinor) {
          conflicts.push({
            code: "reversal_amount_mismatch",
            reversalKey: existing.key,
            message: `Reversão ${existing.key} repetida com valor diferente; valor original preservado.`,
          });
        }
        break; // T09: reembolso repetido não deduz de novo.
      }
      const txKey = event.transactionKey ?? singleChargeKey(s);
      const reversal: ReversalState = {
        key: event.reversalKey,
        kind,
        transactionKey: txKey,
        semantics: event.type === "refund.succeeded" ? event.semantics : event.amountMinor === null ? "full" : "incremental",
        reportedAmountMinor: event.amountMinor,
        occurredAt: event.occurredAt,
        ...(event.type === "chargeback.confirmed" && event.coversRefundKey ? { relatedKey: event.coversRefundKey } : {}),
        status: "pending_reconciliation",
        effectiveMinor: 0n,
        restoredMinor: 0n,
      };
      s.reversals[reversal.key] = reversal;
      changed = true;
      const tx = txKey ? s.transactions[txKey] : undefined;
      if (tx && tx.status === "approved") {
        ledger.push(...applyReversalToTx(s, tx, reversal, conflicts));
      }
      break;
    }

    case "dispute.won": {
      if (s.reversals[event.winKey]) break; // repetição do mesmo evento de disputa ganha
      const cb = s.reversals[event.reversalKey];
      if (!cb || cb.kind !== "chargeback") {
        conflicts.push({
          code: "unknown_dispute",
          reversalKey: event.reversalKey,
          message: "Disputa ganha para chargeback desconhecido; nada restaurado até conciliação.",
        });
        break;
      }
      const restorable = cb.effectiveMinor - cb.restoredMinor;
      const amount = event.amountMinor === null ? restorable : minBig(event.amountMinor, restorable);
      s.reversals[event.winKey] = {
        key: event.winKey,
        kind: "dispute_win",
        transactionKey: cb.transactionKey,
        semantics: event.amountMinor === null ? "full" : "incremental",
        reportedAmountMinor: event.amountMinor,
        occurredAt: event.occurredAt,
        relatedKey: cb.key,
        status: "applied",
        effectiveMinor: amount > 0n ? amount : 0n,
        restoredMinor: 0n,
      };
      changed = true;
      if (amount <= 0n) break;
      cb.restoredMinor += amount;
      const tx = cb.transactionKey ? s.transactions[cb.transactionKey] : undefined;
      if (tx) tx.reversedNetMinor -= amount;
      ledger.push({
        semanticKey: `chargeback_reversal:${event.winKey}`,
        type: "chargeback_reversal",
        transactionKey: cb.transactionKey ?? "",
        amountMinor: amount,
        currency: event.currency,
        occurredAt: event.occurredAt,
        revenueKind: tx?.kind ?? "initial",
        reversalKey: event.winKey,
      });
      const restoredShare = tx ? proportionalShare(tx, amount) : null;
      if (restoredShare !== null && restoredShare !== 0n && tx) {
        ledger.push({
          semanticKey: `org_share_reversal:${event.winKey}`,
          type: "org_share_reversal",
          transactionKey: tx.key,
          amountMinor: restoredShare,
          currency: tx.currency,
          occurredAt: event.occurredAt,
          revenueKind: tx.kind,
          reversalKey: event.winKey,
          estimated: true,
        });
      }
      break;
    }
  }

  const state: OrderAggregateState = {
    currency: s.currency,
    transactions: s.transactions,
    reversals: s.reversals,
    items: s.items,
  };
  return { state: changed ? state : prev, ledger, conflicts, newlyApproved, noop: !changed };
}

function serializeItem(i: OrderAggregateState["items"][string]) {
  return { ...i, unitAmountMinor: i.unitAmountMinor?.toString() ?? null };
}

function orgShareEntry(tx: TransactionState, amount: bigint): LedgerEntry {
  return {
    semanticKey: `org_share:${tx.key}`,
    type: "org_share",
    transactionKey: tx.key,
    amountMinor: amount,
    currency: tx.currency,
    occurredAt: tx.approvedAt ?? tx.statusOccurredAt,
    revenueKind: tx.kind,
  };
}

function feeEntry(tx: TransactionState, amount: bigint): LedgerEntry {
  return {
    semanticKey: `fee:${tx.key}`,
    type: "fee",
    transactionKey: tx.key,
    amountMinor: -amount,
    currency: tx.currency,
    occurredAt: tx.approvedAt ?? tx.statusOccurredAt,
    revenueKind: tx.kind,
  };
}

function isSingleCharge(s: { transactions: Record<string, TransactionState> }): boolean {
  return Object.values(s.transactions).filter((t) => t.status === "approved").length === 1;
}

function singleChargeKey(s: { transactions: Record<string, TransactionState> }): string | null {
  const approved = Object.values(s.transactions).filter((t) => t.status === "approved");
  return approved.length === 1 ? approved[0]!.key : null;
}

/**
 * Aplica uma reversão a uma transação aprovada, calculando o valor efetivo sem dupla dedução.
 */
function applyReversalToTx(
  s: { reversals: Record<string, ReversalState> },
  tx: TransactionState,
  r: ReversalState,
  conflicts: OrderConflict[],
): LedgerEntry[] {
  const approvedAmount = tx.amountMinor ?? 0n;
  const remaining = approvedAmount - tx.reversedNetMinor;
  let delta: bigint;
  if (r.kind === "refund") {
    switch (r.semantics) {
      case "full":
        delta = remaining;
        tx.refundReportedTotalMinor = approvedAmount;
        break;
      case "cumulative": {
        const cumulative = r.reportedAmountMinor ?? approvedAmount;
        delta = maxBig(0n, cumulative - tx.refundReportedTotalMinor);
        tx.refundReportedTotalMinor = maxBig(tx.refundReportedTotalMinor, cumulative);
        break;
      }
      case "incremental": {
        const inc = r.reportedAmountMinor ?? remaining;
        delta = inc;
        tx.refundReportedTotalMinor += inc;
        break;
      }
    }
  } else {
    const reported = r.reportedAmountMinor ?? approvedAmount;
    delta = reported;
    if (r.relatedKey) {
      const covered = s.reversals[r.relatedKey];
      if (covered && covered.status === "applied") delta = maxBig(0n, reported - covered.effectiveMinor);
    }
  }
  if (delta > remaining) {
    conflicts.push({
      code: "reversal_exceeds_remaining",
      reversalKey: r.key,
      transactionKey: tx.key,
      message: `Reversão ${r.key} excede o saldo restante; deduzido apenas ${remaining} para não subtrair duas vezes.`,
    });
    delta = remaining;
  }
  if (delta < 0n) delta = 0n;
  r.status = "applied";
  r.effectiveMinor = delta;
  if (delta === 0n) return [];
  tx.reversedNetMinor += delta;
  const entries: LedgerEntry[] = [
    {
      semanticKey: `${r.kind}:${r.key}`,
      type: r.kind === "refund" ? "refund" : "chargeback",
      transactionKey: tx.key,
      amountMinor: -delta,
      currency: tx.currency,
      occurredAt: r.occurredAt,
      revenueKind: tx.kind,
      reversalKey: r.key,
    },
  ];
  const share = proportionalShare(tx, delta);
  if (share !== null && share !== 0n) {
    entries.push({
      semanticKey: `org_share_reversal:${r.key}`,
      type: "org_share_reversal",
      transactionKey: tx.key,
      amountMinor: -share,
      currency: tx.currency,
      occurredAt: r.occurredAt,
      revenueKind: tx.kind,
      reversalKey: r.key,
      estimated: true,
    });
  }
  return entries;
}

/**
 * Parcela da receita da organização afetada por uma reversão: proporcional ao valor revertido
 * (estimativa rotulada, R22-07). Retorna null quando a origem não informou a participação.
 */
export function proportionalShare(tx: TransactionState, deltaMinor: bigint): bigint | null {
  if (tx.orgShareMinor === null || !tx.amountMinor) return null;
  return divRoundHalfEven(tx.orgShareMinor * deltaMinor, tx.amountMinor);
}

/** Situação comercial derivada do agregado (para listagem e filtros). */
export type OrderFinancialStatus =
  | "pending"
  | "failed"
  | "approved"
  | "partially_reversed"
  | "fully_reversed"
  | "reversal_pending_reconciliation";

export function deriveOrderStatus(state: OrderAggregateState): OrderFinancialStatus {
  const txs = Object.values(state.transactions);
  const approved = txs.filter((t) => t.status === "approved");
  const pendingRecon = Object.values(state.reversals).some((r) => r.status === "pending_reconciliation");
  if (approved.length === 0) {
    if (pendingRecon) return "reversal_pending_reconciliation";
    if (txs.some((t) => t.status === "pending")) return "pending";
    return txs.length ? "failed" : "pending";
  }
  const total = approved.reduce((a, t) => a + (t.amountMinor ?? 0n), 0n);
  const reversed = approved.reduce((a, t) => a + t.reversedNetMinor, 0n);
  if (reversed <= 0n) return "approved";
  if (reversed >= total) return "fully_reversed";
  return "partially_reversed";
}

export function orderTotals(state: OrderAggregateState): {
  approvedMinor: bigint;
  reversedNetMinor: bigint;
  netMinor: bigint;
  firstApprovedAt: Date | null;
} {
  const approved = Object.values(state.transactions).filter((t) => t.status === "approved");
  const approvedMinor = approved.reduce((a, t) => a + (t.amountMinor ?? 0n), 0n);
  const reversedNetMinor = approved.reduce((a, t) => a + t.reversedNetMinor, 0n);
  const firstApprovedAt = approved.reduce<Date | null>(
    (acc, t) => (t.approvedAt && (!acc || t.approvedAt < acc) ? t.approvedAt : acc),
    null,
  );
  return { approvedMinor, reversedNetMinor, netMinor: approvedMinor - reversedNetMinor, firstApprovedAt };
}
