import { createHash } from "node:crypto";
import { withTx, isUniqueViolation } from "@tracker/db";
import { MFA_REQUIRED_ROLES, ROLE_PERMISSIONS, isRole, type Permission } from "@tracker/domain";
import type { AppDeps, AuthInfo, OrgInfo } from "../context";
import { DUMMY_PASSWORD_HASH, decryptSecret, encryptSecret, hashPassword, hmacToken, newTotpSecret, randomToken, verifyPassword, verifyTotp } from "../lib/crypto";
import { HttpError, badRequest, conflict, forbidden, tooMany, unauthorized } from "../lib/errors";

/**
 * Autenticação própria (D-003): cadastro, login, sessões opacas, verificação de e-mail, recuperação de senha,
 * encerramento de sessões, bloqueio progressivo e MFA TOTP (R06-01..R06-03).
 */

const LOGIN_WINDOW_MIN = 15;
const MAX_FAILURES_PER_EMAIL = 5;
const MAX_FAILURES_PER_IP = 30;

const bucketHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

export function validatePassword(password: string): void {
  if (password.length < 10) throw badRequest("weak_password", "A senha deve ter pelo menos 10 caracteres");
  if (password.length > 256) throw badRequest("weak_password", "Senha muito longa");
  if (/^(.)\1+$/.test(password)) throw badRequest("weak_password", "Senha trivial");
}

async function sendVerification(deps: AppDeps, userId: string, email: string) {
  const token = randomToken(40);
  await withTx(deps.pools.system, null, (c) =>
    c.query("insert into iam.email_tokens (user_id, purpose, token_hash, expires_at) values ($1, 'verify_email', $2, now() + interval '48 hours')", [userId, hmacToken(deps.config.tokenHmacKey, token)]),
  );
  const url = `${deps.config.NEXT_PUBLIC_APP_URL}/verificar-email?token=${token}`;
  await deps.email.send({ to: email, subject: "Confirme seu e-mail", text: `Confirme seu e-mail: ${url}`, kind: "verify_email", actionUrl: url });
}

export async function signup(deps: AppDeps, input: { email: string; password: string; displayName: string }): Promise<{ userId: string }> {
  validatePassword(input.password);
  const email = input.email.trim().toLowerCase();
  const passwordHash = await hashPassword(input.password);
  let userId: string;
  try {
    userId = await withTx(deps.pools.system, null, async (c) => {
      const r = await c.query("insert into iam.users (email, password_hash, display_name) values ($1, $2, $3) returning id", [email, passwordHash, input.displayName.trim()]);
      return r.rows[0].id as string;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("email_in_use", "Já existe uma conta com este e-mail");
    throw err;
  }
  await sendVerification(deps, userId, email);
  return { userId };
}

export async function resendVerification(deps: AppDeps, auth: AuthInfo) {
  if (auth.emailVerified) return;
  await sendVerification(deps, auth.userId, auth.email);
}

async function recentFailures(deps: AppDeps, bucket: string): Promise<number> {
  const r = await deps.pools.system.query(
    `select count(*)::int as n from iam.auth_attempts where bucket = $1 and success = false and created_at > now() - make_interval(mins => $2)`,
    [bucket, LOGIN_WINDOW_MIN],
  );
  return r.rows[0].n as number;
}

export async function login(
  deps: AppDeps,
  input: { email: string; password: string; ip: string; userAgent: string | null },
): Promise<{ token: string; sessionId: string; mfaPending: boolean }> {
  const email = input.email.trim().toLowerCase();
  const emailBucket = `login:email:${bucketHash(email)}`;
  const ipBucket = `login:ip:${bucketHash(input.ip)}`;
  if ((await recentFailures(deps, emailBucket)) >= MAX_FAILURES_PER_EMAIL || (await recentFailures(deps, ipBucket)) >= MAX_FAILURES_PER_IP) {
    throw tooMany("Muitas tentativas de login. Aguarde 15 minutos ou redefina a senha.");
  }
  const r = await deps.pools.system.query(
    "select u.id, u.password_hash, u.disabled_at, m.confirmed_at as mfa_confirmed from iam.users u left join iam.mfa_totp m on m.user_id = u.id where u.email = $1",
    [email],
  );
  const user = r.rows[0] as { id: string; password_hash: string; disabled_at: Date | null; mfa_confirmed: Date | null } | undefined;
  const ok = await verifyPassword(input.password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!user || !ok || user.disabled_at) {
    await deps.pools.system.query("insert into iam.auth_attempts (bucket, success) values ($1, false), ($2, false)", [emailBucket, ipBucket]);
    // Mensagem genérica: não revela se o e-mail existe.
    throw unauthorized("E-mail ou senha inválidos");
  }
  await deps.pools.system.query("insert into iam.auth_attempts (bucket, success) values ($1, true)", [emailBucket]);
  const token = randomToken(48);
  const sessionId = await withTx(deps.pools.system, null, async (c) => {
    const s = await c.query(
      `insert into iam.sessions (user_id, token_hash, expires_at, user_agent) values ($1, $2, now() + make_interval(hours => $3), $4) returning id`,
      [user.id, hmacToken(deps.config.tokenHmacKey, token), deps.config.SESSION_TTL_HOURS, input.userAgent?.slice(0, 300) ?? null],
    );
    return s.rows[0].id as string;
  });
  return { token, sessionId, mfaPending: !!user.mfa_confirmed };
}

export async function resolveSession(deps: AppDeps, token: string): Promise<AuthInfo | null> {
  if (!/^[A-Za-z0-9]{48}$/.test(token)) return null;
  const r = await deps.pools.system.query(
    `update iam.sessions s set last_seen_at = now()
       from iam.users u left join iam.mfa_totp m on m.user_id = u.id
      where s.token_hash = $1 and s.user_id = u.id and s.revoked_at is null and s.expires_at > now() and u.disabled_at is null
      returning s.id as session_id, u.id as user_id, u.email, u.display_name, u.email_verified_at, u.is_platform_admin,
                s.mfa_verified_at, m.confirmed_at as mfa_confirmed`,
    [hmacToken(deps.config.tokenHmacKey, token)],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    sessionId: row.session_id,
    email: row.email,
    displayName: row.display_name,
    emailVerified: !!row.email_verified_at,
    mfaEnabled: !!row.mfa_confirmed,
    mfaVerified: !row.mfa_confirmed || !!row.mfa_verified_at,
    isPlatformAdmin: row.is_platform_admin,
  };
}

export async function logout(deps: AppDeps, sessionId: string, all: boolean, userId: string) {
  if (all) await deps.pools.system.query("update iam.sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [userId]);
  else await deps.pools.system.query("update iam.sessions set revoked_at = now() where id = $1", [sessionId]);
}

export async function verifyEmail(deps: AppDeps, token: string) {
  const r = await withTx(deps.pools.system, null, async (c) => {
    const t = await c.query(
      "update iam.email_tokens set used_at = now() where token_hash = $1 and purpose = 'verify_email' and used_at is null and expires_at > now() returning user_id",
      [hmacToken(deps.config.tokenHmacKey, token)],
    );
    if (!t.rows[0]) return null;
    await c.query("update iam.users set email_verified_at = coalesce(email_verified_at, now()) where id = $1", [t.rows[0].user_id]);
    return t.rows[0].user_id as string;
  });
  if (!r) throw badRequest("invalid_token", "Link de verificação inválido ou expirado");
}

export async function requestPasswordReset(deps: AppDeps, emailInput: string, ip: string) {
  const email = emailInput.trim().toLowerCase();
  const bucket = `reset:ip:${bucketHash(ip)}`;
  if ((await recentFailures(deps, bucket)) >= 10) throw tooMany();
  await deps.pools.system.query("insert into iam.auth_attempts (bucket, success) values ($1, false)", [bucket]);
  const u = await deps.pools.system.query("select id from iam.users where email = $1 and disabled_at is null", [email]);
  if (!u.rows[0]) return; // resposta idêntica para não revelar contas
  const token = randomToken(40);
  await deps.pools.system.query(
    "insert into iam.email_tokens (user_id, purpose, token_hash, expires_at) values ($1, 'reset_password', $2, now() + interval '1 hour')",
    [u.rows[0].id, hmacToken(deps.config.tokenHmacKey, token)],
  );
  const url = `${deps.config.NEXT_PUBLIC_APP_URL}/redefinir-senha?token=${token}`;
  await deps.email.send({ to: email, subject: "Redefinição de senha", text: `Redefina sua senha: ${url}`, kind: "reset_password", actionUrl: url });
}

export async function resetPassword(deps: AppDeps, token: string, newPassword: string) {
  validatePassword(newPassword);
  const hash = await hashPassword(newPassword);
  const ok = await withTx(deps.pools.system, null, async (c) => {
    const t = await c.query(
      "update iam.email_tokens set used_at = now() where token_hash = $1 and purpose = 'reset_password' and used_at is null and expires_at > now() returning user_id",
      [hmacToken(deps.config.tokenHmacKey, token)],
    );
    const userId = t.rows[0]?.user_id as string | undefined;
    if (!userId) return false;
    await c.query("update iam.users set password_hash = $2, email_verified_at = coalesce(email_verified_at, now()) where id = $1", [userId, hash]);
    // Encerrar todas as sessões após troca de senha.
    await c.query("update iam.sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [userId]);
    return true;
  });
  if (!ok) throw badRequest("invalid_token", "Link de redefinição inválido ou expirado");
}

// ---------------------------------------------------------------- MFA

const totpAad = (userId: string) => `iam.mfa_totp:${userId}`;

export async function startMfaSetup(deps: AppDeps, auth: AuthInfo): Promise<{ secret: string; otpauthUrl: string }> {
  if (auth.mfaEnabled) throw conflict("mfa_already_enabled", "MFA já está ativo");
  const secret = newTotpSecret();
  const enc = encryptSecret({ keys: deps.config.credentialKeys, current: deps.config.CREDENTIALS_KEY_CURRENT }, secret, totpAad(auth.userId));
  await deps.pools.system.query(
    `insert into iam.mfa_totp (user_id, secret_ciphertext, key_version) values ($1, $2, $3)
     on conflict (user_id) do update set secret_ciphertext = excluded.secret_ciphertext, key_version = excluded.key_version, confirmed_at = null, last_used_step = null
     where iam.mfa_totp.confirmed_at is null`,
    [auth.userId, enc.ciphertext, enc.keyVersion],
  );
  const label = encodeURIComponent(`Tracker:${auth.email}`);
  return { secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=Tracker&algorithm=SHA1&digits=6&period=30` };
}

async function checkTotp(deps: AppDeps, userId: string, code: string, requireConfirmed: boolean): Promise<boolean> {
  return withTx(deps.pools.system, null, async (c) => {
    const r = await c.query("select secret_ciphertext, confirmed_at, last_used_step from iam.mfa_totp where user_id = $1 for update", [userId]);
    const row = r.rows[0];
    if (!row || (requireConfirmed && !row.confirmed_at)) return false;
    const secret = decryptSecret({ keys: deps.config.credentialKeys, current: deps.config.CREDENTIALS_KEY_CURRENT }, row.secret_ciphertext, totpAad(userId));
    const res = verifyTotp(secret, code, deps.now(), row.last_used_step === null ? null : Number(row.last_used_step));
    if (!res.ok) return false;
    await c.query("update iam.mfa_totp set last_used_step = $2, confirmed_at = coalesce(confirmed_at, now()) where user_id = $1", [userId, res.step]);
    return true;
  });
}

export async function confirmMfa(deps: AppDeps, auth: AuthInfo, code: string) {
  if (!(await checkTotp(deps, auth.userId, code, false))) throw badRequest("invalid_code", "Código inválido");
  await deps.pools.system.query("update iam.sessions set mfa_verified_at = now() where id = $1", [auth.sessionId]);
}

export async function verifyMfaForSession(deps: AppDeps, auth: AuthInfo, code: string, ip: string) {
  const bucket = `mfa:user:${auth.userId}`;
  if ((await recentFailures(deps, bucket)) >= 5) throw tooMany();
  if (!(await checkTotp(deps, auth.userId, code, true))) {
    await deps.pools.system.query("insert into iam.auth_attempts (bucket, success) values ($1, false), ($2, false)", [bucket, `mfa:ip:${bucketHash(ip)}`]);
    throw badRequest("invalid_code", "Código inválido");
  }
  await deps.pools.system.query("update iam.sessions set mfa_verified_at = now() where id = $1", [auth.sessionId]);
}

// ---------------------------------------------------------------- organização/permissões

export async function loadOrgContext(deps: AppDeps, auth: AuthInfo, orgId: string): Promise<OrgInfo | null> {
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) return null;
  return withTx(deps.pools.system, { organizationId: orgId }, async (c) => {
    const r = await c.query(
      `select m.role, o.mfa_required, o.timezone, o.currency, o.is_demo, o.internal_mode
         from public.memberships m join public.organizations o on o.id = m.organization_id
        where m.organization_id = $1 and m.user_id = $2 and m.status = 'active'`,
      [orgId, auth.userId],
    );
    const row = r.rows[0];
    if (!row || !isRole(row.role)) return null;
    const p = await c.query("select project_id from public.project_memberships where organization_id = $1 and user_id = $2", [orgId, auth.userId]);
    const restricted = row.role !== "owner" && row.role !== "admin" && p.rows.length > 0;
    return {
      id: orgId,
      role: row.role,
      permissions: ROLE_PERMISSIONS[row.role as keyof typeof ROLE_PERMISSIONS],
      projectIds: restricted ? p.rows.map((x) => x.project_id as string) : null,
      mfaRequired: row.mfa_required,
      timezone: row.timezone,
      currency: row.currency,
      isDemo: row.is_demo,
      internalMode: row.internal_mode,
    };
  });
}

/** Verificação no servidor de permissão + MFA para ações privilegiadas (R06-03, R40-01). */
export function assertPermission(auth: AuthInfo | null, org: OrgInfo | null, permission: Permission, opts: { sensitive?: boolean } = {}) {
  if (!auth) throw unauthorized();
  if (!org) throw forbidden("org_required", "Selecione uma organização da qual você é membro");
  if (!org.permissions.has(permission)) throw forbidden("permission_denied", `Permissão necessária: ${permission}`);
  if (opts.sensitive && org.mfaRequired && MFA_REQUIRED_ROLES.has(org.role) && !auth.mfaEnabled) {
    throw new HttpError(403, "mfa_setup_required", "Ative a autenticação multifator para executar esta ação");
  }
}

export function assertProjectAccess(org: OrgInfo, projectId: string) {
  if (org.projectIds && !org.projectIds.includes(projectId)) throw forbidden("project_forbidden", "Sem acesso a este projeto");
}
