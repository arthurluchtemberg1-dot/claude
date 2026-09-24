import { maskEmail, maskName } from "@tracker/domain";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../context";
import { badRequest, notFound } from "../lib/errors";
import { audit, jsonSafe, orgTx } from "../lib/org-tx";
import { assertPermission } from "../services/auth";

/**
 * Clientes (R24-04): pedidos agrupados pelo e-mail normalizado informado no checkout (hash SHA-256), somente dentro
 * da organização — nunca entre clientes do SaaS e nunca usado para atribuição ou para vincular upsell (R10-07).
 * Agrupamento explicável (critério exibido) e reversível: um pedido pode ser excluído do agrupamento (auditado).
 * Dados pessoais mascarados sem `pii.read`. Valores por moeda, sem conversão implícita.
 */

// Chave do cliente: hash do e-mail, ou "pedido:<id>" para pedidos excluídos do agrupamento/sem e-mail.
const KEY_SQL = `case when x.order_id is not null or ct.email_sha256 is null then 'pedido:' || o.id::text else ct.email_sha256 end`;
const BASE = `
  from public.orders o
  left join public.order_contacts ct on ct.order_id = o.id
  left join public.customer_exclusions x on x.order_id = o.id
 where o.first_approved_at is not null and not o.is_test and ($1::uuid[] is null or o.project_id = any($1))`;

const keyParam = z.string().regex(/^([0-9a-f]{64}|pedido:[0-9a-f-]{36})$/);

export const customerRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.get("/customers", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      const q = z
        .object({
          q: z.string().trim().max(200).optional(),
          recurring: z.coerce.boolean().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          offset: z.coerce.number().int().min(0).max(100_000).default(0),
        })
        .parse(req.query);
      return orgTx(deps, req, async (c, { org }) => {
        const canPii = org.permissions.has("pii.read");
        // Busca por e-mail completo só com pii.read (compara o hash, sem varrer texto).
        const emailHash = q.q && q.q.includes("@") && canPii ? (await c.query("select encode(sha256(convert_to(lower(trim($1)), 'UTF8')), 'hex') as h", [q.q])).rows[0].h : null;
        const r = await c.query(
          `with g as (
             select ${KEY_SQL} as customer_key, o.id, o.currency, o.approved_minor, o.reversed_minor, o.first_approved_at, o.external_order_id, ct.email, ct.name
             ${BASE})
           select customer_key, count(*)::int as orders, min(first_approved_at) as first_purchase_at, max(first_approved_at) as last_purchase_at,
                  (array_agg(email order by first_approved_at desc) filter (where email is not null))[1] as email,
                  (array_agg(name order by first_approved_at desc) filter (where name is not null))[1] as name,
                  json_agg(json_build_object('currency', trim(currency), 'approved_minor', approved_minor, 'net_minor', approved_minor - reversed_minor)) as amounts,
                  count(*) over ()::int as total
             from g
            where ($2::text is null or customer_key = $2 or external_order_id = $3)
            group by customer_key
           having ($4::boolean is null or (count(*) > 1) = $4)
            order by max(first_approved_at) desc, customer_key
            limit $5 offset $6`,
          [org.projectIds, emailHash, q.q && !q.q.includes("@") ? q.q : null, q.recurring ?? null, q.limit, q.offset],
        );
        const rows = r.rows.map((x) => {
          const totals = new Map<string, { approved: bigint; net: bigint }>();
          for (const a of x.amounts as { currency: string | null; approved_minor: string; net_minor: string }[]) {
            const k = a.currency ?? "—";
            const t = totals.get(k) ?? { approved: 0n, net: 0n };
            t.approved += BigInt(a.approved_minor);
            t.net += BigInt(a.net_minor);
            totals.set(k, t);
          }
          return {
            customer_key: x.customer_key,
            identified_by: String(x.customer_key).startsWith("pedido:") ? "order" : "email_sha256",
            email: canPii ? x.email : maskEmail(x.email),
            name: canPii ? x.name : maskName(x.name),
            orders: x.orders,
            recurring: x.orders > 1,
            first_purchase_at: x.first_purchase_at,
            last_purchase_at: x.last_purchase_at,
            totals: [...totals.entries()].map(([currency, t]) => ({ currency, approved_minor: t.approved, net_minor: t.net })),
          };
        });
        return jsonSafe({
          customers: rows,
          total: r.rows[0]?.total ?? 0,
          pii_masked: !canPii,
          criterion: "Pedidos aprovados agrupados pelo e-mail informado no checkout (normalizado e comparado por hash) dentro desta organização. Pedidos sem e-mail ou excluídos do agrupamento aparecem sozinhos.",
        });
      });
    });

    app.get("/customers/:key", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      const { key } = z.object({ key: keyParam }).parse(req.params);
      return orgTx(deps, req, async (c, { org }) => {
        const canPii = org.permissions.has("pii.read");
        const orders = (
          await c.query(
            `select o.id, o.project_id, o.provider, o.external_order_id, o.financial_status, trim(o.currency) as currency, o.approved_minor, o.reversed_minor, o.first_approved_at,
                    o.parent_order_id, ct.email, ct.name, (x.order_id is not null) as excluded, x.reason as exclusion_reason,
                    a.category as attribution_category, a.network, a.campaign_id, a.utm_source, a.utm_campaign,
                    (select string_agg(coalesce(i.name, i.external_product_id), ', ' order by i.item_key) from public.order_items i where i.order_id = o.id) as products
               from public.orders o
               left join public.order_contacts ct on ct.order_id = o.id
               left join public.customer_exclusions x on x.order_id = o.id
               left join public.order_attributions a on a.order_id = o.id and a.is_current and a.policy_key = 'default'
              where o.first_approved_at is not null and not o.is_test and ($1::uuid[] is null or o.project_id = any($1)) and ${KEY_SQL} = $2
              order by o.first_approved_at`,
            [org.projectIds, key],
          )
        ).rows;
        if (!orders.length) throw notFound("Cliente não encontrado");
        // Consentimentos observados nos visitantes vinculados por token aos pedidos (sem inferir identidade).
        const consents = (
          await c.query(
            `select distinct on (cr.visitor_id) cr.visitor_id, cr.analytics, cr.advertising, cr.storage, cr.source, cr.recorded_at
               from public.order_visitor_links l join public.consent_records cr on cr.visitor_id = l.visitor_id and cr.organization_id = l.organization_id
              where l.order_id = any($1) order by cr.visitor_id, cr.recorded_at desc`,
            [orders.map((o) => o.id)],
          )
        ).rows;
        const first = orders[0]!;
        return jsonSafe({
          customer_key: key,
          identified_by: key.startsWith("pedido:") ? "order" : "email_sha256",
          email: canPii ? first.email : maskEmail(first.email),
          name: canPii ? first.name : maskName(first.name),
          orders: orders.map(({ email: _e, name: _n, ...o }) => o),
          consents,
          pii_masked: !canPii,
        });
      });
    });

    // Desfazer agrupamento de um pedido (reversível, auditado).
    app.post("/customers/exclusions", async (req, reply) => {
      assertPermission(req.auth, req.org, "sales.write");
      const body = z.object({ order_id: z.string().uuid(), reason: z.string().trim().min(3).max(300) }).parse(req.body);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const o = (await c.query("select id, project_id from public.orders where id = $1", [body.order_id])).rows[0];
        if (!o || (org.projectIds && !org.projectIds.includes(o.project_id))) throw notFound("Pedido não encontrado");
        const r = await c.query("insert into public.customer_exclusions (organization_id, order_id, reason, created_by) values ($1, $2, $3, $4) on conflict do nothing returning order_id", [org.id, body.order_id, body.reason, auth.userId]);
        if (!r.rows[0]) throw badRequest("already_excluded", "Pedido já está fora do agrupamento");
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "customer.order_excluded", targetType: "order", targetId: body.order_id, details: { reason: body.reason }, requestId: req.id });
        reply.status(201);
        return { ok: true, customer_key: `pedido:${body.order_id}` };
      });
    });

    app.delete("/customers/exclusions/:orderId", async (req) => {
      assertPermission(req.auth, req.org, "sales.write");
      const { orderId } = z.object({ orderId: z.string().uuid() }).parse(req.params);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const r = await c.query("delete from public.customer_exclusions where order_id = $1 returning order_id", [orderId]);
        if (!r.rows[0]) throw notFound("Exclusão não encontrada");
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "customer.order_regrouped", targetType: "order", targetId: orderId, requestId: req.id });
        return { ok: true };
      });
    });
  };
