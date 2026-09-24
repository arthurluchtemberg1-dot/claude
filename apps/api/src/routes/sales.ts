import { randomUUID } from "node:crypto";
import { maskEmail, maskName, maskPhone } from "@tracker/domain";
import { inSequence, withTx } from "@tracker/db";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../context";
import { forbidden, notFound } from "../lib/errors";
import { audit, jsonSafe, orgTx } from "../lib/org-tx";
import { assertPermission, assertProjectAccess } from "../services/auth";

/**
 * Vendas: lista paginada no servidor por cursor, detalhe com linha do tempo e evidências (R24-01, R24-02),
 * dados pessoais mascarados sem `pii.read` e acesso auditado quando revelados. Venda manual auditada (R24-05).
 */

const listQuery = z.object({
  project_id: z.string().uuid().optional(),
  status: z.enum(["pending", "failed", "approved", "partially_reversed", "fully_reversed", "reversal_pending_reconciliation"]).optional(),
  attribution: z.enum(["paid", "organic", "direct", "recovery", "unattributed"]).optional(),
  q: z.string().trim().max(200).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  include_test: z.coerce.boolean().default(false),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function encodeCursor(ts: Date, id: string) {
  return Buffer.from(`${ts.toISOString()}|${id}`).toString("base64url");
}
function decodeCursor(c: string): { ts: Date; id: string } | null {
  const [ts, id] = Buffer.from(c, "base64url").toString().split("|");
  if (!ts || !id || Number.isNaN(Date.parse(ts)) || !/^[0-9a-f-]{36}$/.test(id)) return null;
  return { ts: new Date(ts), id };
}

export const salesRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.get("/orders", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      const q = listQuery.parse(req.query);
      if (q.project_id) assertProjectAccess(req.org!, q.project_id);
      const cursor = q.cursor ? decodeCursor(q.cursor) : null;
      return orgTx(deps, req, async (c, { org }) => {
        const canPii = org.permissions.has("pii.read");
        const r = await c.query(
          `select o.id, o.project_id, o.provider, o.external_order_id, o.currency, o.financial_status, o.approved_minor, o.reversed_minor,
                  o.first_approved_at, o.first_received_at, o.payment_method, o.is_test, coalesce(o.first_approved_at, o.first_received_at) as sort_ts,
                  a.category as attribution_category, a.network, a.campaign_id, a.utm_source, a.utm_campaign, a.unattributed_reason, a.quality as attribution_quality,
                  (select string_agg(coalesce(i.name, i.external_product_id), ', ' order by i.item_key) from public.order_items i where i.order_id = o.id) as products,
                  ct.email, ct.name
             from public.orders o
             left join public.order_attributions a on a.order_id = o.id and a.is_current and a.policy_key = 'default'
             left join public.order_contacts ct on ct.order_id = o.id
            where ($1::uuid is null or o.project_id = $1)
              and ($2::uuid[] is null or o.project_id = any($2))
              and ($3::text is null or o.financial_status = $3)
              and ($4::text is null or coalesce(a.category, 'unattributed') = $4)
              and ($5::text is null or o.external_order_id ilike '%' || $5 || '%' or ($9 and ct.email ilike '%' || $5 || '%'))
              and ($6::timestamptz is null or coalesce(o.first_approved_at, o.first_received_at) >= $6)
              and ($7::timestamptz is null or coalesce(o.first_approved_at, o.first_received_at) < $7)
              and (o.is_test = false or $8)
              and ($10::timestamptz is null or (coalesce(o.first_approved_at, o.first_received_at), o.id) < ($10, $11::uuid))
            order by sort_ts desc, o.id desc
            limit $12`,
          [q.project_id ?? null, org.projectIds, q.status ?? null, q.attribution ?? null, q.q ?? null, q.from ?? null, q.to ?? null, q.include_test, canPii, cursor?.ts ?? null, cursor?.id ?? null, q.limit + 1],
        );
        const rows = r.rows.slice(0, q.limit);
        const last = rows[rows.length - 1];
        return jsonSafe({
          orders: rows.map(({ sort_ts: _s, email, name, ...o }) => ({
            ...o,
            customer: { email: canPii ? email : maskEmail(email), name: canPii ? name : maskName(name) },
          })),
          next_cursor: r.rows.length > q.limit && last ? encodeCursor(last.sort_ts, last.id) : null,
          pii_masked: !canPii,
        });
      });
    });

    app.get("/orders/:id", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { reveal } = z.object({ reveal: z.coerce.boolean().default(false) }).parse(req.query);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const o = (await c.query("select * from public.orders where id = $1", [id])).rows[0];
        if (!o) throw notFound("Pedido não encontrado");
        assertProjectAccess(org, o.project_id);
        const [items, txs, revs, ledger, conflicts, events, attributions, touches, deliveries, contact, receipts, related, settlements, links] = await inSequence([
          () => c.query("select item_key, external_product_id, product_id, name, item_type, unit_amount_minor, quantity, currency from public.order_items where order_id = $1 order by item_key", [id]),
          () => c.query("select transaction_key, kind, status, amount_minor, currency, method, installments, approved_at, status_occurred_at, reversed_net_minor, org_share_minor, fee_minor from public.payment_transactions where order_id = $1 order by status_occurred_at", [id]),
          () => c.query("select reversal_key, kind, transaction_key, semantics, reported_amount_minor, effective_minor, restored_minor, status, occurred_at, related_key from public.reversals where order_id = $1 order by occurred_at", [id]),
          () => c.query("select semantic_key, entry_type, transaction_key, amount_minor, currency, occurred_at, recorded_at, revenue_kind, estimated from public.financial_entries where order_id = $1 order by occurred_at, id", [id]),
          () => c.query("select code, message, transaction_key, reversal_key, created_at, resolved_at from public.order_conflicts where order_id = $1 order by created_at", [id]),
          () => c.query("select n.event_type, n.occurred_at, n.created_at, n.payload, n.receipt_id from public.normalized_events n where n.order_id = $1 order by n.occurred_at, n.created_at", [id]),
          () => c.query("select policy_key, policy_version, model, window_days, category, evidence, quality, reason, unattributed_reason, path, credits, network, campaign_id, adset_id, ad_id, utm_source, utm_campaign, computed_at, is_current, recalculation_of from public.order_attributions where order_id = $1 order by computed_at desc", [id]),
          () => c.query("select id, occurred_at, channel, is_paid, network, evidence, utm_source, utm_medium, utm_campaign, utm_content, utm_term, campaign_id, adset_id, ad_id, ids_validated, declared, classification_reason from public.touchpoints where order_id = $1 or visitor_id in (select visitor_id from public.order_visitor_links where order_id = $1) order by occurred_at", [id]),
          () => c.query("select d.id, d.event_name, d.event_id, d.environment, d.status, d.not_eligible_reason, d.attempts, d.last_http_status, d.last_provider_code, d.last_trace_id, d.last_error, d.updated_at, cd.name as destination from public.destination_deliveries d join public.conversion_destinations cd on cd.id = d.destination_id where d.order_id = $1", [id]),
          () => c.query("select email, phone, name, source, retention_until from public.order_contacts where order_id = $1", [id]),
          () => c.query("select r.id, r.received_at, r.source_event_type, r.status, r.status_reason, r.delivery_count, r.dedup_method from public.webhook_receipts r where r.id in (select receipt_id from public.normalized_events where order_id = $1) order by r.received_at", [id]),
          // Pedido original e upsells/downsells vinculados pela origem (T16).
          () => c.query(
            `select id, external_order_id, financial_status, approved_minor, currency, first_approved_at, case when id = $2 then 'parent' else 'child' end as relation
               from public.orders where id = $2 or parent_order_id = $1 order by first_approved_at nulls last`,
            [id, o.parent_order_id],
          ),
          () => c.query("select settlement_key, stage, transaction_key, installment_number, installment_count, gross_minor, fee_minor, net_minor, currency, anticipated, expected_at, occurred_at from public.settlements where order_id = $1 order by coalesce(expected_at, occurred_at), installment_number nulls last, stage", [id]),
          () => c.query("select visitor_id, evidence, inherited_from_order_id, linked_at from public.order_visitor_links where order_id = $1", [id]),
        ] as const);
        let customer = null;
        const ct = contact.rows[0];
        if (ct) {
          const canReveal = reveal && org.permissions.has("pii.read");
          if (reveal && !canReveal) throw forbidden("permission_denied", "Permissão necessária: pii.read");
          if (canReveal) await audit(c, { organizationId: org.id, actorId: auth.userId, action: "pii.viewed", targetType: "order", targetId: id, requestId: req.id });
          customer = canReveal
            ? { email: ct.email, phone: ct.phone, name: ct.name, source: ct.source, retention_until: ct.retention_until, masked: false }
            : { email: maskEmail(ct.email), phone: maskPhone(ct.phone), name: maskName(ct.name), source: ct.source, retention_until: ct.retention_until, masked: true };
        }
        const declared = o.declared_tracking ?? {};
        return jsonSafe({
          order: { ...o, declared_tracking: { ...declared, trackingToken: declared.trackingToken ? `…${String(declared.trackingToken).slice(-4)}` : null } },
          items: items.rows,
          transactions: txs.rows,
          reversals: revs.rows,
          ledger: ledger.rows,
          conflicts: conflicts.rows,
          events: events.rows,
          receipts: receipts.rows,
          attributions: attributions.rows,
          touchpoints: touches.rows,
          deliveries: deliveries.rows,
          parent_order: related.rows.find((r) => r.relation === "parent") ?? null,
          child_orders: related.rows.filter((r) => r.relation === "child"),
          // Recebíveis/liquidações: informativos, nunca somados à receita (T18).
          settlements: settlements.rows,
          visitor_links: links.rows,
          customer,
        });
      });
    });

    // Venda manual/offline: confirmação manual distinta de checkout; entra pelo mesmo pipeline auditado.
    app.post("/orders/manual", async (req, reply) => {
      assertPermission(req.auth, req.org, "sales.write", { sensitive: true });
      const body = z
        .object({
          project_id: z.string().uuid(),
          external_order_id: z.string().trim().min(1).max(200),
          amount_minor: z.number().int().positive().safe(),
          currency: z.string().regex(/^[A-Z]{3}$/),
          occurred_at: z.iso.datetime({ offset: true }),
          payment_method: z.enum(["pix", "boleto", "credit_card", "debit_card", "wallet", "other", "unknown"]).default("other"),
          reference: z.string().trim().min(1).max(300),
          utm_source: z.string().max(200).optional(),
          utm_medium: z.string().max(200).optional(),
          utm_campaign: z.string().max(200).optional(),
        })
        .parse(req.body);
      assertProjectAccess(req.org!, body.project_id);
      const auth = req.auth!;
      const org = req.org!;
      const eventId = randomUUID();
      const canonical = {
        schema_version: "1.0",
        source: { provider: "manual", event_id: eventId, event_type: "manual.confirmed" },
        event_type: "payment.approved",
        occurred_at: body.occurred_at,
        order: { external_order_id: body.external_order_id, external_transaction_id: `manual:${body.external_order_id}`, currency: body.currency, amount_minor: body.amount_minor, payment_method: body.payment_method, transaction_kind: "manual" },
        attribution: { utm_source: body.utm_source ?? null, utm_medium: body.utm_medium ?? null, utm_campaign: body.utm_campaign ?? null },
      };
      const receiptId = await withTx(deps.pools.system, { organizationId: org.id }, async (c) => {
        const acct = await c.query(
          `insert into public.provider_accounts (organization_id, project_id, provider, external_account_id, display_name) values ($1, $2, 'manual', $3, 'Vendas manuais')
           on conflict (organization_id, provider, external_account_id) do update set display_name = excluded.display_name returning id`,
          [org.id, body.project_id, `manual:${body.project_id}`],
        );
        let conn = (await c.query("select id from public.provider_connections where organization_id = $1 and provider_account_id = $2 and provider = 'manual'", [org.id, acct.rows[0].id])).rows[0];
        if (!conn) {
          conn = (
            await c.query(
              "insert into public.provider_connections (organization_id, project_id, provider_account_id, provider, kind, name, status) values ($1, $2, $3, 'manual', 'custom', 'Vendas manuais', 'connected') returning id",
              [org.id, body.project_id, acct.rows[0].id],
            )
          ).rows[0];
        }
        const raw = Buffer.from(JSON.stringify(canonical));
        const r = await c.query(
          `insert into public.webhook_receipts (organization_id, project_id, connection_id, provider, provider_account_id, dedup_key, dedup_method, source_event_type, body, body_sha256, content_type, headers, auth_method, is_demo)
           values ($1, $2, $3, 'manual', $4, $5, 'provider_event_id', 'manual.confirmed', $6, sha256($6), 'application/json', $7, $8, $9)
           on conflict (organization_id, provider_account_id, dedup_key) do nothing returning id`,
          [org.id, body.project_id, conn.id, acct.rows[0].id, `order:${body.external_order_id}`, raw, JSON.stringify({ reference: body.reference }), `user:${auth.userId}`, org.isDemo],
        );
        if (!r.rows[0]) return null;
        await c.query("insert into public.outbox (organization_id, topic, payload, dedup_key, priority) values ($1, 'receipt.process', $2, $3, 1)", [org.id, JSON.stringify({ receipt_id: r.rows[0].id }), `receipt:${r.rows[0].id}`]);
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "order.manual_created", targetType: "receipt", targetId: r.rows[0].id, details: { external_order_id: body.external_order_id, amount_minor: body.amount_minor, currency: body.currency, reference: body.reference }, requestId: req.id });
        return r.rows[0].id as string;
      });
      if (!receiptId) return reply.status(409).send({ error: { code: "duplicate", message: "Já existe venda manual com este identificador", request_id: req.id } });
      return reply.status(202).send({ receipt_id: receiptId, status: "queued" });
    });
  };
