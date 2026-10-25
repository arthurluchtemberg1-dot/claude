import type { EmailSender, PushSender } from "@tracker/connectors";
import type { PoolClient } from "@tracker/db";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_KINDS,
  channelEnabled,
  inQuietHours,
  isRole,
  roleHas,
  saleNotificationText,
  type NotificationKind,
  type NotificationPreferences,
  type SaleFact,
} from "@tracker/domain";

/**
 * Central de notificações (R34): criação na MESMA transação do fato (venda, estorno, falha) e entrega externa
 * (e-mail, Web Push) como efeito derivado via outbox — a falha de um canal nunca desfaz nem atrasa o registro
 * da venda (R34-04). Deduplicação por fato semântico e destinatário (R34-03).
 */

export interface NotificationDeps {
  /** Envio externo habilitado no ambiente (ALLOW_EXTERNAL_DELIVERY). */
  allowExternal: boolean;
  email: EmailSender | null;
  /** null = Web Push não configurado (sem chaves VAPID). */
  push: PushSender | null;
  appUrl: string;
  maxAttempts?: number;
}

export interface NotifyInput {
  kind: NotificationKind;
  projectId: string | null;
  semanticKey: string;
  title: string;
  body: string;
  link: string | null;
  data?: Record<string, unknown>;
  isTest?: boolean;
  /** Versão sem valores para push/e-mail de quem ativou "ocultar valores". */
  redacted?: { title: string; body: string };
  /** Destinatários explícitos (ex.: teste manual); sem isso, membros com permissão e acesso ao projeto. */
  userIds?: string[];
}

function prefsFromRow(r: Record<string, unknown> | undefined): NotificationPreferences {
  if (!r || r.kinds === null || r.kinds === undefined) return DEFAULT_NOTIFICATION_PREFERENCES;
  return {
    kinds: (r.kinds as NotificationPreferences["kinds"]) ?? {},
    projectIds: (r.project_ids as string[]) ?? [],
    quietStart: (r.quiet_start as string | null) ?? null,
    quietEnd: (r.quiet_end as string | null) ?? null,
    soundEnabled: Boolean(r.sound_enabled),
    soundVolume: Number(r.sound_volume ?? 60),
    hideAmounts: Boolean(r.hide_amounts),
  };
}

export async function notify(c: PoolClient, orgId: string, n: NotifyInput, now: Date): Promise<{ created: number; deliveries: number }> {
  const def = NOTIFICATION_KINDS[n.kind];
  const org = (await c.query("select timezone from public.organizations where id = $1", [orgId])).rows[0];
  if (!org) return { created: 0, deliveries: 0 };
  const members = (
    await c.query(
      `select m.user_id, m.role, p.kinds, p.project_ids, p.quiet_start, p.quiet_end, p.sound_enabled, p.sound_volume, p.hide_amounts,
              ($2::uuid is null or m.role in ('owner', 'admin')
                or not exists (select 1 from public.project_memberships pm where pm.organization_id = m.organization_id and pm.user_id = m.user_id)
                or exists (select 1 from public.project_memberships pm where pm.organization_id = m.organization_id and pm.user_id = m.user_id and pm.project_id = $2)) as has_access
         from public.memberships m
         left join public.notification_preferences p on p.organization_id = m.organization_id and p.user_id = m.user_id
        where m.organization_id = $1 and m.status = 'active' and ($3::uuid[] is null or m.user_id = any($3))`,
      [orgId, n.projectId, n.userIds ?? null],
    )
  ).rows;
  let created = 0;
  let deliveries = 0;
  for (const m of members) {
    if (!isRole(m.role) || !roleHas(m.role, def.permission) || !m.has_access) continue;
    const prefs = prefsFromRow(m.kinds === null ? undefined : m);
    if (n.projectId && prefs.projectIds.length && !prefs.projectIds.includes(n.projectId) && n.kind !== "system.test") continue;
    const inApp = channelEnabled(prefs, n.kind, "in_app");
    const email = channelEnabled(prefs, n.kind, "email");
    const push = channelEnabled(prefs, n.kind, "push");
    if (!inApp && !email && !push) continue;
    const data = { ...(n.data ?? {}), ...(n.redacted ? { redacted: n.redacted } : {}) };
    const ins = await c.query(
      `insert into public.notifications (organization_id, user_id, project_id, kind, severity, title, body, link, semantic_key, data, is_test, created_at, read_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (organization_id, user_id, semantic_key) do nothing returning id`,
      // Painel desligado para o tipo: registro existe (para entrega e histórico) mas já nasce lido (sem contador).
      [orgId, m.user_id, n.projectId, n.kind, def.severity, n.title.slice(0, 200), n.body.slice(0, 500), n.link, n.semanticKey.slice(0, 300), JSON.stringify(data), n.isTest ?? false, now, inApp ? null : now],
    );
    const id = ins.rows[0]?.id as string | undefined;
    if (!id) continue;
    created++;
    // Horário silencioso: só o registro no painel (sem e-mail/push), exceto o teste manual.
    if (n.kind !== "system.test" && inQuietHours(now, org.timezone, prefs.quietStart, prefs.quietEnd)) continue;
    if (email) {
      const d = await c.query(
        "insert into public.notification_deliveries (organization_id, notification_id, channel) values ($1, $2, 'email') on conflict do nothing returning id",
        [orgId, id],
      );
      if (d.rows[0]) {
        await enqueueDelivery(c, orgId, d.rows[0].id, null);
        deliveries++;
      }
    }
    if (push) {
      const subs = (await c.query("select id from public.push_subscriptions where organization_id = $1 and user_id = $2 and disabled_at is null", [orgId, m.user_id])).rows;
      for (const s of subs) {
        const d = await c.query(
          "insert into public.notification_deliveries (organization_id, notification_id, channel, push_subscription_id) values ($1, $2, 'push', $3) on conflict do nothing returning id",
          [orgId, id, s.id],
        );
        if (d.rows[0]) {
          await enqueueDelivery(c, orgId, d.rows[0].id, null);
          deliveries++;
        }
      }
    }
  }
  return { created, deliveries };
}

/** Entrega imediata (at = null: disponível já, pelo relógio do banco) ou reagendada após falha. */
async function enqueueDelivery(c: PoolClient, orgId: string, deliveryId: string, at: Date | null, attempt = 1) {
  await c.query(
    "insert into public.outbox (organization_id, topic, payload, dedup_key, priority, available_at) values ($1, 'notifications.deliver', $2, $3, 5, coalesce($4::timestamptz, now())) on conflict do nothing",
    [orgId, JSON.stringify({ delivery_id: deliveryId }), `ntd:${deliveryId}:${attempt}`, at],
  );
}

const ORIGIN_NETWORK: Record<string, string> = { meta: "Meta", google: "Google", tiktok: "TikTok", kwai: "Kwai", pinterest: "Pinterest", taboola: "Taboola" };

/** Origem legível da atribuição atual (dados não pessoais). Nomes "Nome|ID" de UTMs mostram só o nome. */
async function originLabel(c: PoolClient, orgId: string, orderId: string): Promise<string | null> {
  const a = (
    await c.query(
      `select a.category, a.network, a.utm_source, a.utm_campaign, a.campaign_id,
              (select n.name from public.ad_entity_names n where n.organization_id = a.organization_id and n.level = 'campaign' and n.external_id = a.campaign_id
                order by n.last_seen_date desc nulls last limit 1) as campaign_name
         from public.order_attributions a where a.organization_id = $1 and a.order_id = $2 and a.is_current and a.policy_key = 'default'`,
      [orgId, orderId],
    )
  ).rows[0];
  if (!a) return null;
  if (a.category === "unattributed") return "sem origem identificada";
  const net = (a.network && ORIGIN_NETWORK[a.network]) ?? a.utm_source ?? (a.category === "direct" ? "Direto" : null);
  const camp = a.campaign_name ?? (a.utm_campaign ? String(a.utm_campaign).split("|")[0] : null);
  return [net, camp].filter(Boolean).join(" · ") || null;
}

/** Notificação de venda/estorno a partir do pedido e da transação ou lançamento (sem dados do comprador). */
export async function notifySale(
  c: PoolClient,
  orgId: string,
  input: { kind: SaleFact["kind"]; orderId: string; transactionKey?: string; ledgerKey?: string },
  now: Date,
) {
  const o = (
    await c.query(
      `select o.id, o.project_id, o.parent_order_id, o.is_test, o.is_demo, o.currency, p.name as project_name,
              (select coalesce(pr.name, i.name) from public.order_items i left join public.products pr on pr.organization_id = i.organization_id and pr.id = i.product_id
                where i.organization_id = o.organization_id and i.order_id = o.id order by i.item_key limit 1) as product_name
         from public.orders o join public.projects p on p.organization_id = o.organization_id and p.id = o.project_id
        where o.organization_id = $1 and o.id = $2`,
      [orgId, input.orderId],
    )
  ).rows[0];
  if (!o || o.is_demo) return;
  let amount: bigint | null = null;
  let currency = o.currency as string;
  let saleType: SaleFact["saleType"] = o.parent_order_id ? "upsell" : "first";
  let partial = false;
  if (input.kind === "sale.approved" && input.transactionKey) {
    const tx = (await c.query("select kind, amount_minor, currency from public.payment_transactions where organization_id = $1 and order_id = $2 and transaction_key = $3", [orgId, o.id, input.transactionKey])).rows[0];
    if (!tx || tx.amount_minor === null) return;
    amount = BigInt(tx.amount_minor);
    currency = tx.currency;
    if (tx.kind === "renewal") saleType = "renewal";
    else if (tx.kind === "upsell") saleType = "upsell";
  } else if (input.ledgerKey) {
    const e = (await c.query("select amount_minor, currency, transaction_key from public.financial_entries where organization_id = $1 and order_id = $2 and semantic_key = $3", [orgId, o.id, input.ledgerKey])).rows[0];
    if (!e) return;
    amount = BigInt(e.amount_minor) < 0n ? -BigInt(e.amount_minor) : BigInt(e.amount_minor);
    currency = e.currency;
    if (input.kind === "sale.refunded") {
      const tx = (await c.query("select amount_minor from public.payment_transactions where organization_id = $1 and order_id = $2 and transaction_key = $3", [orgId, o.id, e.transaction_key])).rows[0];
      partial = tx?.amount_minor !== null && tx?.amount_minor !== undefined && amount < BigInt(tx.amount_minor);
    }
  }
  if (amount === null) return;
  const fact: SaleFact = {
    kind: input.kind,
    amountMinor: amount,
    currency,
    productName: o.product_name,
    projectName: o.project_name,
    origin: input.kind === "sale.approved" ? await originLabel(c, orgId, o.id) : null,
    isTest: o.is_test,
    saleType,
    partial,
  };
  const text = saleNotificationText(fact);
  const redacted = saleNotificationText(fact, { hideAmounts: true });
  await notify(
    c,
    orgId,
    {
      kind: input.kind,
      projectId: o.project_id,
      semanticKey: `${input.kind}:${o.id}:${input.transactionKey ?? input.ledgerKey}`,
      title: text.title,
      body: text.body,
      redacted,
      link: `/vendas/${o.id}`,
      data: { order_id: o.id, amount_minor: amount.toString(), currency, sale_type: saleType },
      isTest: o.is_test,
    },
    now,
  );
}

function backoffMs(attempt: number) {
  return Math.min(30_000 * 2 ** (attempt - 1), 30 * 60_000);
}

/** Entrega externa (fora da transação do item): prepara, envia e registra. */
export async function deliverNotification(
  runTx: <T>(fn: (c: PoolClient) => Promise<T>) => Promise<T>,
  deps: NotificationDeps,
  orgId: string,
  deliveryId: string,
  now: Date,
): Promise<{ status: string }> {
  const maxAttempts = deps.maxAttempts ?? 5;
  const prep = await runTx(async (c) => {
    const d = (
      await c.query(
        `select d.id, d.channel, d.status, d.attempts, d.push_subscription_id, n.id as notification_id, n.user_id, n.kind, n.title, n.body, n.link, n.data,
                coalesce(p.hide_amounts, false) as hide_amounts, s.endpoint, s.p256dh, s.auth, s.disabled_at
           from public.notification_deliveries d
           join public.notifications n on n.organization_id = d.organization_id and n.id = d.notification_id
           left join public.notification_preferences p on p.organization_id = n.organization_id and p.user_id = n.user_id
           left join public.push_subscriptions s on s.organization_id = d.organization_id and s.id = d.push_subscription_id
          where d.organization_id = $1 and d.id = $2 for update of d`,
        [orgId, deliveryId],
      )
    ).rows[0];
    if (!d) return { skip: "not_found" };
    if (d.status !== "pending" && d.status !== "retry_scheduled") return { skip: d.status };
    const skip = async (reason: string) => {
      await c.query("update public.notification_deliveries set status = 'skipped', last_error = $2 where id = $1", [deliveryId, reason]);
      return { skip: reason };
    };
    // Membro removido/suspenso depois da criação: não entregar.
    const active = (await c.query("select 1 from public.memberships where organization_id = $1 and user_id = $2 and status = 'active'", [orgId, d.user_id])).rows[0];
    if (!active) return skip("Destinatário não é mais membro ativo");
    if (!deps.allowExternal) return skip("Envio externo desligado neste ambiente (ALLOW_EXTERNAL_DELIVERY=false)");
    let to: string | null = null;
    if (d.channel === "email") {
      if (!deps.email) return skip("E-mail não configurado");
      const u = (await c.query("select email, email_verified_at from iam.users where id = $1", [d.user_id])).rows[0];
      if (!u?.email_verified_at) return skip("E-mail do destinatário não verificado");
      to = u.email;
    } else {
      if (!deps.push) return skip("Web Push não configurado (chaves VAPID ausentes)");
      if (!d.endpoint || d.disabled_at) return skip("Inscrição de push desativada");
    }
    const attempt = d.attempts + 1;
    await c.query("update public.notification_deliveries set attempts = $2 where id = $1", [deliveryId, attempt]);
    const redacted = d.hide_amounts && d.data?.redacted ? (d.data.redacted as { title: string; body: string }) : null;
    return { d, to, attempt, title: redacted?.title ?? d.title, body: redacted?.body ?? d.body };
  });
  if ("skip" in prep) return { status: `skipped` };
  const { d, to, attempt, title, body } = prep;
  let ok = false;
  let expired = false;
  let retryable = true;
  let error: string | null = null;
  let httpStatus: number | null = null;
  if (d.channel === "email") {
    try {
      const link = d.link ? new URL(d.link, deps.appUrl).toString() : deps.appUrl;
      await deps.email!.send({ to: to!, subject: title, text: `${title}\n${body}\n\nAbrir no painel: ${link}\n\nPreferências de notificação: ${new URL("/notificacoes", deps.appUrl).toString()}`, kind: `notification:${d.kind}`, actionUrl: link });
      ok = true;
    } catch (err) {
      error = (err as Error).message;
    }
  } else {
    const r = await deps.push!({ endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth }, { title, body, link: d.link, kind: d.kind, id: d.notification_id, tag: d.kind });
    ok = r.ok;
    httpStatus = r.status;
    if (!r.ok) {
      error = r.error;
      expired = r.expired;
      retryable = r.retryable;
    }
  }
  return runTx(async (c) => {
    let status: string;
    if (ok) status = "sent";
    else if (!retryable || expired || attempt >= maxAttempts) status = "failed";
    else status = "retry_scheduled";
    await c.query("update public.notification_deliveries set status = $2, last_error = $3, last_http_status = $4, sent_at = case when $2 = 'sent' then $5::timestamptz else sent_at end where id = $1", [
      deliveryId, status, error?.slice(0, 500) ?? null, httpStatus, now,
    ]);
    if (d.channel === "push") {
      if (ok) await c.query("update public.push_subscriptions set last_success_at = $2, consecutive_failures = 0, last_error = null where organization_id = $1 and id = $3", [orgId, now, d.push_subscription_id]);
      else
        await c.query(
          `update public.push_subscriptions set last_failure_at = $2, last_error = $3, consecutive_failures = consecutive_failures + 1,
             disabled_at = case when $4 or consecutive_failures + 1 >= 10 then $2 else disabled_at end,
             disabled_reason = case when $4 then 'Inscrição expirada ou recusada pelo serviço de push' when consecutive_failures + 1 >= 10 then 'Falhas consecutivas' else disabled_reason end
           where organization_id = $1 and id = $5`,
          [orgId, now, error?.slice(0, 500), expired, d.push_subscription_id],
        );
    }
    if (status === "retry_scheduled") await enqueueDelivery(c, orgId, deliveryId, new Date(now.getTime() + backoffMs(attempt)), attempt + 1);
    return { status };
  });
}
