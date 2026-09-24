import type { FinancialEvent } from "@tracker/domain";

/**
 * Interfaces tipadas de conectores (R11-01) e manifesto de capacidades (R11-02, R11-05).
 * Capacidades são declaradas individualmente: receber vendas não implica consultar histórico etc.
 */

/** Estado de implementação (R11-03) — distinto do estado da conexão. */
export type ImplementationState =
  | "planned"
  | "researching"
  | "blocked_external"
  | "implemented_locally"
  | "validated_sandbox"
  | "validated_production"
  | "degraded";

export const IMPLEMENTATION_STATE_LABELS: Record<ImplementationState, string> = {
  planned: "Planejado",
  researching: "Em pesquisa",
  blocked_external: "Bloqueado externamente",
  implemented_locally: "Implementado localmente",
  validated_sandbox: "Validado em sandbox",
  validated_production: "Validado em produção",
  degraded: "Degradado/descontinuado",
};

export type CapabilityId =
  // checkout
  | "receive_sales_webhook"
  | "webhook_authentication"
  | "pending_payments"
  | "refunds"
  | "chargebacks"
  | "subscriptions"
  | "order_bump_items"
  | "query_orders_api"
  | "historical_import"
  | "reconciliation"
  | "utm_passthrough"
  | "tracking_token_passthrough"
  | "product_catalog"
  // ads
  | "read_accounts"
  | "read_entities"
  | "import_spend"
  | "read_insights"
  | "manage_media"
  // destinos
  | "send_conversions"
  | "deduplication"
  | "test_events"
  | "conversion_adjustments";

export type CapabilityStatus = "supported" | "not_supported" | "unknown" | "planned";

export interface CapabilityDeclaration {
  readonly status: CapabilityStatus;
  /** Evidência ou observação (ex.: "documentado em internal-webhook.md v1.0.0"). */
  readonly note: string;
}

export interface DocumentationReference {
  readonly title: string;
  readonly url: string;
  readonly consultedAt: string | null;
  readonly version: string | null;
  readonly accessible: boolean;
  readonly note?: string;
}

export interface ConnectorManifest {
  readonly id: string;
  readonly displayName: string;
  readonly vendor: string;
  readonly product: string;
  readonly kind: "checkout" | "ad_network" | "destination" | "crm" | "messaging" | "export";
  readonly group: string;
  readonly state: ImplementationState;
  readonly stateNote: string;
  readonly docs: readonly DocumentationReference[];
  readonly apiVersion: string | null;
  readonly authentication: string;
  readonly scopes: readonly string[];
  readonly webhookEvents: readonly string[];
  readonly utmTransport: string;
  readonly moneyField: string;
  readonly timezone: string;
  readonly limits: string;
  readonly capabilities: Partial<Record<CapabilityId, CapabilityDeclaration>>;
  readonly tests: readonly string[];
  readonly limitations: readonly string[];
  readonly lastVerifiedSuccess: string | null;
}

// ------------------------------------------------------------------ Checkout

export interface InboundWebhook {
  readonly rawBody: Buffer;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly receivedAt: Date;
}

export interface AuthContext {
  /** Segredos decifrados da conexão (nunca logar). */
  readonly secrets: Readonly<Record<string, string>>;
  readonly config: Readonly<Record<string, unknown>>;
  /** Autenticação já realizada pelo token opaco da URL do endpoint. */
  readonly urlTokenVerified: boolean;
}

export type AuthResult =
  | { readonly ok: true; readonly method: string; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly reason: string };

export interface DeclaredTracking {
  readonly trackingToken: string | null;
  readonly utm: { source: string | null; medium: string | null; campaign: string | null; content: string | null; term: string | null };
  /** IDs de mídia declarados (ainda não validados contra contas conectadas). */
  readonly campaignId: string | null;
  readonly adsetId: string | null;
  readonly adId: string | null;
  readonly clickIds: Readonly<Record<string, string>>;
  /** Identificadores internos do provedor de checkout (não são IDs de anúncio). */
  readonly providerRefs: Readonly<Record<string, string>>;
}

export interface ContactData {
  readonly email: string | null;
  readonly phone: string | null;
  readonly name: string | null;
}

export interface NormalizedOrderEvent {
  readonly schemaVersion: "1.0";
  readonly eventType: string;
  readonly sourceEventType: string;
  readonly occurredAt: Date;
  readonly externalOrderId: string;
  readonly parentExternalOrderId: string | null;
  readonly isTest: boolean;
  readonly paymentMethod: string | null;
  readonly financial: readonly FinancialEvent[];
  readonly contact: ContactData | null;
  readonly declaredTracking: DeclaredTracking | null;
  /** Observações de normalização (hipóteses usadas, campos ausentes). */
  readonly notes: readonly string[];
}

export type NormalizeResult =
  | { readonly status: "ok"; readonly events: readonly NormalizedOrderEvent[]; readonly unknownFields: readonly string[] }
  /** Evento autenticado mas inválido/ambíguo: guardado para diagnóstico, sem efeito financeiro (T20). */
  | { readonly status: "quarantine"; readonly reason: string }
  /** Evento válido, conhecido, mas sem efeito (ex.: tipo não selecionado). */
  | { readonly status: "ignored"; readonly reason: string };

export interface DedupIdentity {
  readonly key: string;
  readonly method: "provider_event_id" | "provider_idempotency_header" | "fingerprint";
  readonly sourceEventType: string | null;
  readonly notes: readonly string[];
}

export interface NormalizeContext {
  readonly config: Readonly<Record<string, unknown>>;
  readonly receivedAt: Date;
  readonly connectionEnvironment: "test" | "production";
}

export interface CheckoutConnector {
  readonly manifest: ConnectorManifest;
  /** Verificação de autenticidade específica do provedor, sobre o corpo bruto (R09-03, R09-04). */
  authenticate(req: InboundWebhook, ctx: AuthContext): AuthResult;
  /** Identidade de idempotência de recebimento (R09-14, R09-16). null = corpo ilegível. */
  dedupIdentity(body: unknown, req: InboundWebhook): DedupIdentity | null;
  normalize(body: unknown, ctx: NormalizeContext): NormalizeResult;
}

// ------------------------------------------------------------------ Destinos de conversão

export interface ConversionOrderContext {
  readonly orderId: string;
  readonly externalOrderId: string;
  readonly transactionKey: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly approvedAt: Date;
  readonly items: readonly { externalProductId: string; quantity: number; unitAmountMinor: bigint | null }[];
  readonly contact: ContactData | null;
  /** Sinais do navegador somente quando capturados pelo SDK com consentimento de publicidade (R17-06). */
  readonly browser: {
    readonly fbp: string | null;
    readonly fbc: string | null;
    readonly clientIp: string | null;
    readonly userAgent: string | null;
    readonly eventSourceUrl: string | null;
    readonly adsConsent: boolean;
  } | null;
  readonly isTest: boolean;
  readonly isDemo: boolean;
}

export type EligibilityResult = { readonly eligible: true } | { readonly eligible: false; readonly reason: string };

export interface DeliveryAttemptResult {
  readonly outcome: "accepted" | "rejected" | "retryable_error" | "timeout_unknown" | "network_error" | "blocked";
  readonly httpStatus: number | null;
  readonly providerCode: string | null;
  readonly traceId: string | null;
  readonly message: string | null;
  readonly latencyMs: number;
}

export interface ConversionDestination<TPayload = unknown> {
  readonly manifest: ConnectorManifest;
  eligibility(ctx: ConversionOrderContext, now: Date): EligibilityResult;
  /** Identificador semântico estável (não depende de horário de envio nem de retry). */
  eventId(ctx: ConversionOrderContext): string;
  buildPayload(ctx: ConversionOrderContext, eventId: string): TPayload;
  /** Versão sem dados pessoais para armazenamento/exibição. */
  redact(payload: TPayload): Record<string, unknown>;
}

// ------------------------------------------------------------------ Mídia, CRM, mensageria, exportação

export interface SpendRow {
  readonly level: "account" | "campaign" | "adset" | "ad";
  readonly entityExternalId: string;
  readonly campaignExternalId: string | null;
  readonly entityName: string | null;
  readonly date: string;
  readonly currency: string;
  readonly spendMinor: bigint;
  readonly impressions: bigint | null;
  readonly linkClicks: bigint | null;
  readonly reach: bigint | null;
}

export interface AdNetworkConnector {
  readonly manifest: ConnectorManifest;
}

export interface CRMConnector {
  readonly manifest: ConnectorManifest;
}

export interface MessagingConnector {
  readonly manifest: ConnectorManifest;
}

export interface ExportDestination {
  readonly manifest: ConnectorManifest;
}
