import { CONNECTOR_CATALOG, IMPLEMENTATION_STATE_LABELS, LOWIFY_EVENTS, CHECKOUT_CONNECTORS, findManifest } from "@tracker/connectors";
import { isSupportedCurrency, isValidTimeZone } from "@tracker/domain";
import { isUniqueViolation } from "@tracker/db";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../context";
import { hmacToken, randomToken, tokenHint } from "../lib/crypto";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { audit, orgSystemTx, orgTx } from "../lib/org-tx";
import { assertPermission, assertProjectAccess } from "../services/auth";
import { revokeCredentials, storeCredential } from "../services/credentials";

/**
 * Catálogo, contas de provedor, conexões e endpoints de webhook (R11, R12-05).
 * A URL do webhook (com token) é exibida uma única vez na criação/rotação; depois só a dica final (R09-21).
 */

const lowifyConfig = z.object({
  currency: z.string().refine(isSupportedCurrency, "Moeda não suportada").default("BRL"),
  source_timezone: z.string().refine(isValidTimeZone, "Fuso inválido").default("America/Sao_Paulo"),
  selected_events: z.array(z.enum(LOWIFY_EVENTS)).min(1).default([...LOWIFY_EVENTS]),
  token_carrier: z.enum(["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]).nullable().default(null),
});

export const connectionRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.get("/catalog", async () => ({
      connectors: CONNECTOR_CATALOG.map((m) => ({
        id: m.id,
        display_name: m.displayName,
        kind: m.kind,
        group: m.group,
        state: m.state,
        state_label: IMPLEMENTATION_STATE_LABELS[m.state],
        state_note: m.stateNote,
        docs: m.docs,
        api_version: m.apiVersion,
        authentication: m.authentication,
        webhook_events: m.webhookEvents,
        utm_transport: m.utmTransport,
        money_field: m.moneyField,
        timezone: m.timezone,
        limits: m.limits,
        capabilities: m.capabilities,
        limitations: m.limitations,
        tests: m.tests,
        can_connect: !!CHECKOUT_CONNECTORS[m.id],
      })),
    }));

    app.get("/connections", async (req) =>
      orgTx(deps, req, async (c, { org }) => {
        const r = await c.query(
          `select c.id, c.project_id, c.provider, c.kind, c.name, c.status, c.environment, c.config, c.last_success_at, c.last_error_at, c.last_error, c.disabled_at, c.created_at,
                  a.id as account_id, a.external_account_id, a.display_name as account_name, a.revenue_role,
                  (select json_agg(json_build_object('id', e.id, 'hint', e.token_hint, 'status', e.status, 'last_received_at', e.last_received_at, 'created_at', e.created_at) order by e.created_at desc)
                     from public.webhook_endpoints e where e.connection_id = c.id) as endpoints,
                  (select count(*) from public.webhook_receipts w where w.connection_id = c.id) as receipts,
                  (select max(received_at) from public.webhook_receipts w where w.connection_id = c.id) as last_receipt_at
             from public.provider_connections c left join public.provider_accounts a on a.id = c.provider_account_id
            order by c.created_at`,
        );
        return {
          connections: r.rows
            .filter((x) => !org.projectIds || org.projectIds.includes(x.project_id))
            .map((x) => ({ ...x, receipts: Number(x.receipts), manifest_state: findManifest(x.provider)?.state ?? null })),
        };
      }),
    );

    app.post("/connections", async (req, reply) => {
      assertPermission(req.auth, req.org, "provider.connect", { sensitive: true });
      if (!req.auth!.emailVerified) throw forbidden("email_not_verified", "Confirme seu e-mail antes de conectar provedores");
      const body = z
        .object({
          provider: z.enum(["lowify", "custom"]),
          project_id: z.string().uuid(),
          name: z.string().trim().min(1).max(120),
          account_external_id: z.string().trim().min(1).max(200),
          account_display_name: z.string().trim().min(1).max(120),
          revenue_role: z.enum(["producer", "affiliate", "coproducer"]).default("producer"),
          environment: z.enum(["test", "production"]).default("production"),
          config: z.record(z.string(), z.unknown()).default({}),
        })
        .parse(req.body);
      assertProjectAccess(req.org!, body.project_id);
      const config = body.provider === "lowify" ? lowifyConfig.parse(body.config) : {};
      const token = `whk_${randomToken(40)}`;
      const secret = body.provider === "custom" ? `whsec_${randomToken(40)}` : null;
      const created = await orgSystemTx(deps, req, async (c, { auth, org }) => {
        // Conta lógica: reutilizada se já existir → reconexão não cria nova venda (T05).
        const a = await c.query(
          `insert into public.provider_accounts (organization_id, project_id, provider, external_account_id, display_name, revenue_role)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (organization_id, provider, external_account_id) do update set display_name = excluded.display_name
           returning id, project_id`,
          [org.id, body.project_id, body.provider, body.account_external_id, body.account_display_name, body.revenue_role],
        );
        if (a.rows[0].project_id !== body.project_id) throw conflict("account_in_other_project", "Esta conta do provedor já está vinculada a outro projeto");
        const conn = await c.query(
          `insert into public.provider_connections (organization_id, project_id, provider_account_id, provider, kind, name, status, environment, config, created_by)
           values ($1, $2, $3, $4, 'checkout', $5, 'awaiting_configuration', $6, $7, $8) returning id`,
          [org.id, body.project_id, a.rows[0].id, body.provider, body.name, body.environment, JSON.stringify(config), auth.userId],
        );
        const connectionId = conn.rows[0].id as string;
        const ep = await c.query(
          "insert into public.webhook_endpoints (organization_id, project_id, connection_id, token_hash, token_hint) values ($1, $2, $3, $4, $5) returning id",
          [org.id, body.project_id, connectionId, hmacToken(deps.config.tokenHmacKey, token), tokenHint(token)],
        );
        if (secret) await storeCredential(c, deps.config, { organizationId: org.id, connectionId, purpose: "webhook_secret", value: secret });
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "connection.created", targetType: "connection", targetId: connectionId, details: { provider: body.provider, environment: body.environment }, requestId: req.id });
        return { id: connectionId, endpoint_id: ep.rows[0].id, provider_account_id: a.rows[0].id };
      });
      return reply.status(201).send({
        ...created,
        // Exibidos uma única vez.
        webhook_url: `${deps.config.PUBLIC_API_URL}/v1/webhooks/${token}`,
        signing_secret: secret,
        warning: "Copie agora: a URL completa e o segredo não serão exibidos novamente.",
      });
    });

    app.patch("/connections/:id", async (req) => {
      assertPermission(req.auth, req.org, "provider.connect", { sensitive: true });
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z.object({ name: z.string().trim().min(1).max(120).optional(), config: z.record(z.string(), z.unknown()).optional(), disabled: z.boolean().optional() }).parse(req.body);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const cur = (await c.query("select provider, config from public.provider_connections where id = $1", [id])).rows[0];
        if (!cur) throw notFound("Conexão não encontrada");
        const config = body.config ? (cur.provider === "lowify" ? lowifyConfig.parse({ ...cur.config, ...body.config }) : cur.config) : cur.config;
        await c.query(
          `update public.provider_connections set name = coalesce($2, name), config = $3,
             disabled_at = case when $4::boolean is null then disabled_at when $4 then coalesce(disabled_at, now()) else null end,
             status = case when $4::boolean is true then 'disconnected' else status end
           where id = $1`,
          [id, body.name ?? null, JSON.stringify(config), body.disabled ?? null],
        );
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "connection.updated", targetType: "connection", targetId: id, details: { ...body, config: body.config ? Object.keys(body.config) : undefined }, requestId: req.id });
        return { ok: true };
      });
    });

    // Rotação: cria novo endpoint; o anterior pode ser revogado depois de atualizado no provedor.
    app.post("/connections/:id/endpoints", async (req, reply) => {
      assertPermission(req.auth, req.org, "provider.connect", { sensitive: true });
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const token = `whk_${randomToken(40)}`;
      const ep = await orgTx(deps, req, async (c, { auth, org }) => {
        const conn = (await c.query("select project_id from public.provider_connections where id = $1", [id])).rows[0];
        if (!conn) throw notFound("Conexão não encontrada");
        const r = await c.query(
          "insert into public.webhook_endpoints (organization_id, project_id, connection_id, token_hash, token_hint) values ($1, $2, $3, $4, $5) returning id",
          [org.id, conn.project_id, id, hmacToken(deps.config.tokenHmacKey, token), tokenHint(token)],
        );
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "endpoint.created", targetType: "connection", targetId: id, requestId: req.id });
        return r.rows[0];
      });
      return reply.status(201).send({ endpoint_id: ep.id, webhook_url: `${deps.config.PUBLIC_API_URL}/v1/webhooks/${token}`, warning: "Copie agora: a URL não será exibida novamente." });
    });

    app.delete("/connections/:id/endpoints/:endpointId", async (req) => {
      assertPermission(req.auth, req.org, "provider.connect", { sensitive: true });
      const { id, endpointId } = z.object({ id: z.string().uuid(), endpointId: z.string().uuid() }).parse(req.params);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const r = await c.query("update public.webhook_endpoints set status = 'revoked', revoked_at = now() where id = $1 and connection_id = $2 and status = 'active' returning id", [endpointId, id]);
        if (!r.rows[0]) throw notFound("Endpoint não encontrado ou já revogado");
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "endpoint.revoked", targetType: "endpoint", targetId: endpointId, requestId: req.id });
        return { ok: true };
      });
    });

    app.post("/connections/:id/rotate-secret", async (req) => {
      assertPermission(req.auth, req.org, "provider.connect", { sensitive: true });
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const secret = `whsec_${randomToken(40)}`;
      await orgSystemTx(deps, req, async (c, { auth, org }) => {
        const conn = (await c.query("select provider from public.provider_connections where id = $1", [id])).rows[0];
        if (!conn) throw notFound("Conexão não encontrada");
        if (conn.provider !== "custom") throw badRequest("not_supported", "Este provedor não usa segredo de assinatura");
        await storeCredential(c, deps.config, { organizationId: org.id, connectionId: id, purpose: "webhook_secret", value: secret });
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "connection.secret_rotated", targetType: "connection", targetId: id, requestId: req.id });
      });
      return { signing_secret: secret, transition_hours: 24, warning: "O segredo anterior será aceito por 24 horas." };
    });

    app.delete("/connections/:id", async (req) => {
      assertPermission(req.auth, req.org, "provider.connect", { sensitive: true });
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      // Desconectar revoga endpoints e credenciais, mas preserva pedidos e evidências (R37-05, R21-13).
      await orgSystemTx(deps, req, async (c, { auth, org }) => {
        const r = await c.query("update public.provider_connections set status = 'revoked', disabled_at = coalesce(disabled_at, now()) where id = $1 returning id", [id]);
        if (!r.rows[0]) throw notFound("Conexão não encontrada");
        await c.query("update public.webhook_endpoints set status = 'revoked', revoked_at = now() where connection_id = $1 and status = 'active'", [id]);
        await revokeCredentials(c, org.id, id);
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "connection.revoked", targetType: "connection", targetId: id, requestId: req.id });
      });
      return { ok: true };
    });

    app.patch("/provider-accounts/:id", async (req) => {
      assertPermission(req.auth, req.org, "provider.connect", { sensitive: true });
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z.object({ revenue_role: z.enum(["producer", "affiliate", "coproducer"]).optional(), display_name: z.string().trim().min(1).max(120).optional() }).parse(req.body);
      return orgTx(deps, req, async (c, { auth, org }) => {
        try {
          const r = await c.query("update public.provider_accounts set revenue_role = coalesce($2, revenue_role), display_name = coalesce($3, display_name) where id = $1 returning id", [id, body.revenue_role ?? null, body.display_name ?? null]);
          if (!r.rows[0]) throw notFound("Conta não encontrada");
        } catch (err) {
          if (isUniqueViolation(err)) throw conflict("duplicate", "Conflito");
          throw err;
        }
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "provider_account.updated", targetType: "provider_account", targetId: id, details: body, requestId: req.id });
        return { ok: true };
      });
    });
  };
