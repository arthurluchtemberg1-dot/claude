import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../context";
import { badRequest, notFound } from "../lib/errors";
import { audit, jsonSafe, orgSystemTx, orgTx } from "../lib/org-tx";
import { assertPermission } from "../services/auth";
import { storeCredential } from "../services/credentials";

/**
 * Destinos de conversão (R17-01, R17-02, R02-08): criados desligados; envio exige status test_mode/enabled,
 * emissor responsável definido e ALLOW_EXTERNAL_DELIVERY no ambiente. Token nunca retorna ao cliente.
 */

const metaConfig = z.object({
  pixel_id: z.string().regex(/^\d{5,25}$/, "Pixel/dataset ID numérico"),
  api_version: z.string().regex(/^v\d+\.\d+$/).default("v24.0"),
  test_event_code: z.string().regex(/^[A-Za-z0-9]{3,40}$/).nullable().default(null),
  phone_country_code: z.string().regex(/^\d{1,3}$/).nullable().default("55"),
});

export const destinationRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.get("/destinations", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      return orgTx(deps, req, async (c) =>
        jsonSafe({
          destinations: (
            await c.query(
              `select d.id, d.provider, d.name, d.status, d.environment, d.config, d.purchase_emitter, d.enabled_events, d.routing, d.last_test_at, d.last_test_result, d.created_at,
                      (select count(*) from public.destination_deliveries x where x.destination_id = d.id) as deliveries
                 from public.conversion_destinations d order by d.created_at`,
            )
          ).rows,
          external_delivery_allowed: deps.config.ALLOW_EXTERNAL_DELIVERY,
        }),
      );
    });

    app.post("/destinations", async (req, reply) => {
      assertPermission(req.auth, req.org, "pixel.configure", { sensitive: true });
      const body = z
        .object({
          provider: z.literal("meta_capi"),
          name: z.string().trim().min(1).max(120),
          config: metaConfig,
          access_token: z.string().min(20).max(1000),
          purchase_emitter: z.enum(["server", "browser", "checkout_native"]).nullable().default(null),
          project_ids: z.array(z.string().uuid()).max(100).default([]),
        })
        .parse(req.body);
      const created = await orgSystemTx(deps, req, async (c, { auth, org }) => {
        const conn = await c.query(
          "insert into public.provider_connections (organization_id, project_id, provider, kind, name, status, config, created_by) select $1, id, 'meta_capi', 'destination', $2, 'awaiting_configuration', '{}', $3 from public.projects where organization_id = $1 order by created_at limit 1 returning id",
          [org.id, body.name, auth.userId],
        );
        if (!conn.rows[0]) throw badRequest("no_project", "Crie um projeto antes");
        await storeCredential(c, deps.config, { organizationId: org.id, connectionId: conn.rows[0].id, purpose: "capi_access_token", value: body.access_token });
        const d = await c.query(
          `insert into public.conversion_destinations (organization_id, connection_id, provider, name, status, environment, config, purchase_emitter, enabled_events, routing, created_by)
           values ($1, $2, 'meta_capi', $3, 'disabled', 'test', $4, $5, '{Purchase}', $6, $7) returning id`,
          [org.id, conn.rows[0].id, body.name, JSON.stringify(body.config), body.purchase_emitter, JSON.stringify({ project_ids: body.project_ids }), auth.userId],
        );
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "destination.created", targetType: "destination", targetId: d.rows[0].id, details: { provider: "meta_capi", pixel_id: body.config.pixel_id }, requestId: req.id });
        return d.rows[0].id as string;
      });
      return reply.status(201).send({ id: created, status: "disabled", note: "Destino criado desligado. Defina o emissor responsável e ative em modo de teste." });
    });

    app.patch("/destinations/:id", async (req) => {
      assertPermission(req.auth, req.org, "pixel.configure", { sensitive: true });
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({
          status: z.enum(["disabled", "test_mode", "enabled"]).optional(),
          purchase_emitter: z.enum(["server", "browser", "checkout_native"]).nullable().optional(),
          config: metaConfig.partial().optional(),
          project_ids: z.array(z.string().uuid()).max(100).optional(),
        })
        .parse(req.body);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const cur = (await c.query("select config, purchase_emitter, status from public.conversion_destinations where id = $1", [id])).rows[0];
        if (!cur) throw notFound();
        const emitter = body.purchase_emitter === undefined ? cur.purchase_emitter : body.purchase_emitter;
        if ((body.status === "enabled" || body.status === "test_mode") && !emitter) {
          throw badRequest("emitter_required", "Defina o emissor responsável pelo Purchase antes de ativar (evita envio duplicado pelo navegador/checkout)");
        }
        if (body.status === "enabled" && cur.status !== "test_mode" && cur.status !== "enabled") {
          throw badRequest("test_first", "Valide em modo de teste antes de ativar em produção");
        }
        const config = body.config ? { ...cur.config, ...body.config } : cur.config;
        await c.query(
          `update public.conversion_destinations set status = coalesce($2, status), purchase_emitter = $3, config = $4,
             environment = case coalesce($2, status) when 'enabled' then 'production' else 'test' end,
             routing = case when $5::jsonb is null then routing else $5 end where id = $1`,
          [id, body.status ?? null, emitter, JSON.stringify(config), body.project_ids ? JSON.stringify({ project_ids: body.project_ids }) : null],
        );
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "destination.updated", targetType: "destination", targetId: id, details: body, requestId: req.id });
        return { ok: true };
      });
    });

    // Teste de conexão honesto: sem permissão de egress/credencial, informa o bloqueio em vez de simular sucesso.
    app.post("/destinations/:id/test", async (req) => {
      assertPermission(req.auth, req.org, "pixel.configure", { sensitive: true });
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const d = (await c.query("select config from public.conversion_destinations where id = $1", [id])).rows[0];
        if (!d) throw notFound();
        const result = !deps.config.ALLOW_EXTERNAL_DELIVERY
          ? { status: "blocked", message: "Envio externo desabilitado neste ambiente (ALLOW_EXTERNAL_DELIVERY=false). Nenhuma chamada foi feita." }
          : !d.config?.test_event_code
            ? { status: "blocked", message: "Informe o test_event_code do Events Manager para enviar um evento de teste." }
            : { status: "queued", message: "Crie uma venda de teste com a conexão em modo de teste; a entrega aparecerá no painel com o resultado real da API." };
        await c.query("update public.conversion_destinations set last_test_at = now(), last_test_result = $2 where id = $1", [id, JSON.stringify(result)]);
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "destination.test_requested", targetType: "destination", targetId: id, details: result, requestId: req.id });
        return result;
      });
    });
  };
