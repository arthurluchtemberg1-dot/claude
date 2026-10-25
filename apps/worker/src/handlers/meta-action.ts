import { createMetaGraphClient, MetaGraphError } from "@tracker/connectors";
import type { PoolClient } from "@tracker/db";
import type { MetaSyncDeps } from "./meta-sync";
import { notify } from "./notifications";

/**
 * Execução de alterações de mídia na Meta (R25-02..R25-11), fora de transação:
 * 1. Reconciliação: se uma tentativa anterior ficou sem resposta ("unknown"), lê a entidade antes de repetir —
 *    se o efeito já ocorreu, conclui sem nova escrita (sem pausar duas vezes nem dobrar orçamento).
 * 2. Escrita (POST no nó ou /copies) e confirmação lendo a entidade de volta; o estado local é atualizado.
 * 3. Falhas: permissão/inválida → falha definitiva com o motivo; limite/rede → nova tentativa com espera.
 */

type RunTx = <T>(fn: (c: PoolClient) => Promise<T>) => Promise<T>;

const MAX_ATTEMPTS = 4;

function applied(level: string, requested: Record<string, unknown>, ent: { status?: string; daily_budget?: string; name?: string }) {
  if (requested.status !== undefined) return ent.status === requested.status;
  if (requested.daily_budget !== undefined) return ent.daily_budget === String(requested.daily_budget);
  if (requested.name !== undefined) return ent.name === requested.name;
  void level;
  return false;
}

export async function runMetaAction(runTx: RunTx, deps: MetaSyncDeps & { allowExternal: boolean }, orgId: string, changeId: string, now: Date) {
  const prep = await runTx(async (c) => {
    const ch = (
      await c.query(
        `select m.*, a.connection_id, a.external_account_id from public.media_changes m join public.ad_accounts a on a.organization_id = m.organization_id and a.id = m.ad_account_id
          where m.organization_id = $1 and m.id = $2 for update of m`,
        [orgId, changeId],
      )
    ).rows[0];
    if (!ch || !["pending", "unknown"].includes(ch.status)) return null;
    if (!deps.allowExternal) {
      await c.query("update public.media_changes set status = 'skipped', error = 'Chamadas externas desligadas no servidor', completed_at = $2 where id = $1", [changeId, now]);
      return null;
    }
    const token = await deps.loadToken(c, orgId, ch.connection_id);
    await c.query("update public.media_changes set status = 'running', attempts = attempts + 1 where id = $1", [changeId]);
    return { ch, token, wasUnknown: ch.status === "unknown" };
  });
  if (!prep) return { status: "skipped" as const };
  const { ch } = prep;
  const finish = (status: "succeeded" | "failed" | "unknown" | "pending", fields: { after?: unknown; error?: string | null } = {}, retryAt?: Date) =>
    runTx(async (c) => {
      await c.query("update public.media_changes set status = $2, after = coalesce($3, after), error = $4, completed_at = case when $2 in ('succeeded', 'failed') then $5::timestamptz else null end where id = $1", [
        changeId, status, fields.after === undefined ? null : JSON.stringify(fields.after), fields.error ?? null, now,
      ]);
      if (retryAt && ch.attempts + 1 < MAX_ATTEMPTS) {
        await c.query("insert into public.outbox (organization_id, topic, payload, dedup_key, priority, available_at) values ($1, 'meta.action', $2, $3, 2, $4) on conflict do nothing", [
          orgId, JSON.stringify({ change_id: changeId }), `meta-action:${changeId}:${ch.attempts + 2}`, retryAt,
        ]);
      } else if (retryAt) {
        await c.query("update public.media_changes set status = 'failed', error = coalesce(error, '') || ' (tentativas esgotadas)', completed_at = $2 where id = $1", [changeId, now]);
      }
      if (status === "failed" && ch.actor_type === "user" && ch.actor_id) {
        await notify(c, orgId, {
          kind: "rule.triggered",
          projectId: null,
          semanticKey: `media.failed:${changeId}`,
          title: `Alteração não aplicada: ${ch.entity_name ?? ch.entity_id}`,
          body: (fields.error ?? "Falha").slice(0, 400),
          link: "/campanhas",
          userIds: [ch.actor_id],
        }, now);
      }
    });
  if (!prep.token) return finish("failed", { error: "Token da Meta ausente; reconecte" });
  const g = createMetaGraphClient({ accessToken: prep.token, ...deps.graph });
  const requested = ch.requested as Record<string, unknown>;
  try {
    if (ch.action !== "duplicate") {
      if (prep.wasUnknown) {
        const cur = await g.entity(ch.entity_id, ch.level);
        if (applied(ch.level, requested, cur)) {
          await saveEntity(runTx, orgId, ch, cur, now);
          return finish("succeeded", { after: { status: cur.status, daily_budget: cur.daily_budget ?? null, name: cur.name, reconciled: true } });
        }
      }
      await g.update(ch.entity_id, requested as Record<string, string | number>);
      const cur = await g.entity(ch.entity_id, ch.level);
      await saveEntity(runTx, orgId, ch, cur, now);
      if (!applied(ch.level, requested, cur)) return finish("failed", { after: cur, error: "A Meta aceitou o pedido mas a leitura posterior não mostra a alteração" });
      return finish("succeeded", { after: { status: cur.status, daily_budget: cur.daily_budget ?? null, name: cur.name } });
    }
    // Duplicação: não reconciliável por leitura; uma "unknown" não é repetida automaticamente (evita cópias em dobro).
    if (prep.wasUnknown) return finish("failed", { error: "Duplicação sem confirmação: confira no Gerenciador de Anúncios antes de repetir" });
    const res = await g.copy(ch.entity_id, requested);
    const newId = String(res.copied_campaign_id ?? res.copied_adset_id ?? res.copied_ad_id ?? res.id ?? "");
    await runTx((c) =>
      c.query("insert into public.outbox (organization_id, topic, payload, dedup_key, priority) values ($1, 'meta.sync', $2, $3, 3) on conflict do nothing", [
        orgId, JSON.stringify({ connection_id: ch.connection_id }), `meta-sync:${ch.connection_id}:after-copy:${changeId}`,
      ]),
    );
    return finish("succeeded", { after: { copy_id: newId || null, status: "PAUSED" } });
  } catch (err) {
    const e = err instanceof MetaGraphError ? err : new MetaGraphError((err as Error).message, "network", null, null, null);
    if (e.kind === "unknown_outcome") return finish("unknown", { error: e.message }, new Date(now.getTime() + 30_000));
    if (e.retryable) return finish("pending", { error: e.message }, new Date(now.getTime() + (e.kind === "rate_limit" ? 300_000 : 60_000)));
    if (e.kind === "auth") await runTx((c) => c.query("update public.provider_connections set status = 'token_expired', last_error = $2, last_error_at = $3 where id = $1", [ch.connection_id, e.message.slice(0, 500), now]));
    return finish("failed", { error: e.message });
  }
}

async function saveEntity(runTx: RunTx, orgId: string, ch: { ad_account_id: string; level: string; entity_id: string }, cur: { status?: string; effective_status?: string; daily_budget?: string; name?: string }, now: Date) {
  await runTx((c) =>
    c.query(
      `update public.ad_entities set status = coalesce($5, status), effective_status = coalesce($6, effective_status),
         daily_budget_minor = case when $7::text ~ '^[0-9]+$' then $7::bigint else daily_budget_minor end, name = coalesce($8, name), synced_at = $9
       where organization_id = $1 and ad_account_id = $2 and level = $3 and external_id = $4`,
      [orgId, ch.ad_account_id, ch.level, ch.entity_id, cur.status ?? null, cur.effective_status ?? null, cur.daily_budget ?? null, cur.name ?? null, now],
    ),
  );
}
