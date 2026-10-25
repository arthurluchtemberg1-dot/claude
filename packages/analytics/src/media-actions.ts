import { randomUUID } from "node:crypto";
import type { PoolClient } from "@tracker/db";
import { formatMoney, parseDecimalToMinor } from "@tracker/domain";

/**
 * Alterações de mídia na Meta (R25): pausar, ativar, ajustar orçamento diário, renomear e duplicar.
 * Planejamento compartilhado pelo painel (pessoa) e pelo motor de regras (regra): valida estado e permissões no
 * servidor, calcula o novo orçamento com travas (mínimo da conta, variação máxima, teto), registra o "antes" e
 * enfileira a execução (meta.action). Duplicações nascem PAUSADAS (R25-10).
 */

export type MediaAction = "pause" | "activate" | "budget" | "rename" | "duplicate";
export type MediaLevel = "campaign" | "adset" | "ad";

export interface WritesState {
  enabled: boolean;
  reasons: string[];
  connectionId: string | null;
}

/** Ações de gestão só com: conexão ativa com ads_management + liberação do proprietário + envio externo no servidor. */
export async function mediaWritesState(c: PoolClient, orgId: string, allowExternal: boolean): Promise<WritesState> {
  const reasons: string[] = [];
  const conn = (
    await c.query("select id, status, config from public.provider_connections where organization_id = $1 and provider = 'meta_ads' and status <> 'revoked' order by created_at desc limit 1", [orgId])
  ).rows[0];
  if (!conn) reasons.push("Meta não conectada");
  else {
    if (conn.status !== "connected") reasons.push("Conexão com a Meta precisa ser refeita (token inválido ou expirado)");
    if (!((conn.config?.permissions as string[] | undefined) ?? []).includes("ads_management")) reasons.push("O token não tem a permissão ads_management");
  }
  const s = (await c.query("select settings->'media' as m from public.organizations where id = $1", [orgId])).rows[0]?.m;
  if (!s?.media_writes) reasons.push("Ações de gestão desligadas nesta organização");
  if (!allowExternal) reasons.push("Chamadas externas desligadas no servidor (ALLOW_EXTERNAL_DELIVERY=false)");
  return { enabled: reasons.length === 0, reasons, connectionId: conn?.id ?? null };
}

export interface PlanInput {
  action: MediaAction;
  level: MediaLevel;
  entityId: string;
  /** Orçamento: "absolute" em unidade da moeda ("150.00") ou "percent" ("-20", "15"). */
  budget?: { mode: "absolute" | "percent"; value: string; maxChangePct?: number | null; ceiling?: string | null };
  name?: string;
  actor: { type: "user" | "rule" | "ai"; id: string | null; ruleId?: string | null };
  /** Chave de idempotência (pedido do painel ou janela da regra). */
  idempotencyKey?: string;
  projectIds?: string[] | null;
}

export type PlanResult = { ok: true; changeId: string; summary: string; duplicate: boolean } | { ok: false; error: string; noop?: boolean };

export async function planMediaChange(c: PoolClient, orgId: string, writes: WritesState, p: PlanInput): Promise<PlanResult> {
  if (!writes.enabled) return { ok: false, error: `Ação não executada: ${writes.reasons.join("; ")}` };
  // Pedido repetido (mesma chave): devolve o registro existente antes de reavaliar o estado, que já pode ter mudado.
  if (p.idempotencyKey) {
    const prior = (await c.query("select id from public.media_changes where organization_id = $1 and idempotency_key = $2", [orgId, p.idempotencyKey])).rows[0];
    if (prior) return { ok: true, changeId: prior.id, summary: "Pedido já registrado", duplicate: true };
  }
  const e = (
    await c.query(
      `select e.ad_account_id, e.name, e.status, e.effective_status, e.daily_budget_minor, e.lifetime_budget_minor, a.currency, a.min_daily_budget_minor, a.project_id, a.connection_id, a.name as account_name
         from public.ad_entities e join public.ad_accounts a on a.organization_id = e.organization_id and a.id = e.ad_account_id
        where e.organization_id = $1 and e.level = $2 and e.external_id = $3 and a.network = 'meta'`,
      [orgId, p.level, p.entityId],
    )
  ).rows[0];
  if (!e) return { ok: false, error: "Entidade não encontrada nas contas sincronizadas" };
  if (e.connection_id !== writes.connectionId) return { ok: false, error: "A conta desta entidade não pertence à conexão Meta ativa" };
  if (p.projectIds && e.project_id && !p.projectIds.includes(e.project_id)) return { ok: false, error: "Entidade fora dos projetos permitidos" };
  if (e.status === "DELETED" || e.status === "ARCHIVED") return { ok: false, error: `Entidade ${e.status === "DELETED" ? "excluída" : "arquivada"} na Meta` };
  const currency = String(e.currency).trim();
  const before = { status: e.status, daily_budget_minor: e.daily_budget_minor === null ? null : String(e.daily_budget_minor), name: e.name };
  let requested: Record<string, unknown>;
  let summary: string;
  switch (p.action) {
    case "pause":
      if (e.status === "PAUSED") return { ok: false, error: "Já está pausada", noop: true };
      requested = { status: "PAUSED" };
      summary = "Pausar";
      break;
    case "activate":
      if (e.status === "ACTIVE") return { ok: false, error: "Já está ativa", noop: true };
      requested = { status: "ACTIVE" };
      summary = "Ativar";
      break;
    case "rename": {
      const name = (p.name ?? "").trim();
      if (!name || name.length > 400) return { ok: false, error: "Nome inválido" };
      requested = { name };
      summary = `Renomear para "${name}"`;
      break;
    }
    case "duplicate":
      requested = { status_option: "PAUSED", deep_copy: p.level !== "ad" };
      summary = "Duplicar (cópia pausada)";
      break;
    case "budget": {
      if (p.level === "ad") return { ok: false, error: "Anúncio não tem orçamento (ajuste o conjunto ou a campanha)" };
      if (e.daily_budget_minor === null) return { ok: false, error: e.lifetime_budget_minor !== null ? "Orçamento vitalício não é ajustado por aqui" : `O orçamento diário não está neste nível (${p.level === "campaign" ? "está nos conjuntos" : "está na campanha"})` };
      if (!p.budget) return { ok: false, error: "Informe o novo orçamento" };
      const cur = BigInt(e.daily_budget_minor);
      let next: bigint;
      try {
        if (p.budget.mode === "absolute") next = parseDecimalToMinor(p.budget.value, currency);
        else {
          const pct = Number(p.budget.value);
          if (!Number.isFinite(pct) || pct <= -100 || pct > 1000) return { ok: false, error: "Percentual inválido" };
          // Arredondamento para a menor unidade (meio para longe de zero) sobre o valor exato em centésimos de %.
          const bp = BigInt(Math.round(pct * 100));
          next = (cur * (10000n + bp) + 5000n) / 10000n;
        }
      } catch {
        return { ok: false, error: "Valor de orçamento inválido" };
      }
      if (p.budget.maxChangePct !== undefined && p.budget.maxChangePct !== null && cur > 0n) {
        const maxDelta = (cur * BigInt(Math.round(p.budget.maxChangePct * 100))) / 10000n;
        if (next > cur + maxDelta) next = cur + maxDelta;
        if (next < cur - maxDelta) next = cur - maxDelta;
      }
      if (p.budget.ceiling) {
        const ceil = parseDecimalToMinor(p.budget.ceiling, currency);
        if (next > ceil) next = ceil;
      }
      const min = e.min_daily_budget_minor === null ? 100n : BigInt(e.min_daily_budget_minor);
      if (next < min) return { ok: false, error: `Abaixo do orçamento diário mínimo da conta (${formatMoney({ amountMinor: min, currency })})` };
      if (next === cur) return { ok: false, error: "O orçamento resultante é igual ao atual (limites da regra)", noop: true };
      requested = { daily_budget: next.toString() };
      summary = `Orçamento diário ${formatMoney({ amountMinor: cur, currency })} → ${formatMoney({ amountMinor: next, currency })}`;
      break;
    }
  }
  const key = p.idempotencyKey ?? randomUUID();
  const ins = await c.query(
    `insert into public.media_changes (organization_id, ad_account_id, level, entity_id, entity_name, action, before, requested, actor_type, actor_id, rule_id, idempotency_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) on conflict (organization_id, idempotency_key) do nothing returning id`,
    [orgId, e.ad_account_id, p.level, p.entityId, e.name, p.action, JSON.stringify(before), JSON.stringify(requested), p.actor.type, p.actor.id, p.actor.ruleId ?? null, key],
  );
  if (!ins.rows[0]) {
    const existing = (await c.query("select id from public.media_changes where organization_id = $1 and idempotency_key = $2", [orgId, key])).rows[0];
    return { ok: true, changeId: existing.id, summary, duplicate: true };
  }
  const changeId = ins.rows[0].id as string;
  await c.query("insert into public.outbox (organization_id, topic, payload, dedup_key, priority, max_attempts) values ($1, 'meta.action', $2, $3, 2, 5)", [orgId, JSON.stringify({ change_id: changeId }), `meta-action:${changeId}:1`]);
  return { ok: true, changeId, summary, duplicate: false };
}
