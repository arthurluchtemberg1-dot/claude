import { createHash } from "node:crypto";
import { CHECKOUT_CONNECTORS } from "@tracker/connectors";
import { withTx } from "@tracker/db";
import type { AppDeps } from "../context";
import { hmacToken } from "../lib/crypto";
import { loadCredential } from "./credentials";

/**
 * Recebimento confiável de webhooks (seção 09):
 * 1) resolve conexão por token opaco; 2) limites (tamanho/tipo/taxa na rota); 3) corpo bruto preservado;
 * 4) autenticação específica do provedor; 5) persiste recebimento + idempotência + trabalho na outbox numa
 * transação; 6) responde após o commit, sem aguardar processamento. Sem persistência → 503 (R09-11).
 */

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

const TOKEN_RE = /^whk_[A-Za-z0-9]{40}$/;
const HEADER_ALLOWLIST = ["content-type", "user-agent", "idempotency-key", "x-tracker-signature", "x-forwarded-for"];

export async function receiveWebhook(
  deps: AppDeps,
  input: { token: string; rawBody: Buffer; headers: Record<string, string | string[] | undefined>; contentType: string | undefined },
): Promise<WebhookResponse> {
  if (!TOKEN_RE.test(input.token)) return { status: 404, body: { error: "not_found" } };
  const resolved = (await deps.pools.system.query("select * from app.resolve_webhook_endpoint($1)", [hmacToken(deps.config.tokenHmacKey, input.token)])).rows[0];
  if (!resolved || resolved.endpoint_status !== "active") return { status: 404, body: { error: "not_found" } };
  if (resolved.connection_disabled) return { status: 410, body: { error: "connection_disabled" } };
  const connector = CHECKOUT_CONNECTORS[resolved.provider as string];
  if (!connector) return { status: 404, body: { error: "not_found" } };
  if (!input.contentType || !/^application\/json\b/i.test(input.contentType)) return { status: 415, body: { error: "unsupported_media_type" } };

  const receivedAt = deps.now();
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  const orgId = resolved.organization_id as string;

  let body: unknown = null;
  let parseError: string | null = null;
  try {
    body = JSON.parse(input.rawBody.toString("utf8"));
  } catch {
    parseError = "JSON inválido";
  }

  // Autenticação específica do provedor (segredos carregados sob o contexto da organização).
  const secrets = await withTx(deps.pools.system, { organizationId: orgId }, async (c) => {
    if (resolved.provider !== "custom") return {};
    const cred = await loadCredential(c, deps.config, { organizationId: orgId, connectionId: resolved.connection_id, purpose: "webhook_secret" });
    const out: Record<string, string> = {};
    if (cred.current) out.current = cred.current;
    if (cred.previous) out.previous = cred.previous;
    return out;
  });
  const authRes = connector.authenticate({ rawBody: input.rawBody, headers, receivedAt }, { secrets, config: resolved.config ?? {}, urlTokenVerified: true });
  if (!authRes.ok) {
    await withTx(deps.pools.system, { organizationId: orgId }, (c) =>
      c.query("insert into public.webhook_rejections (organization_id, endpoint_id, reason) values ($1, $2, $3)", [orgId, resolved.endpoint_id, authRes.reason.slice(0, 200)]),
    ).catch(() => undefined);
    // T19: não autenticado → rejeitado sem alterar finanças.
    return { status: 401, body: { error: "unauthorized" } };
  }

  const bodySha = createHash("sha256").update(input.rawBody).digest();
  const identity = parseError ? null : connector.dedupIdentity(body, { rawBody: input.rawBody, headers, receivedAt });
  const dedupKey = identity?.key ?? `sha256:${bodySha.toString("hex")}`;
  const dedupMethod = identity?.method ?? "fingerprint";
  const storedHeaders: Record<string, string> = {};
  for (const h of HEADER_ALLOWLIST) if (headers[h]) storedHeaders[h] = h === "x-tracker-signature" ? "[presente]" : String(headers[h]).slice(0, 300);

  const result = await withTx(deps.pools.system, { organizationId: orgId }, async (c) => {
    const r = await c.query(
      `insert into public.webhook_receipts
         (organization_id, project_id, connection_id, endpoint_id, provider, provider_account_id, dedup_key, dedup_method,
          source_event_type, received_at, body, body_sha256, content_type, headers, auth_method, status, status_reason, is_test, is_demo)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       on conflict (organization_id, provider_account_id, dedup_key)
       do update set delivery_count = public.webhook_receipts.delivery_count + 1, last_delivery_at = excluded.received_at
       returning id, (xmax = 0) as inserted, body_sha256`,
      [
        orgId,
        resolved.project_id,
        resolved.connection_id,
        resolved.endpoint_id,
        resolved.provider,
        resolved.provider_account_id,
        dedupKey,
        dedupMethod,
        identity?.sourceEventType ?? null,
        receivedAt,
        input.rawBody,
        bodySha,
        input.contentType?.slice(0, 100) ?? null,
        JSON.stringify(storedHeaders),
        authRes.method,
        parseError ? "quarantined" : "pending",
        parseError,
        resolved.environment === "test",
        resolved.is_demo,
      ],
    );
    const row = r.rows[0] as { id: string; inserted: boolean; body_sha256: Buffer };
    if (row.inserted && !parseError) {
      await c.query(
        "insert into public.outbox (organization_id, topic, payload, dedup_key, priority) values ($1, 'receipt.process', $2, $3, 1) on conflict do nothing",
        [orgId, JSON.stringify({ receipt_id: row.id }), `receipt:${row.id}`],
      );
    }
    await c.query("update public.webhook_endpoints set last_received_at = $2 where id = $1", [resolved.endpoint_id, receivedAt]);
    // Colisão de fingerprint/idempotência com corpo diferente: guardada para diagnóstico (R09-16).
    const collision = !row.inserted && Buffer.compare(row.body_sha256, bodySha) !== 0;
    return { id: row.id, duplicate: !row.inserted, collision };
  });
  if (result.collision) deps.logger.warn({ receipt: result.id, org: orgId }, "webhook_dedup_collision_different_body");
  return { status: 200, body: { received: true, duplicate: result.duplicate, receipt_id: result.id } };
}
