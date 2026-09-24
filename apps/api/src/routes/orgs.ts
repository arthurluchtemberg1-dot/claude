import { randomUUID } from "node:crypto";
import { withTx, isUniqueViolation } from "@tracker/db";
import { isValidTimeZone, isSupportedCurrency, ROLES } from "@tracker/domain";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../context";
import { hmacToken, randomToken } from "../lib/crypto";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../lib/errors";
import { audit, jsonSafe, orgTx } from "../lib/org-tx";
import { assertPermission } from "../services/auth";

const tz = z.string().refine(isValidTimeZone, "Fuso horário inválido");
const currency = z.string().regex(/^[A-Z]{3}$/).refine(isSupportedCurrency, "Moeda não suportada");
const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "org";

export const newPublicKey = () => `pk_${randomToken(24)}`;

export const orgRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    // ---------------------------------------------------------------- organizações
    app.post("/orgs", async (req, reply) => {
      if (!req.auth || !req.auth.mfaVerified) throw unauthorized();
      const body = z
        .object({
          name: z.string().trim().min(1).max(120),
          timezone: tz.default("America/Sao_Paulo"),
          currency: currency.default("BRL"),
          internal_mode: z.boolean().default(false),
          first_project_name: z.string().trim().min(1).max(120).default("Projeto principal"),
        })
        .parse(req.body);
      const orgId = randomUUID();
      const slug = `${slugify(body.name)}-${randomToken(6).toLowerCase()}`;
      const userId = req.auth.userId;
      const result = await withTx(deps.pools.system, { organizationId: orgId }, async (c) => {
        await c.query(
          "insert into public.organizations (id, name, slug, timezone, currency, internal_mode, created_by, mfa_required) values ($1, $2, $3, $4, $5, $6, $7, $8)",
          [orgId, body.name, slug, body.timezone, body.currency, body.internal_mode, userId, deps.config.mfaRequiredDefault],
        );
        await c.query("insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'owner')", [orgId, userId]);
        const p = await c.query("insert into public.projects (organization_id, name, public_key) values ($1, $2, $3) returning id, public_key", [orgId, body.first_project_name, newPublicKey()]);
        await c.query(
          "insert into public.attribution_policies (organization_id, policy_key, name, version, model, window_days, is_default, created_by) values ($1, 'default', 'Último clique pago elegível — 7 dias', 1, 'last_paid_click', 7, true, $2)",
          [orgId, userId],
        );
        await audit(c, { organizationId: orgId, actorId: userId, action: "organization.created", targetType: "organization", targetId: orgId, requestId: req.id, details: { internal_mode: body.internal_mode } });
        return { id: orgId, slug, project: p.rows[0] };
      });
      return reply.status(201).send(result);
    });

    app.get("/org", async (req) =>
      orgTx(deps, req, async (c, { org }) => {
        const r = await c.query("select id, name, slug, timezone, currency, locale, internal_mode, is_demo, mfa_required, created_at from public.organizations where id = $1", [org.id]);
        return { organization: r.rows[0], membership: { role: org.role, permissions: [...org.permissions], project_ids: org.projectIds } };
      }),
    );

    app.patch("/org", async (req) => {
      assertPermission(req.auth, req.org, "org.manage", { sensitive: true });
      const body = z
        .object({ name: z.string().trim().min(1).max(120).optional(), timezone: tz.optional(), currency: currency.optional(), internal_mode: z.boolean().optional(), mfa_required: z.boolean().optional() })
        .parse(req.body);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const sets: string[] = [];
        const vals: unknown[] = [org.id];
        for (const [k, v] of Object.entries(body)) {
          if (v === undefined) continue;
          vals.push(v);
          sets.push(`${k} = $${vals.length}`);
        }
        if (sets.length) await c.query(`update public.organizations set ${sets.join(", ")} where id = $1`, vals);
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "organization.updated", details: body, requestId: req.id });
        return { ok: true };
      });
    });

    // ---------------------------------------------------------------- membros
    app.get("/members", async (req) => {
      assertPermission(req.auth, req.org, "members.manage");
      const members = await orgTx(deps, req, async (c) => (await c.query("select id, user_id, role, status, created_at from public.memberships where status <> 'removed' order by created_at")).rows);
      // Nomes/e-mails vêm do IAM (fora do schema exposto) somente para membros desta organização.
      const ids = members.map((m) => m.user_id);
      const users = ids.length ? (await deps.pools.system.query("select id, email, display_name from iam.users where id = any($1)", [ids])).rows : [];
      const byId = new Map(users.map((u) => [u.id, u]));
      const pm = await orgTx(deps, req, async (c) => (await c.query("select user_id, project_id from public.project_memberships")).rows);
      return {
        members: members.map((m) => ({
          ...m,
          email: byId.get(m.user_id)?.email,
          display_name: byId.get(m.user_id)?.display_name,
          project_ids: pm.filter((p) => p.user_id === m.user_id).map((p) => p.project_id),
        })),
      };
    });

    app.patch("/members/:id", async (req) => {
      assertPermission(req.auth, req.org, "members.manage", { sensitive: true });
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z.object({ role: z.enum(ROLES).optional(), status: z.enum(["active", "suspended", "removed"]).optional() }).parse(req.body);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const r = await c.query("select id, user_id, role, status from public.memberships where id = $1 for update", [id]);
        const m = r.rows[0];
        if (!m) throw notFound("Membro não encontrado");
        const touchesOwner = m.role === "owner" || body.role === "owner";
        if (touchesOwner && org.role !== "owner") throw forbidden("owner_only", "Somente o proprietário altera proprietários");
        if (m.role === "owner" && (body.role && body.role !== "owner" || body.status && body.status !== "active")) {
          const owners = await c.query("select count(*)::int as n from public.memberships where role = 'owner' and status = 'active'");
          if (owners.rows[0].n <= 1) throw conflict("last_owner", "A organização precisa de ao menos um proprietário ativo");
        }
        await c.query("update public.memberships set role = coalesce($2, role), status = coalesce($3, status) where id = $1", [id, body.role ?? null, body.status ?? null]);
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "membership.updated", targetType: "membership", targetId: id, details: { from: { role: m.role, status: m.status }, to: body }, requestId: req.id });
        return { ok: true };
      });
    });

    app.put("/members/:id/projects", async (req) => {
      assertPermission(req.auth, req.org, "members.manage", { sensitive: true });
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z.object({ project_ids: z.array(z.string().uuid()).max(500) }).parse(req.body);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const m = (await c.query("select user_id from public.memberships where id = $1", [id])).rows[0];
        if (!m) throw notFound("Membro não encontrado");
        await c.query("delete from public.project_memberships where user_id = $1", [m.user_id]);
        for (const pid of body.project_ids) {
          await c.query("insert into public.project_memberships (organization_id, project_id, user_id) values ($1, $2, $3)", [org.id, pid, m.user_id]);
        }
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "membership.projects_set", targetType: "membership", targetId: id, details: { project_ids: body.project_ids }, requestId: req.id });
        return { ok: true };
      });
    });

    // ---------------------------------------------------------------- convites (uso único, expiração)
    app.post("/invites", async (req, reply) => {
      assertPermission(req.auth, req.org, "members.manage", { sensitive: true });
      const body = z.object({ email: z.string().trim().email().max(254), role: z.enum(["admin", "manager", "analyst", "finance", "viewer"]) }).parse(req.body);
      if (body.role === "admin" && req.org!.role !== "owner") throw forbidden("owner_only", "Somente o proprietário convida administradores");
      const token = randomToken(40);
      const invite = await orgTx(deps, req, async (c, { auth, org }) => {
        const r = await c.query(
          "insert into public.invites (organization_id, email, role, token_hash, expires_at, invited_by) values ($1, $2, $3, $4, now() + interval '7 days', $5) returning id, expires_at",
          [org.id, body.email.toLowerCase(), body.role, hmacToken(deps.config.tokenHmacKey, token), auth.userId],
        );
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "invite.created", targetType: "invite", targetId: r.rows[0].id, details: { role: body.role }, requestId: req.id });
        return r.rows[0];
      });
      const url = `${deps.config.NEXT_PUBLIC_APP_URL}/convite?token=${token}`;
      await deps.email.send({ to: body.email, subject: "Convite para o Tracker", text: `Você foi convidado: ${url}`, kind: "invite", actionUrl: url });
      return reply.status(201).send({ id: invite.id, expires_at: invite.expires_at });
    });

    app.get("/invites", async (req) => {
      assertPermission(req.auth, req.org, "members.manage");
      return orgTx(deps, req, async (c) => ({
        invites: (await c.query("select id, email, role, expires_at, accepted_at, revoked_at, created_at from public.invites order by created_at desc limit 200")).rows,
      }));
    });

    app.delete("/invites/:id", async (req) => {
      assertPermission(req.auth, req.org, "members.manage", { sensitive: true });
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return orgTx(deps, req, async (c, { auth, org }) => {
        await c.query("update public.invites set revoked_at = now() where id = $1 and accepted_at is null", [id]);
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "invite.revoked", targetType: "invite", targetId: id, requestId: req.id });
        return { ok: true };
      });
    });

    app.post("/invites/accept", async (req) => {
      if (!req.auth || !req.auth.mfaVerified) throw unauthorized();
      const { token } = z.object({ token: z.string().min(10).max(100) }).parse(req.body);
      const hash = hmacToken(deps.config.tokenHmacKey, token);
      const inv = (await deps.pools.system.query("select * from app.resolve_invite($1)", [hash])).rows[0];
      if (!inv || inv.revoked_at || inv.accepted_at || new Date(inv.expires_at) < deps.now()) throw badRequest("invalid_invite", "Convite inválido, expirado ou já utilizado");
      if (inv.email.toLowerCase() !== req.auth.email.toLowerCase()) throw forbidden("invite_email_mismatch", "Este convite foi enviado para outro e-mail");
      if (!req.auth.emailVerified) throw forbidden("email_not_verified", "Confirme seu e-mail antes de aceitar o convite");
      const userId = req.auth.userId;
      await withTx(deps.pools.system, { organizationId: inv.organization_id }, async (c) => {
        const u = await c.query("update public.invites set accepted_at = now(), accepted_by = $2 where id = $1 and accepted_at is null and revoked_at is null returning id", [inv.invite_id, userId]);
        if (!u.rows[0]) throw badRequest("invalid_invite", "Convite já utilizado");
        try {
          await c.query(
            `insert into public.memberships (organization_id, user_id, role) values ($1, $2, $3)
             on conflict (organization_id, user_id) do update set role = excluded.role, status = 'active'`,
            [inv.organization_id, userId, inv.role],
          );
        } catch (err) {
          if (isUniqueViolation(err)) throw conflict("already_member", "Você já é membro");
          throw err;
        }
        await audit(c, { organizationId: inv.organization_id, actorId: userId, action: "invite.accepted", targetType: "invite", targetId: inv.invite_id, requestId: req.id });
      });
      return { ok: true, organization_id: inv.organization_id, organization_name: inv.organization_name };
    });

    // ---------------------------------------------------------------- projetos
    app.get("/projects", async (req) =>
      orgTx(deps, req, async (c, { org }) => {
        const r = await c.query("select id, name, public_key, timezone, currency, allowed_origins, archived_at, created_at from public.projects order by created_at");
        return { projects: r.rows.filter((p) => !org.projectIds || org.projectIds.includes(p.id)) };
      }),
    );

    app.post("/projects", async (req, reply) => {
      assertPermission(req.auth, req.org, "org.manage");
      const body = z.object({ name: z.string().trim().min(1).max(120), timezone: tz.optional(), currency: currency.optional(), allowed_origins: z.array(z.string().url()).max(50).default([]) }).parse(req.body);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const r = await c.query(
          "insert into public.projects (organization_id, name, public_key, timezone, currency, allowed_origins) values ($1, $2, $3, $4, $5, $6) returning id, name, public_key",
          [org.id, body.name, newPublicKey(), body.timezone ?? null, body.currency ?? null, body.allowed_origins.map((o) => new URL(o).origin)],
        );
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "project.created", targetType: "project", targetId: r.rows[0].id, requestId: req.id });
        return reply.status(201).send(r.rows[0]);
      });
    });

    app.patch("/projects/:id", async (req) => {
      assertPermission(req.auth, req.org, "pixel.configure");
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z.object({ name: z.string().trim().min(1).max(120).optional(), allowed_origins: z.array(z.string().url()).max(50).optional(), archived: z.boolean().optional() }).parse(req.body);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const r = await c.query(
          `update public.projects set name = coalesce($2, name), allowed_origins = coalesce($3, allowed_origins),
             archived_at = case when $4::boolean is null then archived_at when $4 then coalesce(archived_at, now()) else null end
           where id = $1 returning id`,
          [id, body.name ?? null, body.allowed_origins ? body.allowed_origins.map((o) => new URL(o).origin) : null, body.archived ?? null],
        );
        if (!r.rows[0]) throw notFound("Projeto não encontrado");
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "project.updated", targetType: "project", targetId: id, details: body, requestId: req.id });
        return { ok: true };
      });
    });

    app.get("/audit-logs", async (req) => {
      assertPermission(req.auth, req.org, "members.manage");
      const q = z.object({ before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
      return orgTx(deps, req, async (c) => {
        const r = await c.query(
          "select id, actor_type, actor_id, action, target_type, target_id, details, request_id, created_at from public.audit_logs where ($1::bigint is null or id < $1) order by id desc limit $2",
          [q.before ?? null, q.limit],
        );
        const rows = r.rows;
        return jsonSafe({ entries: rows, next_before: rows.length === q.limit ? rows[rows.length - 1].id : null });
      });
    });
  };
