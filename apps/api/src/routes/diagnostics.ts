import { inSequence } from "@tracker/db";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../context";
import { badRequest, notFound } from "../lib/errors";
import { audit, jsonSafe, orgSystemTx, orgTx } from "../lib/org-tx";
import { assertPermission, assertProjectAccess } from "../services/auth";

/**
 * Centro de diagnóstico e qualidade (R15-08, R17-16, R21): recebimentos, quarentena, rejeições, fila,
 * entregas, cadeia visita→token→checkout→pedido. Nunca expõe tokens completos ou dados pessoais.
 */
export const diagnosticsRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.get("/diagnostics/overview", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      return orgTx(deps, req, async (c) => {
        const [receipts, rejections, outbox, deliveries, conns, conflicts, attribution, tracking] = await inSequence([
          () => c.query(`select status, count(*)::int as n, max(received_at) as last_at from public.webhook_receipts where received_at > now() - interval '7 days' group by status`),
          () => c.query(`select reason, count(*)::int as n, max(received_at) as last_at from public.webhook_rejections where received_at > now() - interval '7 days' group by reason`),
          () => c.query(`select status, count(*)::int as n, min(created_at) as oldest from public.outbox where status <> 'done' group by status`),
          () => c.query(`select status, count(*)::int as n from public.destination_deliveries group by status`),
          () => c.query(`select id, provider, name, status, environment, last_success_at, last_error_at, last_error, disabled_at from public.provider_connections order by created_at`),
          () => c.query(`select count(*)::int as n from public.order_conflicts where resolved_at is null`),
          () => c.query(`select coalesce(a.category, 'unattributed') as category, count(*)::int as n
                     from public.orders o left join public.order_attributions a on a.order_id = o.id and a.is_current and a.policy_key = 'default'
                    where o.first_approved_at > now() - interval '30 days' and o.is_test = false group by 1`),
          () => c.query(`select (select count(*) from public.sessions where started_at > now() - interval '7 days')::int as sessions_7d,
                          (select count(*) from public.tracking_events where occurred_at > now() - interval '7 days')::int as events_7d,
                          (select max(received_at) from public.tracking_events) as last_event_at,
                          (select count(*) from public.link_tokens where created_at > now() - interval '7 days')::int as tokens_7d,
                          (select count(*) from public.link_tokens where first_order_id is not null and created_at > now() - interval '30 days')::int as tokens_linked_30d`),
        ] as const);
        // Alertas de qualidade (R21-06): somente sinais calculáveis com os dados existentes.
        const alerts: { severity: string; code: string; message: string }[] = [];
        const q = receipts.rows.find((r) => r.status === "quarantined");
        if (q) alerts.push({ severity: "warning", code: "quarantined_receipts", message: `${q.n} recebimento(s) em quarentena nos últimos 7 dias — verifique o formato enviado pelo provedor` });
        const d = receipts.rows.find((r) => r.status === "dead");
        if (d) alerts.push({ severity: "error", code: "dead_receipts", message: `${d.n} recebimento(s) esgotaram tentativas de processamento` });
        if (rejections.rows.length) alerts.push({ severity: "warning", code: "rejected_webhooks", message: `${rejections.rows.reduce((a, r) => a + r.n, 0)} requisição(ões) rejeitada(s) por autenticação` });
        const pending = outbox.rows.find((r) => r.status === "pending");
        if (pending && new Date(pending.oldest).getTime() < Date.now() - 10 * 60_000) alerts.push({ severity: "error", code: "queue_backlog", message: "Fila com trabalho pendente há mais de 10 minutos — verifique o worker e o Redis" });
        const unattr = attribution.rows.find((r) => r.category === "unattributed")?.n ?? 0;
        const total = attribution.rows.reduce((a, r) => a + r.n, 0);
        if (total >= 10 && unattr / total > 0.5) alerts.push({ severity: "warning", code: "high_unattributed", message: `${Math.round((unattr / total) * 100)}% das vendas dos últimos 30 dias estão sem atribuição` });
        for (const cn of conns.rows) {
          if (["token_expired", "revoked", "temporary_failure"].includes(cn.status) && !cn.disabled_at) alerts.push({ severity: "error", code: "connection_unhealthy", message: `Conexão "${cn.name}" em estado ${cn.status}` });
          if (cn.status === "awaiting_configuration") alerts.push({ severity: "info", code: "connection_waiting", message: `Conexão "${cn.name}" ainda não recebeu nenhum evento autenticado` });
        }
        return jsonSafe({
          receipts: receipts.rows,
          rejections: rejections.rows,
          outbox: outbox.rows,
          deliveries: deliveries.rows,
          connections: conns.rows,
          open_conflicts: conflicts.rows[0].n,
          attribution_30d: attribution.rows,
          tracking: tracking.rows[0],
          alerts,
        });
      });
    });

    app.get("/diagnostics/receipts", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      const q = z.object({ status: z.enum(["pending", "processed", "quarantined", "ignored", "failed", "dead"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
      return orgTx(deps, req, async (c) => {
        const r = await c.query(
          `select r.id, r.provider, r.connection_id, r.source_event_type, r.received_at, r.status, r.status_reason, r.delivery_count, r.dedup_method, r.auth_method, r.processed_at, r.is_test,
                  length(r.body) as body_bytes
             from public.webhook_receipts r where ($1::text is null or r.status = $1) order by r.received_at desc limit $2`,
          [q.status ?? null, q.limit],
        );
        return jsonSafe({ receipts: r.rows });
      });
    });

    // Corpo bruto pode conter dados pessoais: exige pii.read e é auditado.
    app.get("/diagnostics/receipts/:id/body", async (req) => {
      assertPermission(req.auth, req.org, "pii.read");
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const r = await c.query("select body, content_type from public.webhook_receipts where id = $1", [id]);
        if (!r.rows[0]) throw notFound();
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "receipt.body_viewed", targetType: "receipt", targetId: id, requestId: req.id });
        return { content_type: r.rows[0].content_type, body: Buffer.from(r.rows[0].body).toString("utf8").slice(0, 64 * 1024) };
      });
    });

    // Reprocessamento seletivo (R09-18): não reenvia conversões externas (fanout só para aprovações novas, T27).
    app.post("/diagnostics/receipts/:id/reprocess", async (req) => {
      assertPermission(req.auth, req.org, "provider.connect", { sensitive: true });
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return orgSystemTx(deps, req, async (c, { auth, org }) => {
        const r = await c.query("select status from public.webhook_receipts where id = $1 for update", [id]);
        if (!r.rows[0]) throw notFound();
        if (!["quarantined", "failed", "dead", "ignored"].includes(r.rows[0].status)) throw badRequest("not_reprocessable", `Recebimento em estado ${r.rows[0].status} não precisa de reprocessamento`);
        await c.query("update public.webhook_receipts set status = 'pending', status_reason = null where id = $1", [id]);
        const n = (await c.query("select count(*)::int as n from public.outbox where dedup_key like $1", [`receipt:${id}%`])).rows[0].n;
        await c.query("insert into public.outbox (organization_id, topic, payload, dedup_key, priority) values ($1, 'receipt.process', $2, $3, 2)", [org.id, JSON.stringify({ receipt_id: id }), `receipt:${id}:reprocess:${n}`]);
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "receipt.reprocess_requested", targetType: "receipt", targetId: id, requestId: req.id });
        return { ok: true };
      });
    });

    // Cadeia de rastreamento de um pedido (R15-08): visita, token, parâmetro enviado/recebido, vínculo e motivo de perda.
    app.get("/diagnostics/tracking/orders/:id", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return orgTx(deps, req, async (c, { org }) => {
        const o = (await c.query("select id, project_id, provider, declared_tracking, first_approved_at from public.orders where id = $1", [id])).rows[0];
        if (!o) throw notFound();
        assertProjectAccess(org, o.project_id);
        const declared = o.declared_tracking ?? {};
        const link = (await c.query("select l.evidence, l.linked_at, t.token_hint, t.created_at as token_created_at, t.session_id from public.order_visitor_links l left join public.link_tokens t on t.id = l.link_token_id where l.order_id = $1", [id])).rows[0];
        const checkoutClicks = link
          ? (await c.query("select count(*)::int as n from public.tracking_events e join public.order_visitor_links l on l.visitor_id = e.visitor_id where l.order_id = $1 and e.event_name in ('CheckoutClick', 'InitiateCheckout')", [id])).rows[0].n
          : 0;
        const attr = (await c.query("select category, reason, unattributed_reason, quality, evidence from public.order_attributions where order_id = $1 and is_current and policy_key = 'default'", [id])).rows[0];
        const utm = declared.utm ?? {};
        const steps = [
          { step: "visit_captured", ok: !!link, detail: link ? "Sessão do SDK vinculada ao pedido" : "Nenhuma sessão vinculada por token" },
          { step: "token_created", ok: !!link?.token_hint, detail: link?.token_hint ? `Token …${link.token_hint} emitido` : "Sem token emitido/vinculado" },
          { step: "parameter_sent", ok: checkoutClicks > 0, detail: checkoutClicks > 0 ? `${checkoutClicks} clique(s) de checkout registrados` : "Nenhum clique de checkout registrado para o visitante" },
          {
            step: "parameter_received",
            ok: !!declared.trackingToken || !!(utm.source || utm.campaign),
            detail: declared.trackingToken ? `Checkout devolveu token …${String(declared.trackingToken).slice(-4)}` : utm.source || utm.campaign ? "Checkout devolveu apenas UTMs" : "Checkout não devolveu token nem UTMs",
          },
          { step: "order_associated", ok: !!attr && attr.category !== "unattributed", detail: attr ? `${attr.category} (${attr.quality}) — ${attr.reason}` : "Atribuição ainda não calculada" },
        ];
        const lossReason = steps.find((s) => !s.ok)?.detail ?? null;
        return jsonSafe({ order_id: id, provider: o.provider, steps, loss_reason: lossReason, declared_utm: utm, provider_refs: declared.providerRefs ?? {} });
      });
    });

    app.get("/deliveries", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      const q = z.object({ status: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
      return orgTx(deps, req, async (c) => {
        const r = await c.query(
          `select d.id, d.order_id, d.event_name, d.event_id, d.environment, d.origin, d.status, d.not_eligible_reason, d.attempts, d.next_attempt_at, d.last_http_status,
                  d.last_provider_code, d.last_trace_id, d.last_error, d.event_time, d.created_at, d.updated_at, cd.name as destination, cd.provider
             from public.destination_deliveries d join public.conversion_destinations cd on cd.id = d.destination_id
            where ($1::text is null or d.status = $1) order by d.updated_at desc limit $2`,
          [q.status ?? null, q.limit],
        );
        return jsonSafe({ deliveries: r.rows, note: "Aceito pela API não significa correspondência com usuário nem atribuição ao anúncio." });
      });
    });

    app.get("/deliveries/:id/attempts", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return orgTx(deps, req, async (c) => jsonSafe({ attempts: (await c.query("select attempt_no, started_at, finished_at, latency_ms, http_status, provider_code, trace_id, outcome, error_message from public.delivery_attempts where delivery_id = $1 order by attempt_no", [id])).rows }));
    });

    // Reenvio manual explícito: mesmo event_id (deduplicável no destino).
    app.post("/deliveries/:id/resend", async (req) => {
      assertPermission(req.auth, req.org, "pixel.configure", { sensitive: true });
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return orgSystemTx(deps, req, async (c, { auth, org }) => {
        const d = (await c.query("select status, attempts from public.destination_deliveries where id = $1 for update", [id])).rows[0];
        if (!d) throw notFound();
        if (d.status === "accepted") throw badRequest("already_accepted", "Evento já aceito pelo destino");
        await c.query("update public.destination_deliveries set status = 'queued', not_eligible_reason = null, origin = 'manual_resend' where id = $1", [id]);
        await c.query("insert into public.outbox (organization_id, topic, payload, dedup_key, priority) values ($1, 'delivery.send', $2, $3, 5) on conflict do nothing", [
          org.id, JSON.stringify({ delivery_id: id }), `delivery:${id}:manual:${d.attempts}:${Date.now()}`,
        ]);
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "delivery.resend_requested", targetType: "delivery", targetId: id, requestId: req.id });
        return { ok: true };
      });
    });
  };
