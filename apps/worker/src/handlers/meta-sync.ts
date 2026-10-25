import { replaceMetaInsights, upsertMetaAccount, upsertMetaEntities } from "@tracker/analytics";
import { createMetaGraphClient, MetaGraphError, type MetaGraphClient } from "@tracker/connectors";
import type { PoolClient } from "@tracker/db";
import { localDateOf } from "@tracker/domain";
import { notify } from "./notifications";

/**
 * Sincronização Meta (R19-03..R19-08, R21): por conta habilitada, detalhes da conta, campanhas/conjuntos/anúncios
 * (estado, orçamento, aprendizagem), insights diários nos três níveis e ativos (pixels, páginas).
 * Cada passo grava em transação curta; chamadas à Meta ficam fora de transação. Janela: backfill de N dias na
 * conexão; depois, os últimos 3 dias a cada ciclo (absorve correções tardias da Meta sem duplicar — snapshot).
 * Token inválido marca a conexão e avisa; limite de taxa reagenda; erro de uma conta não impede as demais.
 */

export interface MetaSyncDeps {
  loadToken: (c: PoolClient, orgId: string, connectionId: string) => Promise<string | null>;
  graph: { version: string; baseUrl?: string; appSecret?: string | null; fetchImpl?: typeof fetch; timeoutMs?: number };
}

type RunTx = <T>(fn: (c: PoolClient) => Promise<T>) => Promise<T>;

const LEVELS = ["campaign", "adset", "ad"] as const;

function addDays(d: string, n: number) {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

export async function runMetaSync(runTx: RunTx, deps: MetaSyncDeps, orgId: string, payload: { connection_id: string; backfill_days?: number }, now: Date) {
  const prep = await runTx(async (c) => {
    const conn = (await c.query("select id, project_id, status from public.provider_connections where organization_id = $1 and id = $2 and provider = 'meta_ads'", [orgId, payload.connection_id])).rows[0];
    if (!conn || conn.status === "revoked") return null;
    const token = await deps.loadToken(c, orgId, conn.id);
    const accounts = (
      await c.query("select id, external_account_id, project_id, currency, timezone, synced_to from public.ad_accounts where organization_id = $1 and connection_id = $2 and sync_enabled", [orgId, conn.id])
    ).rows;
    await c.query("update public.ad_accounts set last_sync_started_at = $3 where organization_id = $1 and connection_id = $2 and sync_enabled", [orgId, conn.id, now]);
    return { conn, token, accounts };
  });
  if (!prep) return { status: "skipped" as const };
  if (!prep.token) return markAuthFailure(runTx, orgId, prep.conn.id, "Token da Meta ausente; reconecte em Integrações → Meta", now);
  const g: MetaGraphClient = createMetaGraphClient({ accessToken: prep.token, ...deps.graph });
  const summary = { accounts: 0, entities: 0, insight_rows: 0, errors: [] as string[] };

  for (const acc of prep.accounts) {
    try {
      const details = await g.adAccount(acc.external_account_id);
      await runTx((c) => upsertMetaAccount(c, orgId, acc.project_id ?? prep.conn.project_id, prep.conn.id, details, false));
      const tz = details.timezone_name ?? acc.timezone ?? "America/Sao_Paulo";
      const today = localDateOf(now, tz);
      for (const level of LEVELS) {
        const rows = await g.entities(acc.external_account_id, level);
        summary.entities += await runTx((c) => upsertMetaEntities(c, orgId, acc.id, level, rows, today, now));
      }
      const backfill = payload.backfill_days ?? (acc.synced_to ? 0 : 30);
      const since = backfill ? addDays(today, -(backfill - 1)) : addDays(today, -2);
      for (const level of LEVELS) {
        const rows = await g.insights(acc.external_account_id, level, since, today);
        const r = await runTx((c) =>
          replaceMetaInsights(c, { orgId, accountId: acc.id, projectId: acc.project_id ?? prep.conn.project_id, level, since, until: today, currency: details.currency ?? acc.currency, rows }),
        );
        summary.insight_rows += r.written;
        summary.errors.push(...r.errors.slice(0, 5));
      }
      const [pixels, pages] = [await g.pixels(acc.external_account_id).catch(() => []), await g.pages(acc.external_account_id).catch(() => [])];
      await runTx(async (c) => {
        for (const p of pixels)
          await c.query(
            `insert into public.meta_assets (organization_id, connection_id, ad_account_id, kind, external_id, name, details, last_seen_at) values ($1, $2, $3, 'pixel', $4, $5, $6, $7)
             on conflict (organization_id, connection_id, kind, external_id) do update set name = excluded.name, details = excluded.details, last_seen_at = excluded.last_seen_at, ad_account_id = excluded.ad_account_id`,
            [orgId, prep.conn.id, acc.id, p.id, p.name ?? null, JSON.stringify({ last_fired_time: p.last_fired_time ?? null, is_unavailable: p.is_unavailable ?? null }), now],
          );
        for (const p of pages)
          await c.query(
            `insert into public.meta_assets (organization_id, connection_id, ad_account_id, kind, external_id, name, last_seen_at) values ($1, $2, $3, 'page', $4, $5, $6)
             on conflict (organization_id, connection_id, kind, external_id) do update set name = excluded.name, last_seen_at = excluded.last_seen_at`,
            [orgId, prep.conn.id, acc.id, p.id, p.name ?? null, now],
          );
        await c.query(
          `update public.ad_accounts set last_synced_at = $2, synced_from = least(coalesce(synced_from, $3::date), $3::date), synced_to = greatest(coalesce(synced_to, $4::date), $4::date),
             last_sync_error = null where id = $1`,
          [acc.id, now, since, today],
        );
      });
      summary.accounts++;
    } catch (err) {
      if (err instanceof MetaGraphError && err.kind === "auth") return markAuthFailure(runTx, orgId, prep.conn.id, err.message, now);
      // Limite de taxa: interrompe e deixa o próximo ciclo continuar (a fila reagenda com espera).
      if (err instanceof MetaGraphError && err.kind === "rate_limit") {
        await runTx((c) => c.query("update public.ad_accounts set last_sync_error = $2 where id = $1", [acc.id, err.message.slice(0, 500)]));
        throw err;
      }
      const msg = (err as Error).message.slice(0, 500);
      summary.errors.push(`${acc.external_account_id}: ${msg}`);
      await runTx((c) => c.query("update public.ad_accounts set last_sync_error = $2 where id = $1", [acc.id, msg]));
    }
  }
  await runTx((c) =>
    c.query(
      `update public.provider_connections set status = 'connected', last_success_at = case when $3 then $2::timestamptz else last_success_at end,
         last_error = $4, last_error_at = case when $4::text is null then last_error_at else $2::timestamptz end where id = $1`,
      [prep.conn.id, now, summary.accounts > 0 || prep.accounts.length === 0, summary.errors.length ? summary.errors.slice(0, 3).join(" | ").slice(0, 500) : null],
    ),
  );
  return { status: "ok" as const, ...summary };
}

async function markAuthFailure(runTx: RunTx, orgId: string, connectionId: string, message: string, now: Date) {
  await runTx(async (c) => {
    await c.query("update public.provider_connections set status = 'token_expired', last_error = $2, last_error_at = $3 where id = $1", [connectionId, message.slice(0, 500), now]);
    await notify(c, orgId, {
      kind: "token.expiring",
      projectId: null,
      semanticKey: `meta.auth:${connectionId}:${localDateOf(now, "UTC")}`,
      title: "Acesso à Meta perdido",
      body: `${message.slice(0, 300)}. Gere um novo token e reconecte em Integrações → Meta.`,
      link: "/integracoes/meta",
      data: { connection_id: connectionId },
    }, now);
  });
  return { status: "auth_failed" as const };
}
