import type { PoolClient } from "@tracker/db";
import { formatMoney } from "@tracker/domain";
import { notify } from "./notifications";

/** Status da conta de anúncios (campo account_status da Marketing API). */
const META_ACCOUNT_STATUS: Record<number, string> = {
  2: "desativada",
  3: "com pagamento pendente",
  7: "em análise de risco",
  8: "com liquidação pendente",
  9: "em período de carência",
  100: "com encerramento pendente",
  101: "encerrada",
};

/**
 * Monitores periódicos por organização (R34-02), executados pelo ciclo "monitor.tick" do agendador.
 * Cada assunto guarda estado em monitor_state e só notifica na TRANSIÇÃO para problema (sem repetir a cada ciclo);
 * a volta ao normal é registrada e permite um novo alerta futuro. Limiares por organização em
 * organizations.settings.alerts (0 desliga o monitor).
 */

export interface AlertSettings {
  /** Horas sem recebimentos em conexão que vinha recebendo (padrão 24). */
  connection_stale_hours: number;
  /** Recebimentos com falha na última hora para considerar a conexão falhando (padrão 3). */
  connection_failures_per_hour: number;
  /** Minutos de atraso do item pendente mais antigo da fila (padrão 15). */
  queue_delay_minutes: number;
  /** Envios de conversão rejeitados/expirados na última hora por destino (padrão 3). */
  destination_failures_per_hour: number;
  /** Percentual restante do limite de gasto da conta de anúncios para alertar (padrão 10). */
  spend_cap_alert_pct: number;
  /** Intervalo da sincronização automática com a Meta, em minutos (padrão 15). */
  meta_sync_minutes: number;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  connection_stale_hours: 24,
  connection_failures_per_hour: 3,
  queue_delay_minutes: 15,
  destination_failures_per_hour: 3,
  spend_cap_alert_pct: 10,
  meta_sync_minutes: 15,
};

export function alertSettings(raw: unknown): AlertSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = (k: keyof AlertSettings) => {
    const v = Number(r[k]);
    return Number.isFinite(v) && v >= 0 ? v : DEFAULT_ALERT_SETTINGS[k];
  };
  return {
    connection_stale_hours: pick("connection_stale_hours"),
    connection_failures_per_hour: pick("connection_failures_per_hour"),
    queue_delay_minutes: pick("queue_delay_minutes"),
    destination_failures_per_hour: pick("destination_failures_per_hour"),
    spend_cap_alert_pct: pick("spend_cap_alert_pct"),
    meta_sync_minutes: Math.max(5, pick("meta_sync_minutes")),
  };
}

/** Atualiza o estado do assunto; devolve true quando houve transição de "ok" para o estado de problema. */
async function transition(c: PoolClient, orgId: string, subject: string, state: string, now: Date, details: Record<string, unknown> = {}): Promise<boolean> {
  const prev = (await c.query("select state from public.monitor_state where organization_id = $1 and subject = $2 for update", [orgId, subject])).rows[0];
  if (prev?.state === state) return false;
  await c.query(
    `insert into public.monitor_state (organization_id, subject, state, since, details, last_notified_at) values ($1, $2, $3, $4, $5, case when $3 <> 'ok' then $4::timestamptz end)
     on conflict (organization_id, subject) do update set state = excluded.state, since = excluded.since, details = excluded.details,
       last_notified_at = coalesce(excluded.last_notified_at, public.monitor_state.last_notified_at)`,
    [orgId, subject, state, now, JSON.stringify(details)],
  );
  // Primeira observação "ok" não é transição relevante; problema novo (ou mudança de tipo de problema) é.
  return state !== "ok";
}

export async function runMonitors(c: PoolClient, orgId: string, now: Date): Promise<{ alerts: number }> {
  const org = (await c.query("select settings->'alerts' as alerts, is_demo from public.organizations where id = $1", [orgId])).rows[0];
  if (!org || org.is_demo) return { alerts: 0 };
  const s = alertSettings(org.alerts);
  let alerts = 0;
  const stamp = now.toISOString();

  // 1) Conexões de checkout: sem eventos (vinha recebendo nos últimos 7 dias) ou falhando na última hora.
  const conns = (
    await c.query(
      `select pc.id, pc.project_id, pc.name, pc.provider,
              (select max(r.received_at) from public.webhook_receipts r where r.organization_id = pc.organization_id and r.connection_id = pc.id) as last_received,
              (select count(*)::int from public.webhook_receipts r where r.organization_id = pc.organization_id and r.connection_id = pc.id
                 and r.received_at > $2::timestamptz - interval '7 days') as received_7d,
              (select count(*)::int from public.webhook_receipts r where r.organization_id = pc.organization_id and r.connection_id = pc.id
                 and r.received_at > $2::timestamptz - interval '1 hour' and r.status in ('failed', 'dead', 'quarantined')) as failed_1h
         from public.provider_connections pc
        where pc.organization_id = $1 and pc.kind in ('checkout', 'custom') and pc.disabled_at is null and pc.status not in ('revoked', 'disconnected')`,
      [orgId, now],
    )
  ).rows;
  for (const k of conns) {
    let state = "ok";
    let detail = "";
    if (s.connection_failures_per_hour > 0 && k.failed_1h >= s.connection_failures_per_hour) {
      state = "failing";
      detail = `${k.failed_1h} recebimento(s) com falha ou em quarentena na última hora`;
    } else if (s.connection_stale_hours > 0 && k.received_7d > 0 && k.last_received && now.getTime() - new Date(k.last_received).getTime() > s.connection_stale_hours * 3600_000) {
      state = "stale";
      detail = `sem eventos há mais de ${s.connection_stale_hours} h (último em ${new Date(k.last_received).toISOString()})`;
    }
    if (await transition(c, orgId, `connection:${k.id}`, state, now, { detail })) {
      alerts++;
      await notify(c, orgId, {
        kind: "connection.stale",
        projectId: k.project_id,
        semanticKey: `connection.${state}:${k.id}:${stamp}`,
        title: state === "failing" ? `Integração com falhas: ${k.name}` : `Integração sem eventos: ${k.name}`,
        body: `${detail}. Verifique o diagnóstico da conexão.`,
        link: "/diagnostico",
        data: { connection_id: k.id, state },
      }, now);
    }
  }

  // 2) Fila atrasada: item pendente mais antigo além do limite (worker vivo, porém parado/sobrecarregado neste tópico).
  if (s.queue_delay_minutes > 0) {
    const q = (await c.query("select min(available_at) as oldest, count(*)::int as n from public.outbox where organization_id = $1 and status in ('pending', 'enqueued') and topic <> 'monitor.tick'", [orgId])).rows[0];
    const late = q?.oldest && now.getTime() - new Date(q.oldest).getTime() > s.queue_delay_minutes * 60_000;
    if (await transition(c, orgId, "queue", late ? "delayed" : "ok", now, { pending: q?.n ?? 0 })) {
      alerts++;
      await notify(c, orgId, {
        kind: "queue.delayed",
        projectId: null,
        semanticKey: `queue.delayed:${stamp}`,
        title: "Processamento atrasado",
        body: `${q.n} item(ns) aguardando há mais de ${s.queue_delay_minutes} min. Vendas continuam registradas e serão processadas em ordem.`,
        link: "/diagnostico",
        data: { pending: q.n },
      }, now);
    }
  }

  // 3) Destinos de conversão com envios rejeitados/expirados na última hora.
  if (s.destination_failures_per_hour > 0) {
    const dests = (
      await c.query(
        `select d.id, d.project_id, d.name,
                (select count(*)::int from public.destination_deliveries x where x.organization_id = d.organization_id and x.destination_id = d.id
                   and x.status in ('rejected', 'expired') and x.updated_at > $2::timestamptz - interval '1 hour') as failed_1h
           from public.conversion_destinations d where d.organization_id = $1 and d.status in ('test_mode', 'enabled')`,
        [orgId, now],
      )
    ).rows;
    for (const d of dests) {
      const bad = d.failed_1h >= s.destination_failures_per_hour;
      if (await transition(c, orgId, `destination:${d.id}`, bad ? "failing" : "ok", now, { failed_1h: d.failed_1h })) {
        alerts++;
        await notify(c, orgId, {
          kind: "destination.failed",
          projectId: d.project_id,
          semanticKey: `destination.failed:${d.id}:${stamp}`,
          title: `Falhas no envio de conversões: ${d.name}`,
          body: `${d.failed_1h} envio(s) rejeitado(s) ou expirado(s) na última hora. Veja o motivo no diagnóstico do destino.`,
          link: "/pixels",
          data: { destination_id: d.id },
        }, now);
      }
    }
  }

  // 4) Webhooks de saída com entregas na fila de falhas nas últimas 24 h.
  const subs = (
    await c.query(
      `select s.id, s.name, (select count(*)::int from public.webhook_out_deliveries d where d.organization_id = s.organization_id and d.subscription_id = s.id
                 and d.status = 'dead' and d.created_at > $2::timestamptz - interval '24 hours') as dead_24h
         from public.webhook_subscriptions s where s.organization_id = $1 and s.status = 'active'`,
      [orgId, now],
    )
  ).rows;
  for (const w of subs) {
    if (await transition(c, orgId, `webhook_sub:${w.id}`, w.dead_24h > 0 ? "failing" : "ok", now, { dead_24h: w.dead_24h })) {
      alerts++;
      await notify(c, orgId, {
        kind: "webhook_out.failed",
        projectId: null,
        semanticKey: `webhook_out.failed:${w.id}:${stamp}`,
        title: `Webhook de saída com falhas: ${w.name}`,
        body: `${w.dead_24h} entrega(s) foram para a fila de falhas nas últimas 24 h. Reenvie após corrigir o destino.`,
        link: "/api-webhooks",
        data: { subscription_id: w.id },
      }, now);
    }
  }
  // 5) Meta: sincronização periódica e alertas das contas de anúncios.
  const metaConns = (await c.query("select id, last_success_at from public.provider_connections where organization_id = $1 and provider = 'meta_ads' and status = 'connected'", [orgId])).rows;
  for (const mc of metaConns) {
    if (!mc.last_success_at || now.getTime() - new Date(mc.last_success_at).getTime() >= s.meta_sync_minutes * 60_000) {
      await c.query("insert into public.outbox (organization_id, topic, payload, dedup_key, priority) values ($1, 'meta.sync', $2, $3, 6) on conflict do nothing", [
        orgId, JSON.stringify({ connection_id: mc.id }), `meta-sync:${mc.id}:${Math.floor(now.getTime() / (s.meta_sync_minutes * 60_000))}`,
      ]);
    }
  }
  if (metaConns.length) {
    const accs = (
      await c.query(
        `select id, name, project_id, currency, account_status, spend_cap_minor, amount_spent_minor from public.ad_accounts
          where organization_id = $1 and network = 'meta' and sync_enabled and connection_id = any($2)`,
        [orgId, metaConns.map((m) => m.id)],
      )
    ).rows;
    for (const a of accs) {
      const st = a.account_status === null || a.account_status === 1 ? "ok" : `status_${a.account_status}`;
      if (await transition(c, orgId, `meta_account:${a.id}`, st, now)) {
        alerts++;
        await notify(c, orgId, {
          kind: "ad_account.issue",
          projectId: a.project_id,
          semanticKey: `ad_account.issue:${a.id}:${stamp}`,
          title: `Conta de anúncios ${META_ACCOUNT_STATUS[a.account_status] ?? `com status ${a.account_status}`}: ${a.name}`,
          body: `A Meta informou o status ${a.account_status} para a conta. Verifique no Gerenciador de Anúncios (pagamento, análise ou restrição).`,
          link: "/integracoes/meta",
          data: { ad_account_id: a.id, account_status: a.account_status },
        }, now);
      }
      if (s.spend_cap_alert_pct > 0 && a.spend_cap_minor !== null && a.amount_spent_minor !== null && BigInt(a.spend_cap_minor) > 0n) {
        const cap = BigInt(a.spend_cap_minor);
        const remaining = cap - BigInt(a.amount_spent_minor);
        const low = remaining * 100n < cap * BigInt(Math.round(s.spend_cap_alert_pct));
        if (await transition(c, orgId, `meta_cap:${a.id}`, low ? "low" : "ok", now)) {
          alerts++;
          const fmt = (v: bigint) => formatMoney({ amountMinor: v < 0n ? 0n : v, currency: String(a.currency).trim() });
          await notify(c, orgId, {
            kind: "balance.low",
            projectId: a.project_id,
            semanticKey: `balance.low:${a.id}:${stamp}`,
            title: `Limite de gasto quase no fim: ${a.name}`,
            body: `Restam ${fmt(remaining)} do limite de ${fmt(cap)}. Ao atingir o limite a Meta para de veicular os anúncios da conta.`,
            link: "/integracoes/meta",
            data: { ad_account_id: a.id },
          }, now);
        }
      }
    }
  }

  // Retenção do Gestor IA (R27-08): conversas e auditoria expiradas são removidas.
  await c.query("delete from public.ai_tool_calls where organization_id = $1 and retention_until < $2", [orgId, now]);
  await c.query("delete from public.ai_conversations where organization_id = $1 and retention_until < $2", [orgId, now]);
  return { alerts };
}

/**
 * Agendador: enfileira um "monitor.tick" por organização e janela de tempo. A chave de deduplicação da outbox
 * garante um único ciclo por janela mesmo com várias réplicas do worker.
 */
export async function scheduleTicks(c: PoolClient, orgIds: string[], now: Date, windowMs = 5 * 60_000): Promise<number> {
  const bucket = Math.floor(now.getTime() / windowMs);
  let n = 0;
  for (const id of orgIds) {
    await c.query("select set_config('app.org_id', $1, true)", [id]);
    const r = await c.query(
      "insert into public.outbox (organization_id, topic, payload, dedup_key, priority, max_attempts) values ($1, 'monitor.tick', '{}', $2, 9, 2) on conflict do nothing returning id",
      [id, `tick:${bucket}`],
    );
    n += r.rowCount ?? 0;
  }
  return n;
}
