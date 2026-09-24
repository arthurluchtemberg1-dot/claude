import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../context";
import { unauthorized } from "../lib/errors";
import * as auth from "../services/auth";

const email = z.string().trim().email().max(254);
const password = z.string().min(1).max(256);

export function setSessionCookie(deps: AppDeps, reply: FastifyReply, token: string) {
  reply.setCookie(deps.config.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: deps.config.SESSION_COOKIE_SECURE,
    path: "/",
    maxAge: deps.config.SESSION_TTL_HOURS * 3600,
  });
}

export const authRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const limited = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

    app.post("/signup", limited, async (req, reply) => {
      const body = z.object({ email, password, displayName: z.string().trim().min(1).max(120) }).parse(req.body);
      await auth.signup(deps, body);
      const s = await auth.login(deps, { email: body.email, password: body.password, ip: req.ip, userAgent: req.headers["user-agent"] ?? null });
      setSessionCookie(deps, reply, s.token);
      return reply.status(201).send({ ok: true, email_verification_sent: true });
    });

    app.post("/login", limited, async (req, reply) => {
      const body = z.object({ email, password }).parse(req.body);
      const s = await auth.login(deps, { ...body, ip: req.ip, userAgent: req.headers["user-agent"] ?? null });
      setSessionCookie(deps, reply, s.token);
      return { ok: true, mfa_required: s.mfaPending };
    });

    app.post("/logout", async (req, reply) => {
      const body = z.object({ all: z.boolean().default(false) }).parse(req.body ?? {});
      if (req.auth) await auth.logout(deps, req.auth.sessionId, body.all, req.auth.userId);
      reply.clearCookie(deps.config.SESSION_COOKIE_NAME, { path: "/" });
      return { ok: true };
    });

    app.get("/me", async (req) => {
      if (!req.auth) throw unauthorized();
      const orgs = req.auth.mfaVerified
        ? (await deps.pools.system.query("select * from app.user_organizations($1)", [req.auth.userId])).rows
        : [];
      return {
        user: {
          id: req.auth.userId,
          email: req.auth.email,
          display_name: req.auth.displayName,
          email_verified: req.auth.emailVerified,
          mfa_enabled: req.auth.mfaEnabled,
          mfa_verified: req.auth.mfaVerified,
        },
        organizations: orgs.map((o) => ({ id: o.organization_id, name: o.name, slug: o.slug, role: o.role, is_demo: o.is_demo, internal_mode: o.internal_mode })),
      };
    });

    app.post("/verify-email", limited, async (req) => {
      const { token } = z.object({ token: z.string().min(10).max(100) }).parse(req.body);
      await auth.verifyEmail(deps, token);
      return { ok: true };
    });

    app.post("/resend-verification", limited, async (req) => {
      if (!req.auth) throw unauthorized();
      await auth.resendVerification(deps, req.auth);
      return { ok: true };
    });

    app.post("/password/forgot", limited, async (req) => {
      const body = z.object({ email }).parse(req.body);
      await auth.requestPasswordReset(deps, body.email, req.ip);
      return { ok: true, message: "Se o e-mail estiver cadastrado, enviaremos um link de redefinição." };
    });

    app.post("/password/reset", limited, async (req, reply) => {
      const body = z.object({ token: z.string().min(10).max(100), password }).parse(req.body);
      await auth.resetPassword(deps, body.token, body.password);
      reply.clearCookie(deps.config.SESSION_COOKIE_NAME, { path: "/" });
      return { ok: true };
    });

    app.post("/mfa/setup", async (req) => {
      if (!req.auth || !req.auth.mfaVerified) throw unauthorized();
      const r = await auth.startMfaSetup(deps, req.auth);
      return { secret: r.secret, otpauth_url: r.otpauthUrl };
    });

    app.post("/mfa/confirm", limited, async (req) => {
      if (!req.auth || !req.auth.mfaVerified) throw unauthorized();
      const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
      await auth.confirmMfa(deps, req.auth, code);
      return { ok: true };
    });

    app.post("/mfa/verify", limited, async (req) => {
      if (!req.auth) throw unauthorized();
      const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
      await auth.verifyMfaForSession(deps, req.auth, code, req.ip);
      return { ok: true };
    });

    app.get("/sessions", async (req) => {
      if (!req.auth) throw unauthorized();
      const r = await deps.pools.system.query(
        "select id, created_at, last_seen_at, expires_at, user_agent from iam.sessions where user_id = $1 and revoked_at is null and expires_at > now() order by last_seen_at desc",
        [req.auth.userId],
      );
      return { sessions: r.rows.map((s) => ({ ...s, current: s.id === req.auth!.sessionId })) };
    });

    app.delete("/sessions/:id", async (req) => {
      if (!req.auth) throw unauthorized();
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      await deps.pools.system.query("update iam.sessions set revoked_at = now() where id = $1 and user_id = $2", [id, req.auth.userId]);
      return { ok: true };
    });
  };
