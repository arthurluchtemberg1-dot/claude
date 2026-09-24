import { randomUUID } from "node:crypto";
import { checkOutboundDestination, postSignedWebhook } from "@tracker/connectors";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../context";
import { hmacToken, randomToken } from "../lib/crypto";
import { badRequest, conflict, notFound } from "../lib/errors";
import { audit, jsonSafe, orgSystemTx, orgTx } from "../lib/org-tx";
import { API_SCOPES, PRODUCTION_ONLY_SCOPES, generateApiKey } from "../services/api-keys";
import { assertPermission } from "../services/auth";
import { loadSubscriptionSecrets, storeSubscriptionSecret } from "../services/credentials";

/**
 * Gestão (sessão do painel) de chaves da API pública e de webhooks de saída (R33-01, R33-04, R33-05).
 * Exige `api.manage` e MFA quando a organização o requer. Valores secretos aparecem uma única vez.
 */

const OUT_EVENTS = ["order.approved", "order.reversed", "order.status_changed"] as const;

export const apiManagementRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    // ------------------------------------------------------------------ chaves de API
    app.get("/api-keys", async (req) => {
      assertPermission(req.auth, req.org, "api.manage");
      return orgTx(deps, req, async (c) =>
        jsonSafe({
          api_keys: (
            await c.query(
              `select k.id, k.name, k.prefix, k.scopes, k.project_ids, k.environment, k.created_at, k.last_used_at, k.revoked_at, k.expires_at,
                      (select count(*) from public.api_key_usage u where u.api_key_id = k.id and u.occurred_at > now() - interval '24 hours') as requests_24h
                 from public.api_keys k order by k.created_at desc`,
            )
          ).rows,
          scopes: API_SCOPES,
        }),
      );
    });

    app.post("/api-keys", async (req, reply) => {
      assertPermission(req.auth, req.org, "api.manage", { sensitive: true });
      const body = z
        .object({
          name: z.string().trim().min(1).max(120),
          scopes: z.array(z.enum(API_SCOPES)).min(1).max(API_SCOPES.length),
          project_ids: z.array(z.string().uuid()).max(100).default([]),
          environment: z.enum(["production", "sandbox"]).default("production"),
          expires_in_days: z.number().int().min(1).max(730).optional(),
        })
        .parse(req.body);
      const scopes = [...new Set(body.scopes)];
      if (body.environment === "sandbox" && scopes.some((s) => PRODUCTION_ONLY_SCOPES.includes(s))) {
        throw badRequest("scope_not_allowed", `Chaves sandbox não podem ter ${PRODUCTION_ONLY_SCOPES.join(", ")} (agregam dados de produção)`);
      }
      return orgTx(deps, req, async (c, { auth, org }) => {
        const ids = [...new Set(body.project_ids)];
        if (org.projectIds && ids.some((p) => !org.projectIds!.includes(p))) throw badRequest("invalid_project", "Projeto fora do seu acesso");
        if (ids.length) {
          const n = (await c.query("select count(*)::int as n from public.projects where id = any($1)", [ids])).rows[0].n;
          if (n !== ids.length) throw badRequest("invalid_project", "Projeto inexistente nesta organização");
        }
        const { key, prefix } = generateApiKey(body.environment);
        const r = await c.query(
          `insert into public.api_keys (organization_id, name, prefix, key_hash, scopes, project_ids, environment, created_by, expires_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, case when $9::int is null then null else now() + make_interval(days => $9::int) end) returning id, created_at, expires_at`,
          [org.id, body.name, prefix, hmacToken(deps.config.tokenHmacKey, key), scopes, ids, body.environment, auth.userId, body.expires_in_days ?? null],
        );
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "api_key.created", targetType: "api_key", targetId: r.rows[0].id, details: { prefix, scopes, project_ids: ids, environment: body.environment }, requestId: req.id });
        // Somente o código aqui: o corpo é enviado depois do COMMIT (a chave precisa existir quando o cliente a usar).
        reply.status(201);
        return jsonSafe({ id: r.rows[0].id, prefix, key, scopes, project_ids: ids, environment: body.environment, expires_at: r.rows[0].expires_at, notice: "Guarde a chave agora: ela não será exibida novamente." });
      });
    });

    app.delete("/api-keys/:id", async (req) => {
      assertPermission(req.auth, req.org, "api.manage", { sensitive: true });
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const r = await c.query("update public.api_keys set revoked_at = coalesce(revoked_at, now()), revoked_by = coalesce(revoked_by, $2) where id = $1 returning prefix", [id, auth.userId]);
        if (!r.rows[0]) throw notFound("Chave não encontrada");
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "api_key.revoked", targetType: "api_key", targetId: id, details: { prefix: r.rows[0].prefix }, requestId: req.id });
        return { ok: true };
      });
    });

    // Uso sem conteúdo sensível: rota, método, status, latência e request_id (R33-04).
    app.get("/api-keys/:id/usage", async (req) => {
      assertPermission(req.auth, req.org, "api.manage");
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return orgTx(deps, req, async (c) => {
        const k = (await c.query("select id, prefix, last_used_at from public.api_keys where id = $1", [id])).rows[0];
        if (!k) throw notFound("Chave não encontrada");
        const recent = (await c.query("select occurred_at, method, route, status, latency_ms, request_id from public.api_key_usage where api_key_id = $1 order by occurred_at desc limit 100", [id])).rows;
        const byStatus = (await c.query("select status, count(*)::int as n from public.api_key_usage where api_key_id = $1 and occurred_at > now() - interval '24 hours' group by status order by status", [id])).rows;
        return jsonSafe({ key: k, recent, last_24h: byStatus });
      });
    });

    // ------------------------------------------------------------------ webhooks de saída
    const subscriptionBody = z.object({
      name: z.string().trim().min(1).max(120),
      url: z.string().trim().min(8).max(2048),
      events: z.array(z.enum(OUT_EVENTS)).min(1),
      project_ids: z.array(z.string().uuid()).max(100).default([]),
      include_test: z.boolean().default(false),
    });

    async function assertDestination(url: string) {
      const v = await checkOutboundDestination(url, deps.config.outboundPolicy);
      if (!v.ok) throw badRequest("destination_blocked", `Destino não permitido: ${v.reason}`);
    }

    app.get("/webhook-subscriptions", async (req) => {
      assertPermission(req.auth, req.org, "api.manage");
      return orgTx(deps, req, async (c) =>
        jsonSafe({
          subscriptions: (
            await c.query(
              `select s.id, s.name, s.url, s.events, s.project_ids, s.include_test, s.status, s.verified_at, s.consecutive_failures, s.last_success_at, s.last_failure_at, s.last_error, s.created_at,
                      (select count(*) from public.webhook_out_deliveries d where d.subscription_id = s.id and d.status = 'dead') as dead_deliveries,
                      (select count(*) from public.webhook_out_deliveries d where d.subscription_id = s.id and d.status in ('pending', 'retry_scheduled')) as pending_deliveries
                 from public.webhook_subscriptions s where s.status <> 'disabled' order by s.created_at desc`,
            )
          ).rows,
          events: OUT_EVENTS,
        }),
      );
    });

    app.post("/webhook-subscriptions", async (req, reply) => {
      assertPermission(req.auth, req.org, "api.manage", { sensitive: true });
      const body = subscriptionBody.parse(req.body);
      await assertDestination(body.url);
      return orgSystemTx(deps, req, async (c, { auth, org }) => {
        const r = await c.query(
          `insert into public.webhook_subscriptions (organization_id, name, url, events, project_ids, include_test, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id, status`,
          [org.id, body.name, body.url, [...new Set(body.events)], body.project_ids, body.include_test, auth.userId],
        );
        const secret = `whsec_${randomToken(40)}`;
        await storeSubscriptionSecret(c, deps.config, org.id, r.rows[0].id, secret);
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "webhook_subscription.created", targetType: "webhook_subscription", targetId: r.rows[0].id, details: { host: new URL(body.url).host, events: body.events }, requestId: req.id });
        reply.status(201);
        return { id: r.rows[0].id, status: r.rows[0].status, signing_secret: secret, notice: "Guarde o segredo agora. A assinatura nasce pausada: envie um teste e ative." };
      });
    });

    app.patch("/webhook-subscriptions/:id", async (req) => {
      assertPermission(req.auth, req.org, "api.manage", { sensitive: true });
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = subscriptionBody.partial().extend({ status: z.enum(["active", "paused"]).optional() }).parse(req.body);
      if (body.url) await assertDestination(body.url);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const cur = (await c.query("select id, url, verified_at, status from public.webhook_subscriptions where id = $1 and status <> 'disabled' for update", [id])).rows[0];
        if (!cur) throw notFound("Assinatura não encontrada");
        const urlChanged = body.url !== undefined && body.url !== cur.url;
        // Novo destino precisa de nova verificação antes de receber eventos.
        const verified = urlChanged ? null : cur.verified_at;
        let status = body.status ?? (urlChanged ? "paused" : cur.status);
        if (urlChanged && status === "active") status = "paused";
        if (body.status === "active" && !verified) throw conflict("verification_required", "Envie um teste bem-sucedido para o destino antes de ativar");
        await c.query(
          `update public.webhook_subscriptions set name = coalesce($2, name), url = coalesce($3, url), events = coalesce($4, events), project_ids = coalesce($5, project_ids),
             include_test = coalesce($6, include_test), status = $7, verified_at = $8, consecutive_failures = case when $7 = 'active' then 0 else consecutive_failures end where id = $1`,
          [id, body.name ?? null, body.url ?? null, body.events ? [...new Set(body.events)] : null, body.project_ids ?? null, body.include_test ?? null, status, verified],
        );
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "webhook_subscription.updated", targetType: "webhook_subscription", targetId: id, details: { ...body, url: body.url ? new URL(body.url).host : undefined, status }, requestId: req.id });
        return { ok: true, status, verified: !!verified };
      });
    });

    app.delete("/webhook-subscriptions/:id", async (req) => {
      assertPermission(req.auth, req.org, "api.manage", { sensitive: true });
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return orgSystemTx(deps, req, async (c, { auth, org }) => {
        const r = await c.query("update public.webhook_subscriptions set status = 'disabled' where id = $1 returning id", [id]);
        if (!r.rows[0]) throw notFound("Assinatura não encontrada");
        await c.query("update private.credentials set revoked_at = now() where organization_id = $1 and subscription_id = $2 and revoked_at is null", [org.id, id]);
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "webhook_subscription.disabled", targetType: "webhook_subscription", targetId: id, requestId: req.id });
        return { ok: true };
      });
    });

    app.post("/webhook-subscriptions/:id/rotate-secret", async (req) => {
      assertPermission(req.auth, req.org, "api.manage", { sensitive: true });
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return orgSystemTx(deps, req, async (c, { auth, org }) => {
        const s = (await c.query("select id from public.webhook_subscriptions where id = $1 and status <> 'disabled'", [id])).rows[0];
        if (!s) throw notFound("Assinatura não encontrada");
        const secret = `whsec_${randomToken(40)}`;
        await storeSubscriptionSecret(c, deps.config, org.id, id, secret);
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "webhook_subscription.secret_rotated", targetType: "webhook_subscription", targetId: id, requestId: req.id });
        return { signing_secret: secret, notice: "Durante 24 h as entregas levam duas assinaturas (segredo novo e anterior)." };
      });
    });

    // Teste explícito: entrega assinada imediata; 2xx confirma a posse do destino (verificação).
    app.post("/webhook-subscriptions/:id/test", async (req) => {
      assertPermission(req.auth, req.org, "api.manage", { sensitive: true });
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const org = req.org!;
      const prep = await orgSystemTx(deps, req, async (c) => {
        const s = (await c.query("select id, url from public.webhook_subscriptions where id = $1 and status <> 'disabled'", [id])).rows[0];
        if (!s) throw notFound("Assinatura não encontrada");
        const secrets = await loadSubscriptionSecrets(c, deps.config, org.id, id);
        const eventId = `test.ping:${randomUUID()}`;
        const payload = { id: eventId, type: "test.ping", created_at: deps.now().toISOString(), api_version: "2026-09-24", data: { subscription_id: id, message: "Teste do Tracker. Responda 2xx para confirmar." }, provenance: { source: "test", hop: 1 } };
        const d = await c.query(
          "insert into public.webhook_out_deliveries (organization_id, subscription_id, event_id, event_type, payload, hop, attempts) values ($1, $2, $3, 'test.ping', $4, 1, 1) returning id",
          [org.id, id, eventId, JSON.stringify(payload)],
        );
        return { url: s.url as string, secrets, deliveryId: d.rows[0].id as string, payload };
      });
      await assertDestination(prep.url);
      const res = await postSignedWebhook(deps.config.outboundPolicy, { url: prep.url, deliveryId: prep.deliveryId, eventType: "test.ping", hop: 1, payload: prep.payload, secrets: prep.secrets }, deps.now());
      const ok = res.ok && res.status >= 200 && res.status < 300;
      const error = ok ? null : res.ok ? `HTTP ${res.status}` : `${res.error}: ${res.message}`;
      await orgSystemTx(deps, req, async (c, { auth }) => {
        await c.query(
          "update public.webhook_out_deliveries set status = $2, last_http_status = $3, last_error = $4, last_latency_ms = $5, delivered_at = case when $2 = 'succeeded' then now() end where id = $1",
          [prep.deliveryId, ok ? "succeeded" : !res.ok && res.error === "blocked" ? "blocked" : "dead", res.status, error, res.latencyMs],
        );
        if (ok) await c.query("update public.webhook_subscriptions set verified_at = now(), last_success_at = now(), last_error = null where id = $1", [id]);
        else await c.query("update public.webhook_subscriptions set last_failure_at = now(), last_error = $2 where id = $1", [id, error]);
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "webhook_subscription.tested", targetType: "webhook_subscription", targetId: id, details: { ok, http_status: res.status }, requestId: req.id });
      });
      return { ok, http_status: res.status, latency_ms: res.latencyMs, error, delivery_id: prep.deliveryId, verified: ok };
    });

    app.get("/webhook-subscriptions/:id/deliveries", async (req) => {
      assertPermission(req.auth, req.org, "api.manage");
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const q = z.object({ status: z.enum(["pending", "retry_scheduled", "succeeded", "dead", "blocked", "skipped"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
      return orgTx(deps, req, async (c) =>
        jsonSafe({
          deliveries: (
            await c.query(
              `select id, event_id, event_type, status, attempts, next_attempt_at, last_http_status, last_error, last_latency_ms, hop, created_at, delivered_at, payload
                 from public.webhook_out_deliveries where subscription_id = $1 and ($2::text is null or status = $2) order by created_at desc limit $3`,
              [id, q.status ?? null, q.limit],
            )
          ).rows,
        }),
      );
    });

    // Reenvio manual da fila de falhas: novo ciclo de tentativas com o MESMO ID de entrega (receptor deduplica).
    app.post("/webhook-deliveries/:id/resend", async (req) => {
      assertPermission(req.auth, req.org, "api.manage", { sensitive: true });
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return orgSystemTx(deps, req, async (c, { auth, org }) => {
        const d = (await c.query("select id, status, event_type, attempts from public.webhook_out_deliveries where id = $1 for update", [id])).rows[0];
        if (!d) throw notFound("Entrega não encontrada");
        if (d.event_type === "test.ping") throw badRequest("not_resendable", "Use o botão de teste da assinatura");
        if (!["dead", "blocked", "skipped"].includes(d.status)) throw conflict("not_resendable", `Entrega em estado ${d.status} não pode ser reenviada`);
        await c.query("update public.webhook_out_deliveries set status = 'pending', attempts = 0, next_attempt_at = null where id = $1", [id]);
        await c.query("insert into public.outbox (organization_id, topic, payload, dedup_key, priority) values ($1, 'webhooks.deliver', $2, $3, 7)", [
          org.id, JSON.stringify({ delivery_id: id }), `whd:${id}:resend:${randomUUID()}`,
        ]);
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "webhook_delivery.resent", targetType: "webhook_delivery", targetId: id, requestId: req.id });
        return { ok: true };
      });
    });
  };
