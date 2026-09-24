/**
 * Tipos do ciclo financeiro (seção 10 da especificação).
 * Pedido comercial, tentativa/transação de pagamento, itens, reversões (reembolso/chargeback/disputa)
 * e lançamentos financeiros são entidades distintas (R10-01).
 */

export type TransactionStatus = "pending" | "failed" | "canceled" | "expired" | "approved";

/** Natureza da receita da transação: aquisição inicial, upsell/downsell, renovação de assinatura, manual. */
export type TransactionKind = "initial" | "upsell" | "downsell" | "renewal" | "manual";

export type PaymentMethod = "pix" | "boleto" | "credit_card" | "debit_card" | "wallet" | "other" | "unknown";

/** Semântica do valor informado pelo provedor num reembolso (R10-10, T10). */
export type RefundAmountSemantics = "incremental" | "cumulative" | "full";

export type ReversalKind = "refund" | "chargeback" | "dispute_win";

export type LedgerEntryType =
  | "approval" // + valor confirmado da transação
  | "refund" // − valor efetivamente estornado
  | "chargeback" // − valor efetivamente perdido em chargeback
  | "chargeback_reversal" // + valor restaurado após disputa ganha
  | "fee" // − taxa efetiva informada pelo provedor
  | "org_share" // receita da organização (comissão/participação) informada pela origem
  | "org_share_reversal"; // redução da receita da organização por reversão (proporcional = estimada)

export interface LedgerEntry {
  /** Chave semântica única por organização: garante idempotência do lançamento (R09-14). */
  readonly semanticKey: string;
  readonly type: LedgerEntryType;
  readonly transactionKey: string;
  /** Valor com sinal na menor unidade monetária. */
  readonly amountMinor: bigint;
  readonly currency: string;
  /** Momento do movimento financeiro na origem (não o recebimento do webhook). */
  readonly occurredAt: Date;
  readonly revenueKind: TransactionKind;
  readonly reversalKey?: string;
  /** true quando o valor é estimado (ex.: redução proporcional da comissão), não informado pela origem. */
  readonly estimated?: boolean;
}

export interface TransactionState {
  readonly key: string;
  kind: TransactionKind;
  status: TransactionStatus;
  /** Valor da cobrança (tentado ou aprovado). null = desconhecido. */
  amountMinor: bigint | null;
  currency: string;
  method: PaymentMethod;
  /** Data/hora da primeira confirmação válida (origem). */
  approvedAt: Date | null;
  /** Data/hora de origem do último status aplicado (para ordenar eventos fora de ordem). */
  statusOccurredAt: Date;
  /** Soma líquida de reversões efetivas (reembolsos + chargebacks − disputas ganhas). */
  reversedNetMinor: bigint;
  /** Soma dos valores reportados de reembolso (para semântica cumulativa). */
  refundReportedTotalMinor: bigint;
  /** Receita da organização informada pela origem (comissão/participação). null = não informada. */
  orgShareMinor: bigint | null;
  /** Taxa efetiva informada pela origem. null = não informada. */
  feeMinor: bigint | null;
  /**
   * Número de parcelas da cobrança no cartão (informativo). Parcelas não são novas compras: a receita é a da
   * aprovação; recebíveis e liquidações são registrados à parte, sem efeito de receita (R10-08, T18).
   */
  installments: number | null;
}

export interface ReversalState {
  readonly key: string;
  readonly kind: ReversalKind;
  readonly transactionKey: string | null;
  readonly semantics: RefundAmountSemantics;
  /** Valor reportado pela origem (null = integral/sem valor). */
  readonly reportedAmountMinor: bigint | null;
  readonly occurredAt: Date;
  /**
   * chargeback: reembolso comprovadamente coberto pelo chargeback (mesma perda, T11);
   * dispute_win: chargeback cuja disputa foi ganha (T12).
   */
  readonly relatedKey?: string;
  status: "applied" | "pending_reconciliation";
  /** Valor efetivamente deduzido (após limites e sobreposições). */
  effectiveMinor: bigint;
  /** Para chargebacks: valor já restaurado por disputa ganha. */
  restoredMinor: bigint;
}

export interface OrderItemState {
  readonly key: string;
  readonly externalProductId: string;
  name: string | null;
  itemType: string | null;
  unitAmountMinor: bigint | null;
  quantity: number;
  currency: string;
}

export interface OrderConflict {
  readonly code:
    | "amount_mismatch"
    | "currency_mismatch"
    | "status_regression_ignored"
    | "reversal_amount_mismatch"
    | "unknown_dispute"
    | "reversal_exceeds_remaining";
  readonly message: string;
  readonly transactionKey?: string;
  readonly reversalKey?: string;
}

export interface OrderAggregateState {
  readonly currency: string | null;
  readonly transactions: Record<string, TransactionState>;
  readonly reversals: Record<string, ReversalState>;
  readonly items: Record<string, OrderItemState>;
}

export function emptyOrderState(): OrderAggregateState {
  return { currency: null, transactions: {}, reversals: {}, items: {} };
}

/** Eventos financeiros canônicos já normalizados pelo conector. */
export type FinancialEvent =
  | {
      readonly type: "payment.pending" | "payment.failed" | "payment.canceled" | "payment.expired";
      readonly transactionKey: string;
      readonly amountMinor: bigint | null;
      readonly currency: string;
      readonly method: PaymentMethod;
      readonly occurredAt: Date;
      readonly kind?: TransactionKind;
    }
  | {
      readonly type: "payment.approved";
      readonly transactionKey: string;
      readonly amountMinor: bigint;
      readonly currency: string;
      readonly method: PaymentMethod;
      readonly occurredAt: Date;
      readonly kind: TransactionKind;
      readonly orgShareMinor?: bigint | null;
      readonly feeMinor?: bigint | null;
      readonly installments?: number | null;
    }
  | {
      readonly type: "refund.succeeded";
      readonly transactionKey: string | null;
      readonly reversalKey: string;
      readonly amountMinor: bigint | null;
      readonly semantics: RefundAmountSemantics;
      readonly currency: string;
      readonly occurredAt: Date;
    }
  | {
      readonly type: "chargeback.confirmed";
      readonly transactionKey: string | null;
      readonly reversalKey: string;
      readonly amountMinor: bigint | null;
      readonly currency: string;
      readonly occurredAt: Date;
      /** Quando a origem comprova que o chargeback cobre um reembolso já registrado. */
      readonly coversRefundKey?: string;
    }
  | {
      readonly type: "dispute.won";
      /** Identidade estável do evento de disputa ganha (idempotência). */
      readonly winKey: string;
      /** Chargeback cuja disputa foi ganha. */
      readonly reversalKey: string;
      /** Valor restaurado confirmado; null = todo o valor retido do chargeback. */
      readonly amountMinor: bigint | null;
      readonly currency: string;
      readonly occurredAt: Date;
    }
  | {
      readonly type: "order.items";
      readonly items: ReadonlyArray<{
        readonly externalProductId: string;
        readonly name: string | null;
        readonly itemType: string | null;
        readonly unitAmountMinor: bigint | null;
        readonly quantity: number;
        readonly currency: string;
      }>;
    };

export interface ApplyResult {
  readonly state: OrderAggregateState;
  readonly ledger: readonly LedgerEntry[];
  readonly conflicts: readonly OrderConflict[];
  /** Transações aprovadas pela primeira vez neste evento (gatilho de efeitos como Purchase). */
  readonly newlyApproved: readonly string[];
  /** true quando o evento não alterou nada (repetição idempotente). */
  readonly noop: boolean;
}
