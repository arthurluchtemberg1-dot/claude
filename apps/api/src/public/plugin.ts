import { createHash } from "node:crypto";
import { localDateRangeToUtc, serializeMetric } from "@tracker/domain";
import { withTx, type PoolClient } from "@tracker/db";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../context";
import { hmacToken } from "../lib/crypto";
import { HttpError, badRequest, forbidden, notFound } from "../lib/errors";
import { jsonSafe } from "../lib/org-tx";
import { API_KEY_RE, type ApiKeyContext, type ApiScope } from "../services/api-keys";
import { computeBreakdown } from "../services/breakdown";
import { createManualSale, manualSaleSchema } from "../services/manual-sale";
import { computeScopeMetrics } from "../services/metrics-repo";
import { buildOpenApi } from "./openapi";

/**
 * API pública v1 (seção 33). Autenticação por chave (Bearer), escopos, restrição por projetos e ambiente
 * (sandbox = somente dados de teste), limites por chave e organização com cabeçalhos RateLimit-*, Idempotency-Key nas
 * criações, contrato de erro com request_id e registro de uso sem conteúdo sensível. Nada administrativo é exposto.
 * Consultas usam o papel de sistema restrito à organização da chave (RLS) e filtros explícitos de projeto/ambiente.
 */

declare module "fastify" {
  interface FastifyRequest {
    apiKey: ApiKeyContext | null;
  }
  interface FastifyContextConfig {
    publicNoAuth?: boolean;
  }
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function encodeCursor(ts: Date | string, id: string) {
  return Buffer.from(JSON.stringify([new Date(ts).toISOString(), id])).toString("base64url");
}
function decodeCursor(s: string): { ts: string; id: string } {
  try {
    const [ts, id] = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (typeof ts !== "string" || typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id) || Number.isNaN(Date.parse(ts))) throw new Error();
    return { ts, id };
  } catch {
    throw badRequest("invalid_cursor", "Cursor inválido");
  }
}

function requireScope(req: FastifyRequest, scope: ApiScope) {
  if (!req.apiKey!.scopes.has(scope)) throw forbidden("insufficient_scope", `Escopo necessário: ${scope}`);
}

/** Projetos consultáveis pela chave (interseção com o filtro pedido). */
function projectScope(req: FastifyRequest, requested?: string): string[] | null {
  const k = req.apiKey!;
  if (requested) {
    if (k.projectIds && !k.projectIds.includes(requested)) throw forbidden("project_forbidden", "Projeto fora do escopo da chave");
    return [requested];
  }
  return k.projectIds;
}

async function consumeRateLimit(deps: AppDeps, k: ApiKeyContext, now: Date) {
  const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const rows = await withTx(deps.pools.system, { organizationId: k.organizationId }, async (c) => {
    const r = await c.query(
      `insert into public.api_rate_windows (organization_id, subject, window_start, count) values ($1, $2, $3, 1), ($1, 'org', $3, 1)
       on conflict (organization_id, subject, window_start) do update set count = public.api_rate_windows.count + 1 returning subject, count`,
      [k.organizationId, `key:${k.id}`, windowStart],
    );
    if (Math.random() < 0.02) await c.query("delete from public.api_rate_windows where organization_id = $1 and window_start < $2", [k.organizationId, new Date(windowStart.getTime() - 3600_000)]);
    return r.rows as { subject: string; count: number }[];
  });
  const keyCount = rows.find((r) => r.subject !== "org")?.count ?? 0;
  const orgCount = rows.find((r) => r.subject === "org")?.count ?? 0;
  const keyLimit = deps.config.API_RATE_LIMIT_PER_KEY;
  const orgLimit = deps.config.API_RATE_LIMIT_PER_ORG;
  const remaining = Math.max(0, Math.min(keyLimit - keyCount, orgLimit - orgCount));
  const reset = Math.max(1, Math.ceil((windowStart.getTime() + 60_000 - now.getTime()) / 1000));
  return { limit: Math.min(keyLimit, orgLimit), remaining, reset, exceeded: keyCount > keyLimit ? "key" : orgCount > orgLimit ? "organization" : null };
}

/**
 * Idempotency-Key: a mesma chave com o mesmo corpo devolve a resposta original (Idempotent-Replayed: true); com corpo
 * diferente → 422. Registro e efeito na MESMA transação: requisições concorrentes esperam a primeira terminar.
 */
async function idempotent(
  c: PoolClient,
  req: FastifyRequest,
  handler: () => Promise<{ status: number; body: unknown }>,
): Promise<{ status: number; body: unknown; replayed: boolean }> {
  const raw = req.headers["idempotency-key"];
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) throw badRequest("idempotency_key_required", "Envie o cabeçalho Idempotency-Key (até 200 caracteres) para criações");
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw badRequest("invalid_idempotency_key", "Idempotency-Key com caracteres inválidos");
  const k = req.apiKey!;
  const hash = createHash("sha256").update(JSON.stringify(req.body ?? null)).digest("hex");
  await c.query("delete from public.api_idempotency where organization_id = $1 and api_key_id = $2 and idem_key = $3 and expires_at < now()", [k.organizationId, k.id, key]);
  const ins = await c.query(
    "insert into public.api_idempotency (organization_id, api_key_id, idem_key, request_hash) values ($1, $2, $3, $4) on conflict do nothing returning idem_key",
    [k.organizationId, k.id, key, hash],
  );
  if (!ins.rows[0]) {
    const ex = (await c.query("select request_hash, status_code, response from public.api_idempotency where organization_id = $1 and api_key_id = $2 and idem_key = $3", [k.organizationId, k.id, key])).rows[0];
    if (ex.request_hash !== hash) throw new HttpError(422, "idempotency_key_reused", "Idempotency-Key já usada com outro corpo de requisição");
    return { status: ex.status_code, body: ex.response, replayed: true };
  }
  const res = await handler();
  const body = jsonSafe(res.body);
  await c.query("update public.api_idempotency set status_code = $4, response = $5 where organization_id = $1 and api_key_id = $2 and idem_key = $3", [k.organizationId, k.id, key, res.status, JSON.stringify(body)]);
  return { status: res.status, body, replayed: false };
}

/** Envia a resposta somente depois do commit da transação. */
function sendResult(reply: FastifyReply, res: { status: number; body: unknown; replayed: boolean }) {
  if (res.replayed) reply.header("idempotent-replayed", "true");
  return reply.status(res.status).send(res.body);
}

/** Rotas registradas ("MÉTODO /public/v1/..."): usadas no teste que exige documentação OpenAPI de todas. */
export const registeredPublicRoutes = new Set<string>();

export const publicApi =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const routes: { method: string; url: string }[] = [];
    app.addHook("onRoute", (r) => {
      for (const m of [r.method].flat()) {
        if (m === "HEAD") continue;
        routes.push({ method: m, url: r.url });
        registeredPublicRoutes.add(`${m} ${r.url}`);
      }
    });
    app.decorateRequest("apiKey", null);

    app.addHook("onRequest", async (req, reply) => {
      reply.header("cache-control", "no-store");
      if (req.routeOptions.config?.publicNoAuth) return;
      const h = req.headers.authorization;
      const key = typeof h === "string" && h.startsWith("Bearer ") ? h.slice(7).trim() : "";
      if (!API_KEY_RE.test(key)) throw new HttpError(401, "invalid_api_key", "Chave de API ausente ou inválida (use Authorization: Bearer tk_…)");
      const row = (await deps.pools.system.query("select * from app.resolve_api_key($1)", [hmacToken(deps.config.tokenHmacKey, key)])).rows[0];
      if (!row) throw new HttpError(401, "invalid_api_key", "Chave de API ausente ou inválida");
      if (row.revoked) throw new HttpError(401, "api_key_revoked", "Chave de API revogada");
      if (row.expired) throw new HttpError(401, "api_key_expired", "Chave de API expirada");
      req.apiKey = {
        id: row.id,
        organizationId: row.organization_id,
        scopes: new Set(row.scopes as ApiScope[]),
        projectIds: row.project_ids?.length ? row.project_ids : null,
        environment: row.environment,
      };
      const rl = await consumeRateLimit(deps, req.apiKey, deps.now());
      reply.header("ratelimit-limit", String(rl.limit)).header("ratelimit-remaining", String(rl.remaining)).header("ratelimit-reset", String(rl.reset));
      if (rl.exceeded) {
        reply.header("retry-after", String(rl.reset));
        throw new HttpError(429, "rate_limited", `Limite de requisições por minuto excedido (${rl.exceeded === "key" ? "chave" : "organização"}). Tente novamente em ${rl.reset} s.`);
      }
    });

    // Uso registrado sem query string nem corpo (R33-04).
    app.addHook("onResponse", async (req, reply) => {
      const k = req.apiKey;
      if (!k) return;
      try {
        await withTx(deps.pools.system, { organizationId: k.organizationId }, async (c) => {
          await c.query("insert into public.api_key_usage (organization_id, api_key_id, method, route, status, latency_ms, request_id) values ($1,$2,$3,$4,$5,$6,$7)", [
            k.organizationId, k.id, req.method, req.routeOptions.url ?? "(desconhecida)", reply.statusCode, Math.round(reply.elapsedTime), req.id,
          ]);
          await c.query("update public.api_keys set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')", [k.id]);
        });
      } catch (err) {
        deps.logger.warn({ err: (err as Error).message }, "api_usage_log_failed");
      }
    });

    const tx = <T>(req: FastifyRequest, fn: (c: PoolClient) => Promise<T>) => withTx(deps.pools.system, { organizationId: req.apiKey!.organizationId }, fn);

    app.get("/openapi.json", { config: { publicNoAuth: true } }, async () => buildOpenApi(deps.config.PUBLIC_API_URL));

    // ---------------------------------------------------------------- pedidos
    app.get("/orders", async (req) => {
      requireScope(req, "orders:read");
      const q = z
        .object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          cursor: z.string().max(200).optional(),
          project_id: z.string().uuid().optional(),
          status: z.enum(["pending", "failed", "approved", "partially_reversed", "fully_reversed", "reversal_pending_reconciliation"]).optional(),
          approved_from: z.iso.datetime({ offset: true }).optional(),
          approved_to: z.iso.datetime({ offset: true }).optional(),
        })
        .parse(req.query);
      const projects = projectScope(req, q.project_id);
      const cursor = q.cursor ? decodeCursor(q.cursor) : null;
      return tx(req, async (c) => {
        const r = await c.query(
          `select o.id, o.project_id, o.provider, o.external_order_id, o.parent_order_id, o.financial_status as status, o.currency, o.approved_minor, o.reversed_minor,
                  o.first_approved_at, o.first_received_at, o.payment_method, o.is_test, coalesce(o.first_approved_at, o.first_received_at) as sort_ts,
                  a.category as attribution_category, a.network, a.campaign_id, a.adset_id, a.ad_id, a.utm_source, a.utm_campaign
             from public.orders o
             left join public.order_attributions a on a.order_id = o.id and a.is_current and a.policy_key = 'default'
            where ($1::uuid[] is null or o.project_id = any($1)) and o.is_test = $2 and not o.is_demo
              and ($3::text is null or o.financial_status = $3)
              and ($4::timestamptz is null or o.first_approved_at >= $4) and ($5::timestamptz is null or o.first_approved_at < $5)
              and ($6::timestamptz is null or (coalesce(o.first_approved_at, o.first_received_at), o.id) < ($6, $7::uuid))
            order by sort_ts desc, o.id desc limit $8`,
          [projects, req.apiKey!.environment === "sandbox", q.status ?? null, q.approved_from ?? null, q.approved_to ?? null, cursor?.ts ?? null, cursor?.id ?? null, q.limit + 1],
        );
        const rows = r.rows.slice(0, q.limit);
        const last = rows[rows.length - 1];
        return jsonSafe({
          data: rows.map(({ sort_ts: _s, currency, ...o }) => ({ ...o, currency: String(currency ?? "").trim() || null })),
          next_cursor: r.rows.length > q.limit && last ? encodeCursor(last.sort_ts, last.id) : null,
        });
      });
    });

    app.get("/orders/:id", async (req) => {
      requireScope(req, "orders:read");
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return tx(req, async (c) => {
        const o = (
          await c.query(
            `select id, project_id, provider, external_order_id, parent_order_id, financial_status as status, currency, approved_minor, reversed_minor, first_approved_at,
                    first_received_at, payment_method, is_test, is_demo from public.orders where id = $1`,
            [id],
          )
        ).rows[0];
        const k = req.apiKey!;
        // Outro projeto, outro ambiente ou demonstração: indistinguível de inexistente.
        if (!o || o.is_demo || o.is_test !== (k.environment === "sandbox") || (k.projectIds && !k.projectIds.includes(o.project_id))) throw notFound("Pedido não encontrado");
        const items = (await c.query("select external_product_id, name, item_type, unit_amount_minor, quantity, currency from public.order_items where order_id = $1 order by item_key", [id])).rows;
        const transactions = (await c.query("select transaction_key, kind, status, amount_minor, currency, method, installments, approved_at from public.payment_transactions where order_id = $1 order by status_occurred_at", [id])).rows;
        const reversals = (await c.query("select reversal_key, kind, status, effective_minor, occurred_at from public.reversals where order_id = $1 order by occurred_at", [id])).rows;
        const attribution = (
          await c.query(
            `select policy_key, policy_version, model, window_days, category, evidence, quality, reason, network, campaign_id, adset_id, ad_id, utm_source, utm_campaign, computed_at
               from public.order_attributions where order_id = $1 and is_current order by policy_key`,
            [id],
          )
        ).rows;
        const { is_demo: _d, currency, ...order } = o;
        return jsonSafe({ data: { ...order, currency: String(currency ?? "").trim() || null, items, transactions, reversals, attributions: attribution } });
      });
    });

    // Importação de venda (manual/offline ou sistema próprio sem webhook). Sandbox cria vendas de teste.
    app.post("/sales", async (req, reply) => {
      requireScope(req, "orders:write");
      const sale = manualSaleSchema.parse(req.body);
      projectScope(req, sale.project_id);
      const k = req.apiKey!;
      const result = await tx(req, async (c) => {
        const org = (await c.query("select is_demo from public.organizations where id = $1", [k.organizationId])).rows[0];
        const project = (await c.query("select id from public.projects where id = $1", [sale.project_id])).rows[0];
        if (!project) throw badRequest("invalid_project", "Projeto inexistente nesta organização");
        return idempotent(c, req, async () => {
          const res = await createManualSale(c, { organizationId: k.organizationId, sale, actor: { type: "api_key", id: k.id }, isDemo: org.is_demo, isTest: k.environment === "sandbox", requestId: req.id });
          if ("duplicate" in res) return { status: 409, body: { error: { code: "duplicate", message: "Já existe venda com este external_order_id neste projeto", request_id: req.id } } };
          return { status: 202, body: { data: { receipt_id: res.receiptId, status: "queued", is_test: k.environment === "sandbox" } } };
        });
      });
      return sendResult(reply, result);
    });

    // ---------------------------------------------------------------- métricas e campanhas (somente produção)
    app.get("/metrics/summary", async (req) => {
      requireScope(req, "metrics:read");
      const q = z
        .object({ from: date, to: date, project_id: z.string().uuid().optional(), basis: z.enum(["approval", "financial_movement", "acquisition_cohort"]).default("approval"), policy: z.string().max(60).default("default") })
        .parse(req.query);
      const projects = projectScope(req, q.project_id);
      return tx(req, async (c) => {
        const org = (await c.query("select timezone, settings from public.organizations where id = $1", [req.apiKey!.organizationId])).rows[0];
        localDateRangeToUtc(q.from, q.to, org.timezone);
        const groups = await computeScopeMetrics(c, {
          organizationId: req.apiKey!.organizationId,
          projectIds: projects,
          from: q.from,
          to: q.to,
          timezone: org.timezone,
          basis: q.basis,
          asOf: deps.now(),
          policyKey: q.policy,
          includeTest: false,
          declaredZeroCosts: Array.isArray(org.settings?.cost_policy?.declared_zero) ? org.settings.cost_policy.declared_zero : [],
        });
        return jsonSafe({
          scope: { from: q.from, to: q.to, timezone: org.timezone, basis: q.basis, policy: q.policy, project_id: q.project_id ?? null },
          data: groups.map((g) => ({ currency: g.currency, notes: g.notes, metrics: Object.values(g.metrics).map(serializeMetric) })),
        });
      });
    });

    app.get("/campaigns", async (req) => {
      requireScope(req, "campaigns:read");
      const q = z
        .object({
          dimension: z.enum(["campaign", "adset", "ad", "network"]).default("campaign"),
          from: date,
          to: date,
          project_id: z.string().uuid().optional(),
          campaign_id: z.string().trim().min(1).max(64).optional(),
          policy: z.string().max(60).default("default"),
        })
        .parse(req.query);
      const projects = projectScope(req, q.project_id);
      return tx(req, async (c) => {
        const org = (await c.query("select timezone from public.organizations where id = $1", [req.apiKey!.organizationId])).rows[0];
        localDateRangeToUtc(q.from, q.to, org.timezone);
        const groups = await computeBreakdown(c, {
          organizationId: req.apiKey!.organizationId,
          projectIds: projects,
          from: q.from,
          to: q.to,
          timezone: org.timezone,
          basis: "approval",
          asOf: deps.now(),
          includeTest: false,
          policyKey: q.policy,
          dimension: q.dimension,
          campaignId: q.campaign_id ?? null,
        });
        return jsonSafe({ scope: { ...q, timezone: org.timezone }, data: groups });
      });
    });

    // ---------------------------------------------------------------- produtos e integrações
    app.get("/products", async (req) => {
      requireScope(req, "products:read");
      const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(200).optional(), project_id: z.string().uuid().optional() }).parse(req.query);
      const projects = projectScope(req, q.project_id);
      const cursor = q.cursor ? decodeCursor(q.cursor) : null;
      return tx(req, async (c) => {
        const r = await c.query(
          `select p.id, p.project_id, p.name, p.reference_price_minor, p.currency, p.created_at,
                  coalesce((select json_agg(json_build_object('provider_account_id', x.provider_account_id, 'external_product_id', x.external_product_id, 'external_name', x.external_name))
                              from public.product_external_ids x where x.product_id = p.id), '[]') as external_ids
             from public.products p
            where ($1::uuid[] is null or p.project_id = any($1)) and ($2::timestamptz is null or (p.created_at, p.id) < ($2, $3::uuid))
            order by p.created_at desc, p.id desc limit $4`,
          [projects, cursor?.ts ?? null, cursor?.id ?? null, q.limit + 1],
        );
        const rows = r.rows.slice(0, q.limit);
        const last = rows[rows.length - 1];
        return jsonSafe({
          data: rows.map((p) => ({ ...p, currency: p.currency ? String(p.currency).trim() : null })),
          next_cursor: r.rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null,
        });
      });
    });

    app.get("/integrations", async (req) => {
      requireScope(req, "integrations:read");
      const projects = projectScope(req);
      return tx(req, async (c) =>
        jsonSafe({
          data: (
            await c.query(
              `select c.id, c.project_id, c.provider, c.kind, c.name, c.status, c.environment, c.last_success_at, c.last_error_at, c.disabled_at, c.created_at
                 from public.provider_connections c where ($1::uuid[] is null or c.project_id = any($1)) and c.provider <> 'manual' order by c.created_at`,
              [projects],
            )
          ).rows,
        }),
      );
    });

    app.addHook("onReady", async () => {
      // Todo endpoint registrado precisa estar documentado (verificado também em teste).
      const doc = buildOpenApi(deps.config.PUBLIC_API_URL) as { paths: Record<string, Record<string, unknown>> };
      for (const r of routes) {
        const path = r.url.replace(/^\/public\/v1/, "").replace(/:([A-Za-z_]+)/g, "{$1}");
        if (!doc.paths[path]?.[r.method.toLowerCase()]) deps.logger.warn({ route: `${r.method} ${r.url}` }, "public_route_undocumented");
      }
    });
  };

