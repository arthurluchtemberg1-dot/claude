import { createHmac } from "node:crypto";
import {
  buildMetaRequest,
  createMetaCapiDestination,
  interpretMetaResponse,
  type ConversionOrderContext,
  type DeliveryAttemptResult,
  type MetaServerEvent,
} from "@tracker/connectors";
import type { PoolClient } from "@tracker/db";

/**
 * Entregas a destinos de conversão (seções 17 e 42):
 * - fanout cria uma entrega por (destino, evento semântico, ambiente) — idempotência de efeito externo (R09-14);
 * - envio com event_id estável, backoff exponencial com jitter, limite de tentativas, circuit breaker por destino;
 * - timeout após envio → "unknown_outcome": só repete com o MESMO event_id dentro da janela de deduplicação do destino
 *   (T25); fora dela, expira sem reenviar;
 * - replays/reprocessamentos internos nunca criam novas entregas (T27): o fanout só ocorre para aprovações novas.
 */

export interface DeliveryDeps {
  environment: string;
  allowExternalDelivery: boolean;
  fetchImpl: typeof fetch;
  loadSecret: (c: PoolClient, orgId: string, connectionId: string | null, purpose: "capi_access_token") => Promise<string | null>;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Janela de deduplicação do destino usada para repetir após resultado desconhecido (a revalidar: 48 h na Meta). */
  dedupWindowHours?: number;
}

export async function loadOrderContext(c: PoolClient, orgId: string, orderId: string, transactionKey: string): Promise<ConversionOrderContext | null> {
  const o = (
    await c.query(
      `select o.id, o.external_order_id, o.currency, o.is_test, o.is_demo, t.amount_minor, t.approved_at, t.status
         from public.orders o join public.payment_transactions t on t.order_id = o.id and t.transaction_key = $3
        where o.organization_id = $1 and o.id = $2`,
      [orgId, orderId, transactionKey],
    )
  ).rows[0];
  if (!o || o.status !== "approved") return null;
  const items = (await c.query("select external_product_id, quantity, unit_amount_minor from public.order_items where organization_id = $1 and order_id = $2 order by item_key", [orgId, orderId])).rows;
  const contact = (await c.query("select email, phone, name from public.order_contacts where organization_id = $1 and order_id = $2", [orgId, orderId])).rows[0] ?? null;
  // Sinais do navegador: sessão mais recente do visitante vinculado por token, somente com consentimento de publicidade.
  const s = (
    await c.query(
      `select s.fbp, s.fbc, host(s.client_ip) as client_ip, s.user_agent, s.landing_url, s.ads_consent
         from public.order_visitor_links l join public.sessions s on s.visitor_id = l.visitor_id and s.organization_id = l.organization_id
        where l.organization_id = $1 and l.order_id = $2 and s.started_at <= $3
        order by s.started_at desc limit 1`,
      [orgId, orderId, o.approved_at],
    )
  ).rows[0];
  return {
    orderId,
    externalOrderId: o.external_order_id,
    transactionKey,
    currency: o.currency.trim(),
    amountMinor: o.amount_minor,
    approvedAt: o.approved_at,
    items: items.map((i) => ({ externalProductId: i.external_product_id, quantity: i.quantity, unitAmountMinor: i.unit_amount_minor })),
    contact: contact ? { email: contact.email, phone: contact.phone, name: contact.name } : null,
    browser: s
      ? { fbp: s.fbp, fbc: s.fbc, clientIp: s.client_ip, userAgent: s.user_agent, eventSourceUrl: s.landing_url, adsConsent: s.ads_consent }
      : null,
    isTest: o.is_test,
    isDemo: o.is_demo,
  };
}

function routingMatches(routing: Record<string, unknown>, projectId: string): boolean {
  const projects = routing?.project_ids;
  return !Array.isArray(projects) || projects.length === 0 || projects.includes(projectId);
}

export async function fanoutDestinations(c: PoolClient, deps: Pick<DeliveryDeps, "environment">, orgId: string, orderId: string, transactionKey: string, now: Date) {
  const order = (await c.query("select project_id from public.orders where organization_id = $1 and id = $2", [orgId, orderId])).rows[0];
  if (!order) return { created: 0 };
  const dests = (
    await c.query(
      `select id, provider, status, environment, purchase_emitter, enabled_events, routing, config from public.conversion_destinations
        where organization_id = $1 and status in ('enabled', 'test_mode') and 'Purchase' = any(enabled_events)`,
      [orgId],
    )
  ).rows;
  const ctx = await loadOrderContext(c, orgId, orderId, transactionKey);
  if (!ctx) return { created: 0 };
  let created = 0;
  for (const d of dests) {
    if (!routingMatches(d.routing, order.project_id)) continue;
    if (d.provider !== "meta_capi") continue;
    const environment = d.status === "test_mode" ? "test" : deps.environment;
    const dest = createMetaCapiDestination({ environment, phoneCountryCode: d.config?.phone_country_code ?? "55" });
    const eventId = dest.eventId(ctx);
    let status = "queued";
    let reason: string | null = null;
    if (d.purchase_emitter !== "server") {
      status = "not_eligible";
      reason = `Emissor responsável pelo Purchase é "${d.purchase_emitter ?? "não definido"}"; servidor não envia para evitar duplicidade (R17-13)`;
    } else if (ctx.isTest && d.status !== "test_mode") {
      status = "not_eligible";
      reason = "Venda de teste não é enviada a destino em produção";
    } else {
      const el = dest.eligibility(ctx, now);
      if (!el.eligible) {
        status = el.reason.includes("janela") ? "expired" : "not_eligible";
        reason = el.reason;
      }
    }
    const payload = dest.buildPayload(ctx, eventId);
    const r = await c.query(
      `insert into public.destination_deliveries (organization_id, destination_id, order_id, semantic_event_key, event_name, event_id, environment, status, not_eligible_reason, event_time, payload_redacted)
       values ($1,$2,$3,$4,'Purchase',$5,$6,$7,$8,$9,$10)
       on conflict (organization_id, destination_id, semantic_event_key, environment) do nothing returning id`,
      [orgId, d.id, orderId, `purchase:${orderId}:${transactionKey}`, eventId, environment, status, reason, ctx.approvedAt, JSON.stringify(dest.redact(payload))],
    );
    if (r.rows[0] && status === "queued") {
      created++;
      await c.query("insert into public.outbox (organization_id, topic, payload, dedup_key, priority) values ($1, 'delivery.send', $2, $3, 5) on conflict do nothing", [
        orgId, JSON.stringify({ delivery_id: r.rows[0].id }), `delivery:${r.rows[0].id}:1`,
      ]);
    }
  }
  return { created };
}

function backoffMs(attempt: number): number {
  const base = Math.min(60_000 * 2 ** (attempt - 1), 6 * 3600_000);
  return Math.round(base / 2 + Math.random() * (base / 2)); // jitter
}

async function breakerOpen(c: PoolClient, orgId: string, scope: string, now: Date): Promise<Date | null> {
  const b = (await c.query("select state, retry_after from public.circuit_breakers where organization_id = $1 and scope = $2", [orgId, scope])).rows[0];
  if (b && b.state === "open" && b.retry_after > now) return b.retry_after;
  return null;
}

async function recordBreaker(c: PoolClient, orgId: string, scope: string, success: boolean, now: Date) {
  if (success) {
    await c.query(
      `insert into public.circuit_breakers (organization_id, scope, state, consecutive_failures) values ($1, $2, 'closed', 0)
       on conflict (organization_id, scope) do update set state = 'closed', consecutive_failures = 0, opened_at = null, retry_after = null, updated_at = now()`,
      [orgId, scope],
    );
    return;
  }
  await c.query(
    `insert into public.circuit_breakers (organization_id, scope, consecutive_failures) values ($1, $2, 1)
     on conflict (organization_id, scope) do update set consecutive_failures = public.circuit_breakers.consecutive_failures + 1,
       state = case when public.circuit_breakers.consecutive_failures + 1 >= 5 then 'open' else public.circuit_breakers.state end,
       opened_at = case when public.circuit_breakers.consecutive_failures + 1 >= 5 then $3 else public.circuit_breakers.opened_at end,
       retry_after = case when public.circuit_breakers.consecutive_failures + 1 >= 5 then $3::timestamptz + interval '5 minutes' else public.circuit_breakers.retry_after end,
       updated_at = now()`,
    [orgId, scope, now],
  );
}

export type SendOutcome = { status: string; reschedule?: Date; attempt?: DeliveryAttemptResult };

/**
 * Envia uma entrega. O envio HTTP ocorre FORA da transação do banco (chamador): esta função recebe duas
 * transações curtas — `prepare` (lock + leitura) e `finish` (registro do resultado).
 */
export async function sendDelivery(
  runTx: <T>(fn: (c: PoolClient) => Promise<T>) => Promise<T>,
  deps: DeliveryDeps,
  orgId: string,
  deliveryId: string,
  now: Date,
): Promise<SendOutcome> {
  const maxAttempts = deps.maxAttempts ?? 8;
  const prep = await runTx(async (c) => {
    const d = (
      await c.query(
        `select d.*, cd.status as dest_status, cd.config as dest_config, cd.connection_id, cd.provider
           from public.destination_deliveries d join public.conversion_destinations cd on cd.id = d.destination_id
          where d.organization_id = $1 and d.id = $2 for update of d`,
        [orgId, deliveryId],
      )
    ).rows[0];
    if (!d) return { skip: "Entrega não encontrada" };
    if (!["queued", "retry_scheduled", "unknown_outcome"].includes(d.status)) return { skip: `Entrega já ${d.status}` };
    if (d.dest_status !== "enabled" && d.dest_status !== "test_mode") {
      await c.query("update public.destination_deliveries set status = 'not_eligible', not_eligible_reason = 'Destino desativado antes do envio' where id = $1", [deliveryId]);
      return { skip: "Destino desativado" };
    }
    if (!deps.allowExternalDelivery) {
      await c.query("update public.destination_deliveries set status = 'not_eligible', not_eligible_reason = 'Envio externo desabilitado neste ambiente (ALLOW_EXTERNAL_DELIVERY=false)' where id = $1", [deliveryId]);
      return { skip: "Envio externo desabilitado" };
    }
    if (d.status === "unknown_outcome") {
      const first = (await c.query("select min(started_at) as t from public.delivery_attempts where organization_id = $1 and delivery_id = $2", [orgId, deliveryId])).rows[0].t as Date | null;
      const windowMs = (deps.dedupWindowHours ?? 48) * 3600_000;
      if (first && now.getTime() - first.getTime() > windowMs) {
        await c.query("update public.destination_deliveries set status = 'expired', last_error = 'Resultado desconhecido e janela de deduplicação encerrada: não reenviado para evitar duplicidade' where id = $1", [deliveryId]);
        return { skip: "Janela de deduplicação encerrada" };
      }
    }
    const scope = `${d.provider}:${d.destination_id}`;
    const openUntil = await breakerOpen(c, orgId, scope, now);
    if (openUntil) {
      await c.query("update public.destination_deliveries set status = 'retry_scheduled', next_attempt_at = $2, last_error = 'Circuit breaker aberto para o destino' where id = $1", [deliveryId, openUntil]);
      return { reschedule: openUntil };
    }
    const order = await loadOrderContext(c, orgId, d.order_id, d.semantic_event_key.split(":").slice(2).join(":"));
    if (!order) {
      await c.query("update public.destination_deliveries set status = 'not_eligible', not_eligible_reason = 'Transação não está aprovada' where id = $1", [deliveryId]);
      return { skip: "Transação não aprovada" };
    }
    const token = await deps.loadSecret(c, orgId, d.connection_id, "capi_access_token");
    if (!token) {
      await c.query("update public.destination_deliveries set status = 'not_eligible', not_eligible_reason = 'Credencial do destino ausente' where id = $1", [deliveryId]);
      return { skip: "Credencial ausente" };
    }
    const attemptNo = d.attempts + 1;
    await c.query("update public.destination_deliveries set status = 'sent', attempts = $2 where id = $1", [deliveryId, attemptNo]);
    return { d, order, token, attemptNo, scope };
  });
  if ("skip" in prep) return { status: "skipped" };
  if ("reschedule" in prep) return { status: "retry_scheduled", reschedule: prep.reschedule };

  const { d, order, token, attemptNo, scope } = prep;
  const environment = d.environment as string;
  const dest = createMetaCapiDestination({ environment, phoneCountryCode: d.dest_config?.phone_country_code ?? "55" });
  // O event_id persistido é reutilizado em todas as tentativas (T24).
  const payload: MetaServerEvent = dest.buildPayload(order, d.event_id);
  const req = buildMetaRequest(
    { pixelId: String(d.dest_config?.pixel_id ?? ""), apiVersion: String(d.dest_config?.api_version ?? "v24.0"), testEventCode: environment === "test" ? (d.dest_config?.test_event_code ?? null) : null, actionSource: "website" },
    [payload],
    token,
    null,
  );
  const started = new Date();
  let result: DeliveryAttemptResult;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 10_000);
  try {
    const res = await deps.fetchImpl(req.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req.body), signal: controller.signal });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text.slice(0, 64 * 1024));
    } catch {
      json = null;
    }
    result = interpretMetaResponse(res.status, json, Date.now() - started.getTime(), false);
  } catch (err) {
    const aborted = (err as Error).name === "AbortError";
    result = interpretMetaResponse(null, null, Date.now() - started.getTime(), aborted);
  } finally {
    clearTimeout(timer);
  }

  return runTx(async (c) => {
    await c.query(
      `insert into public.delivery_attempts (organization_id, delivery_id, attempt_no, started_at, finished_at, latency_ms, http_status, provider_code, trace_id, outcome, error_message)
       values ($1,$2,$3,$4,now(),$5,$6,$7,$8,$9,$10)`,
      [orgId, deliveryId, attemptNo, started, result.latencyMs, result.httpStatus, result.providerCode, result.traceId, result.outcome, result.outcome === "accepted" ? null : result.message],
    );
    let status: string;
    let next: Date | null = null;
    switch (result.outcome) {
      case "accepted":
        status = "accepted";
        break;
      case "rejected":
        status = "rejected";
        break;
      case "timeout_unknown":
        status = attemptNo >= maxAttempts ? "expired" : "unknown_outcome";
        next = status === "unknown_outcome" ? new Date(now.getTime() + backoffMs(attemptNo)) : null;
        break;
      default:
        status = attemptNo >= maxAttempts ? "rejected" : "retry_scheduled";
        next = status === "retry_scheduled" ? new Date(now.getTime() + backoffMs(attemptNo)) : null;
    }
    await c.query(
      `update public.destination_deliveries set status = $2, next_attempt_at = $3, last_http_status = $4, last_provider_code = $5, last_trace_id = $6, last_error = $7 where id = $1`,
      [deliveryId, status, next, result.httpStatus, result.providerCode, result.traceId, result.outcome === "accepted" ? null : result.message],
    );
    await recordBreaker(c, orgId, scope, result.outcome === "accepted" || result.outcome === "rejected", now);
    if (next) {
      await c.query("insert into public.outbox (organization_id, topic, payload, dedup_key, priority, available_at) values ($1, 'delivery.send', $2, $3, 6, $4) on conflict do nothing", [
        orgId, JSON.stringify({ delivery_id: deliveryId }), `delivery:${deliveryId}:${attemptNo + 1}`, next,
      ]);
    }
    return { status, ...(next ? { reschedule: next } : {}), attempt: result };
  });
}

export function appSecretProof(appSecret: string, token: string) {
  return createHmac("sha256", appSecret).update(token).digest("hex");
}
