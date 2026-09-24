import { createHash } from "node:crypto";
import { formatMinorAsDecimal } from "@tracker/domain";
import type { ConnectorManifest, ConversionDestination, ConversionOrderContext, DeliveryAttemptResult, EligibilityResult } from "../types";

/**
 * Meta Conversions API — destino de Purchase.
 *
 * Fonte verificada: SDK oficial `facebook-nodejs-business-sdk@24.0.1` (npm, Meta Platforms), arquivos
 * src/objects/serverside/{event-request,server-event,user-data,custom-data,utils}.js, consultados em 24/09/2026:
 *   - POST https://graph.facebook.com/{versão}/{pixel_id}/events com params data[], test_event_code, access_token
 *     (versão do SDK: v24.0).
 *   - Evento: event_name, event_time (unix s), user_data, custom_data, action_source, event_id, event_source_url,
 *     opt_out, data_processing_options...
 *   - user_data: em/ph/fn/ln/ct/st/zp/country/ge/db normalizados e SHA-256; external_id apenas deduplicado;
 *     client_ip_address, client_user_agent, fbc, fbp enviados SEM hash (R17-05).
 *   - Normalização: e-mail trim+lowercase; telefone só dígitos (remove símbolos, "+" e zeros à esquerda internacionais).
 *   - custom_data: value, currency (ISO 4217), content_ids, contents[{id, quantity, item_price}], content_type,
 *     order_id, num_items.
 *
 * A REVALIDAR na documentação oficial (developers.facebook.com bloqueado pelo proxy deste ambiente):
 *   - Janela máxima de idade de event_time (7 dias para web assumidos) e janela de deduplicação (48 h).
 *   - Limite de 1.000 eventos por requisição.
 *   - Grafia do parâmetro no pixel do navegador (eventID) vs servidor (event_id) — R17-10.
 */

export const META_GRAPH_BASE = "https://graph.facebook.com";
export const META_API_VERSION_VERIFIED = "v24.0";
/** Hipótese a revalidar: idade máxima aceita para eventos web. */
export const META_MAX_EVENT_AGE_DAYS = 7;
export const META_MAX_BATCH = 1000;

export interface MetaCapiConfig {
  readonly pixelId: string;
  readonly apiVersion: string;
  readonly testEventCode: string | null;
  readonly actionSource: "website";
}

export interface MetaServerEvent {
  event_name: "Purchase";
  event_time: number;
  event_id: string;
  action_source: "website";
  event_source_url?: string;
  user_data: Record<string, string | string[]>;
  custom_data: {
    value: number;
    currency: string;
    order_id: string;
    content_type: "product";
    contents: { id: string; quantity: number; item_price?: number }[];
    num_items: number;
  };
}

export const metaCapiManifest: ConnectorManifest = {
  id: "meta_capi",
  displayName: "Meta Conversions API",
  vendor: "Meta Platforms",
  product: "Conversions API (Graph API /{pixel_id}/events)",
  kind: "destination",
  group: "Destinos de conversão",
  state: "implemented_locally",
  stateNote:
    "Payload, deduplicação por event_id estável, elegibilidade, retry e registro de tentativas implementados e testados contra servidor HTTP local. Envio real bloqueado: requer Pixel/dataset, token do sistema e validação no Events Manager (DEP-META-APP).",
  docs: [
    { title: "facebook-nodejs-business-sdk 24.0.1 (código oficial)", url: "https://www.npmjs.com/package/facebook-nodejs-business-sdk/v/24.0.1", consultedAt: "2026-09-24", version: "v24.0", accessible: true },
    { title: "Handling duplicate Pixel and server events", url: "https://developers.facebook.com/documentation/ads-commerce/conversions-api/deduplicate-pixel-and-server-events", consultedAt: "2026-09-24", version: null, accessible: false, note: "Bloqueado pelo proxy; regras de deduplicação a revalidar" },
    { title: "Server event parameters", url: "https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/server-event", consultedAt: "2026-09-24", version: null, accessible: false, note: "Bloqueado pelo proxy" },
  ],
  apiVersion: META_API_VERSION_VERIFIED,
  authentication: "Access token do sistema (Business Manager) armazenado cifrado; appsecret_proof opcional",
  scopes: ["ads_management ou token de sistema com acesso ao dataset (a confirmar no App Review)"],
  webhookEvents: [],
  utmTransport: "n/a",
  moneyField: "custom_data.value (decimal em unidades maiores) + currency",
  timezone: "event_time em segundos Unix (UTC)",
  limits: `Até ${META_MAX_BATCH} eventos por requisição e idade máxima de ${META_MAX_EVENT_AGE_DAYS} dias (a revalidar)`,
  capabilities: {
    send_conversions: { status: "supported", note: "Purchase" },
    deduplication: { status: "supported", note: "event_id estável por transação/destino/ambiente" },
    test_events: { status: "supported", note: "test_event_code" },
    conversion_adjustments: { status: "not_supported", note: "Sem Purchase negativo; reembolsos corrigem somente o relatório interno (R17-19)" },
  },
  tests: ["packages/connectors/test/meta-capi.test.ts", "apps/worker/test/integration/deliveries.test.ts"],
  limitations: [
    "Aceite da API (events_received) não significa correspondência com usuário nem atribuição ao anúncio.",
    "Métricas oficiais de qualidade (EMQ) não são lidas por este adaptador.",
    "Reembolsos não geram evento negativo.",
  ],
  lastVerifiedSuccess: null,
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Normalização conforme ServerSideUtils do SDK oficial (e-mail). */
export function normalizeEmail(email: string): string | null {
  const v = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

/**
 * Telefone: somente dígitos, com código do país. Números brasileiros da Lowify chegam sem o prefixo 55
 * (documentado: "DDD + número, sem o prefixo 55"); o chamador informa o código do país conhecido.
 * Nunca fabrica número: se o formato não for plausível, retorna null.
 */
export function normalizePhone(phone: string, defaultCountryCode: string | null): string | null {
  let digits = phone.replace(/[^0-9]/g, "");
  if (!digits) return null;
  digits = digits.replace(/^00/, "");
  if (defaultCountryCode === "55" && (digits.length === 10 || digits.length === 11)) digits = "55" + digits;
  if (digits.length < 7 || digits.length > 16) return null;
  return digits;
}

export function metaEventId(orderId: string, transactionKey: string, environment: string): string {
  // Determinístico: mesmo pedido/transação/ambiente → mesmo ID em qualquer retry (R17-09, R17-11).
  return `purchase_${sha256(`${environment}|${orderId}|${transactionKey}`).slice(0, 32)}`;
}

function minorToNumber(amountMinor: bigint, currency: string): number {
  return Number(formatMinorAsDecimal(amountMinor, currency));
}

export function createMetaCapiDestination(options: { environment: string; phoneCountryCode: string | null }): ConversionDestination<MetaServerEvent> {
  return {
    manifest: metaCapiManifest,

    eligibility(ctx: ConversionOrderContext, now: Date): EligibilityResult {
      if (ctx.isDemo) return { eligible: false, reason: "Dados de demonstração nunca são enviados a destinos reais (T68)" };
      if (ctx.amountMinor <= 0n) return { eligible: false, reason: "Transação sem valor aprovado" };
      const ageDays = (now.getTime() - ctx.approvedAt.getTime()) / 86_400_000;
      if (ageDays > META_MAX_EVENT_AGE_DAYS) {
        // T28: nunca alterar a data para forçar aceitação.
        return { eligible: false, reason: `Evento com ${ageDays.toFixed(1)} dias excede a janela de ${META_MAX_EVENT_AGE_DAYS} dias do destino` };
      }
      if (ctx.approvedAt.getTime() > now.getTime() + 5 * 60_000) return { eligible: false, reason: "Horário do evento no futuro (relógio inconsistente)" };
      return { eligible: true };
    },

    eventId(ctx: ConversionOrderContext): string {
      return metaEventId(ctx.orderId, ctx.transactionKey, options.environment);
    },

    buildPayload(ctx: ConversionOrderContext, eventId: string): MetaServerEvent {
      const user: Record<string, string | string[]> = {};
      const email = ctx.contact?.email ? normalizeEmail(ctx.contact.email) : null;
      if (email) user.em = [sha256(email)];
      const phone = ctx.contact?.phone ? normalizePhone(ctx.contact.phone, options.phoneCountryCode) : null;
      if (phone) user.ph = [sha256(phone)];
      // Sinais do navegador somente com consentimento de publicidade e quando realmente capturados (R17-06, R17-08).
      if (ctx.browser?.adsConsent) {
        if (ctx.browser.fbp) user.fbp = ctx.browser.fbp;
        if (ctx.browser.fbc) user.fbc = ctx.browser.fbc;
        if (ctx.browser.clientIp) user.client_ip_address = ctx.browser.clientIp;
        if (ctx.browser.userAgent) user.client_user_agent = ctx.browser.userAgent;
      }
      const contents = ctx.items.map((i) => ({
        id: i.externalProductId,
        quantity: i.quantity,
        ...(i.unitAmountMinor !== null ? { item_price: minorToNumber(i.unitAmountMinor, ctx.currency) } : {}),
      }));
      const event: MetaServerEvent = {
        event_name: "Purchase",
        event_time: Math.floor(ctx.approvedAt.getTime() / 1000),
        event_id: eventId,
        action_source: "website",
        user_data: user,
        custom_data: {
          value: minorToNumber(ctx.amountMinor, ctx.currency),
          currency: ctx.currency,
          order_id: ctx.externalOrderId,
          content_type: "product",
          contents,
          num_items: ctx.items.reduce((a, i) => a + i.quantity, 0),
        },
      };
      if (ctx.browser?.eventSourceUrl) event.event_source_url = ctx.browser.eventSourceUrl;
      return event;
    },

    redact(payload: MetaServerEvent): Record<string, unknown> {
      return {
        ...payload,
        user_data: Object.fromEntries(Object.keys(payload.user_data).map((k) => [k, "[redigido]"])),
      };
    },
  };
}

/** Requisição HTTP ao endpoint /events (sem o token no corpo de log). */
export function buildMetaRequest(config: MetaCapiConfig, events: MetaServerEvent[], accessToken: string, appSecretProof: string | null) {
  if (events.length > META_MAX_BATCH) throw new Error(`Lote excede ${META_MAX_BATCH} eventos`);
  if (!/^[0-9]{5,25}$/.test(config.pixelId)) throw new Error("Pixel/dataset ID inválido");
  if (!/^v\d+\.\d+$/.test(config.apiVersion)) throw new Error("Versão da API inválida");
  const url = `${META_GRAPH_BASE}/${config.apiVersion}/${config.pixelId}/events`;
  const body: Record<string, unknown> = { data: events, access_token: accessToken };
  if (config.testEventCode) body.test_event_code = config.testEventCode;
  if (appSecretProof) body.appsecret_proof = appSecretProof;
  return { url, body };
}

/** Interpretação da resposta: aceite ≠ correspondência/atribuição (R17-16). */
export function interpretMetaResponse(status: number | null, json: unknown, latencyMs: number, timedOut: boolean): DeliveryAttemptResult {
  if (timedOut) return { outcome: "timeout_unknown", httpStatus: null, providerCode: null, traceId: null, message: "Timeout após envio: resultado desconhecido; reconciliar antes de repetir", latencyMs };
  if (status === null) return { outcome: "network_error", httpStatus: null, providerCode: null, traceId: null, message: "Falha de rede antes da resposta", latencyMs };
  const j = (json ?? {}) as { events_received?: number; fbtrace_id?: string; error?: { code?: number; error_subcode?: number; message?: string; fbtrace_id?: string; is_transient?: boolean } };
  if (status >= 200 && status < 300 && typeof j.events_received === "number") {
    return { outcome: "accepted", httpStatus: status, providerCode: null, traceId: j.fbtrace_id ?? null, message: `events_received=${j.events_received}`, latencyMs };
  }
  const code = j.error?.code !== undefined ? `${j.error.code}${j.error.error_subcode ? "/" + j.error.error_subcode : ""}` : null;
  const retryable = status === 429 || status >= 500 || j.error?.is_transient === true || [1, 2, 4, 17, 32, 613].includes(j.error?.code ?? -1);
  return {
    outcome: retryable ? "retryable_error" : "rejected",
    httpStatus: status,
    providerCode: code,
    traceId: j.error?.fbtrace_id ?? j.fbtrace_id ?? null,
    message: (j.error?.message ?? `HTTP ${status}`).slice(0, 300),
    latencyMs,
  };
}
