import { randomUUID } from "node:crypto";
import { mediaWritesState, upsertMetaAccount } from "@tracker/analytics";
import { createMetaGraphClient, MetaGraphError, type MetaAdAccount, type MetaGraphClient } from "@tracker/connectors";
import type { PoolClient } from "@tracker/db";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../context";
import { badRequest, HttpError, notFound } from "../lib/errors";
import { audit, jsonSafe, orgSystemTx, orgTx } from "../lib/org-tx";
import { assertPermission, assertProjectAccess } from "../services/auth";
import { loadCredential, revokeCredentials, storeCredential } from "../services/credentials";

/**
 * Conexão com a Meta (R19): token de acesso de um usuário do sistema do Business Manager (ou de usuário), validado
 * na hora junto à Graph API (/me, /me/permissions, /me/adaccounts), guardado cifrado e nunca devolvido.
 * Leitura exige ads_read ou ads_management; ações de gestão exigem ads_management + liberação do proprietário
 * + envio externo habilitado no servidor. A sincronização roda no worker (meta.sync).
 */

export function metaClient(deps: AppDeps, token: string): MetaGraphClient {
  return createMetaGraphClient({ accessToken: token, version: deps.config.META_GRAPH_API_VERSION, baseUrl: deps.config.META_GRAPH_BASE_URL, appSecret: deps.config.META_APP_SECRET ?? null });
}

async function currentConnection(c: PoolClient, orgId: string) {
  return (
    await c.query(
      "select id, project_id, name, status, config, last_success_at, last_error_at, last_error, created_at from public.provider_connections where organization_id = $1 and provider = 'meta_ads' and status <> 'revoked' order by created_at desc limit 1",
      [orgId],
    )
  ).rows[0] as { id: string; project_id: string; name: string; status: string; config: Record<string, unknown>; last_success_at: Date | null; last_error_at: Date | null; last_error: string | null } | undefined;
}

function translate(err: unknown): never {
  if (err instanceof MetaGraphError) throw new HttpError(err.kind === "auth" ? 400 : err.kind === "permission" ? 403 : 502, `meta_${err.kind}`, err.message);
  throw err;
}

export const metaRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.get("/meta", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      return orgTx(deps, req, async (c, { org }) => {
        const conn = await currentConnection(c, org.id);
        const settings = (await c.query("select settings->'media' as m from public.organizations where id = $1", [org.id])).rows[0]?.m ?? null;
        const writes = await mediaWritesState(c, org.id, deps.config.ALLOW_EXTERNAL_DELIVERY);
        const perms = ((conn?.config?.permissions as string[] | undefined) ?? []).filter(Boolean);
        const accounts = conn
          ? (
              await c.query(
                `select id, external_account_id, name, currency, timezone, account_status, amount_spent_minor, spend_cap_minor, balance_minor, is_prepay, min_daily_budget_minor,
                        business_name, sync_enabled, project_id, last_synced_at, synced_from, synced_to, last_sync_error
                   from public.ad_accounts where network = 'meta' and connection_id = $1 order by sync_enabled desc, name`,
                [conn.id],
              )
            ).rows
          : [];
        const assets = conn ? (await c.query("select kind, external_id, name, details, last_seen_at from public.meta_assets where connection_id = $1 order by kind, name", [conn.id])).rows : [];
        return jsonSafe({
          connection: conn ? { id: conn.id, name: conn.name, status: conn.status, project_id: conn.project_id, permissions: perms, meta_user: conn.config?.meta_user ?? null, last_success_at: conn.last_success_at, last_error: conn.last_error, last_error_at: conn.last_error_at } : null,
          accounts,
          pixels: assets.filter((a) => a.kind === "pixel"),
          pages: assets.filter((a) => a.kind === "page"),
          writes: { enabled: writes.enabled, reasons: writes.reasons, setting_on: !!settings?.media_writes, can_toggle: org.permissions.has("org.manage") },
          graph_version: deps.config.META_GRAPH_API_VERSION,
        });
      });
    });

    app.post("/meta/connect", async (req, reply) => {
      assertPermission(req.auth, req.org, "provider.connect", { sensitive: true });
      const b = z.object({ access_token: z.string().trim().min(20).max(1000).regex(/^[A-Za-z0-9_.|-]+$/, "token inválido"), project_id: z.string().uuid().optional() }).strict().parse(req.body);
      const org = req.org!;
      // Validação junto à Meta antes de guardar qualquer coisa.
      const g = metaClient(deps, b.access_token);
      let me: { id: string; name?: string };
      let perms: { permission: string; status: string }[];
      let accounts: MetaAdAccount[];
      try {
        me = await g.me();
        perms = await g.permissions();
        accounts = await g.adAccounts();
      } catch (err) {
        translate(err);
      }
      const granted = perms.filter((p) => p.status === "granted").map((p) => p.permission);
      if (!granted.includes("ads_read") && !granted.includes("ads_management")) {
        throw badRequest("meta_missing_permission", "O token precisa da permissão ads_read (leitura) — e ads_management para pausar, ativar e ajustar orçamento");
      }
      if (!accounts.length) throw badRequest("meta_no_accounts", "Nenhuma conta de anúncios acessível com este token. No Business Manager, atribua as contas ao usuário do sistema.");
      return orgSystemTx(deps, req, async (c, { auth }) => {
        const projectId = b.project_id ?? (await c.query("select id from public.projects where organization_id = $1 and archived_at is null order by created_at limit 1", [org.id])).rows[0]?.id;
        if (!projectId) throw badRequest("project_required", "Crie um projeto antes");
        assertProjectAccess(org, projectId);
        // Uma conexão Meta por organização: reconectar substitui o token e mantém contas e histórico.
        let conn = await currentConnection(c, org.id);
        const config = { meta_user: { id: me.id, name: me.name ?? null }, permissions: granted, graph_version: g.version };
        if (conn) {
          await c.query("update public.provider_connections set config = $2, status = 'connected', last_error = null, name = $3 where id = $1", [conn.id, JSON.stringify(config), `Meta Ads · ${me.name ?? me.id}`.slice(0, 120)]);
          await revokeCredentials(c, org.id, conn.id);
        } else {
          const r = await c.query(
            `insert into public.provider_connections (organization_id, project_id, provider, kind, name, status, environment, config, created_by)
             values ($1, $2, 'meta_ads', 'ad_network', $3, 'connected', 'production', $4, $5) returning id`,
            [org.id, projectId, `Meta Ads · ${me.name ?? me.id}`.slice(0, 120), JSON.stringify(config), auth.userId],
          );
          conn = { id: r.rows[0].id, project_id: projectId } as NonNullable<typeof conn>;
        }
        await storeCredential(c, deps.config, { organizationId: org.id, connectionId: conn.id, purpose: "oauth_access_token", value: b.access_token });
        for (const a of accounts) await upsertMetaAccount(c, org.id, projectId, conn.id, a, true);
        await c.query("insert into public.outbox (organization_id, topic, payload, dedup_key, priority) values ($1, 'meta.sync', $2, $3, 4) on conflict do nothing", [
          org.id, JSON.stringify({ connection_id: conn.id, backfill_days: 30 }), `meta-sync:${conn.id}:${randomUUID()}`,
        ]);
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "meta.connected", targetType: "connection", targetId: conn.id, details: { meta_user: me.id, permissions: granted, accounts: accounts.length }, requestId: req.id });
        reply.status(201);
        return { connection_id: conn.id, meta_user: { id: me.id, name: me.name ?? null }, permissions: granted, accounts: accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency, account_status: a.account_status })) };
      });
    });

    app.put("/meta/accounts/:id", async (req) => {
      assertPermission(req.auth, req.org, "provider.connect");
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const b = z.object({ sync_enabled: z.boolean().optional(), project_id: z.string().uuid().optional() }).strict().parse(req.body);
      return orgTx(deps, req, async (c, { auth, org }) => {
        if (b.project_id) assertProjectAccess(org, b.project_id);
        const r = await c.query("update public.ad_accounts set sync_enabled = coalesce($2, sync_enabled), project_id = coalesce($3, project_id) where id = $1 and network = 'meta' returning id", [id, b.sync_enabled ?? null, b.project_id ?? null]);
        if (!r.rowCount) throw notFound("Conta não encontrada");
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "meta.account_updated", targetType: "ad_account", targetId: id, details: b, requestId: req.id });
        return { ok: true };
      });
    });

    app.post("/meta/sync", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      const b = z.object({ backfill_days: z.number().int().min(1).max(90).optional() }).strict().parse(req.body ?? {});
      return orgSystemTx(deps, req, async (c, { org }) => {
        const conn = await currentConnection(c, org.id);
        if (!conn) throw notFound("Meta não conectada");
        // Uma sincronização manual por minuto.
        await c.query("insert into public.outbox (organization_id, topic, payload, dedup_key, priority) values ($1, 'meta.sync', $2, $3, 3) on conflict do nothing", [
          org.id, JSON.stringify({ connection_id: conn.id, ...(b.backfill_days ? { backfill_days: b.backfill_days } : {}) }), `meta-sync:${conn.id}:manual:${Math.floor(deps.now().getTime() / 60_000)}`,
        ]);
        return { queued: true };
      });
    });

    app.put("/meta/settings", async (req) => {
      assertPermission(req.auth, req.org, "org.manage", { sensitive: true });
      const b = z.object({ media_writes: z.boolean() }).strict().parse(req.body);
      return orgTx(deps, req, async (c, { auth, org }) => {
        await c.query("update public.organizations set settings = jsonb_set(settings, '{media}', coalesce(settings->'media', '{}') || $2::jsonb) where id = $1", [org.id, JSON.stringify({ media_writes: b.media_writes })]);
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "meta.writes_toggled", details: b, requestId: req.id });
        return { ok: true };
      });
    });

    app.delete("/meta", async (req) => {
      assertPermission(req.auth, req.org, "provider.connect", { sensitive: true });
      return orgSystemTx(deps, req, async (c, { auth, org }) => {
        const conn = await currentConnection(c, org.id);
        if (!conn) throw notFound("Meta não conectada");
        await revokeCredentials(c, org.id, conn.id);
        await c.query("update public.provider_connections set status = 'revoked' where id = $1", [conn.id]);
        await c.query("update public.ad_accounts set sync_enabled = false where connection_id = $1", [conn.id]);
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "meta.disconnected", targetType: "connection", targetId: conn.id, requestId: req.id });
        return { ok: true };
      });
    });

    // Diagnóstico: confere token e permissões agora (sem expor o token).
    app.post("/meta/check", async (req) => {
      assertPermission(req.auth, req.org, "provider.connect");
      const prep = await orgSystemTx(deps, req, async (c, { org }) => {
        const conn = await currentConnection(c, org.id);
        if (!conn) throw notFound("Meta não conectada");
        return { conn, token: (await loadCredential(c, deps.config, { organizationId: org.id, connectionId: conn.id, purpose: "oauth_access_token" })).current };
      });
      if (!prep.token) return { ok: false, error: "Token ausente; reconecte" };
      try {
        const g = metaClient(deps, prep.token);
        const [me, perms] = [await g.me(), await g.permissions()];
        return { ok: true, meta_user: me, permissions: perms.filter((p) => p.status === "granted").map((p) => p.permission) };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });
  };
