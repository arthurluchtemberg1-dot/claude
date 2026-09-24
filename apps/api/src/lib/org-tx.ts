import type { PoolClient } from "@tracker/db";
import { withTx } from "@tracker/db";
import type { FastifyRequest } from "fastify";
import type { AppDeps, AuthInfo, OrgInfo } from "../context";
import { forbidden, unauthorized } from "./errors";

/**
 * Executa com o papel tracker_app e contexto RLS (usuário + organização). Toda leitura/escrita autenticada
 * passa por aqui, de modo que o banco também impõe o isolamento (defesa em profundidade, R40-02).
 */
export async function orgTx<T>(deps: AppDeps, req: FastifyRequest, fn: (c: PoolClient, ctx: { auth: AuthInfo; org: OrgInfo }) => Promise<T>): Promise<T> {
  const auth = req.auth;
  if (!auth) throw unauthorized();
  if (!auth.mfaVerified) throw forbidden("mfa_verification_required", "Confirme o código de autenticação multifator");
  const org = req.org;
  if (!org) throw forbidden("org_required", "Selecione uma organização da qual você é membro");
  return withTx(deps.pools.app, { organizationId: org.id, userId: auth.userId }, (c) => fn(c, { auth, org }));
}

/** Transação com papel de sistema restrita à organização da requisição (para escritas controladas no servidor). */
export async function orgSystemTx<T>(deps: AppDeps, req: FastifyRequest, fn: (c: PoolClient, ctx: { auth: AuthInfo; org: OrgInfo }) => Promise<T>): Promise<T> {
  const auth = req.auth;
  if (!auth) throw unauthorized();
  if (!auth.mfaVerified) throw forbidden("mfa_verification_required", "Confirme o código de autenticação multifator");
  const org = req.org;
  if (!org) throw forbidden("org_required", "Selecione uma organização da qual você é membro");
  return withTx(deps.pools.system, { organizationId: org.id }, (c) => fn(c, { auth, org }));
}

export async function audit(
  c: PoolClient,
  entry: { organizationId: string; actorType?: string; actorId: string | null; action: string; targetType?: string; targetId?: string | null; details?: Record<string, unknown>; requestId?: string },
) {
  await c.query(
    `insert into public.audit_logs (organization_id, actor_type, actor_id, action, target_type, target_id, details, request_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [entry.organizationId, entry.actorType ?? "user", entry.actorId, entry.action, entry.targetType ?? null, entry.targetId ?? null, JSON.stringify(entry.details ?? {}), entry.requestId ?? null],
  );
}

/** Serialização JSON segura (bigint → string). */
export function jsonSafe<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val)));
}
