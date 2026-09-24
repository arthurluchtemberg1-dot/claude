import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { AppDeps } from "./context";
import { HttpError, forbidden } from "./lib/errors";
import { maskUrl } from "./lib/logger";
import { loadOrgContext, resolveSession } from "./services/auth";
import { authRoutes } from "./routes/auth";
import { orgRoutes } from "./routes/orgs";
import { ingestRoutes } from "./routes/ingest";
import { connectionRoutes } from "./routes/connections";
import { salesRoutes } from "./routes/sales";
import { metricsRoutes } from "./routes/metrics";
import { reportRoutes } from "./routes/reports";
import { diagnosticsRoutes } from "./routes/diagnostics";
import { destinationRoutes } from "./routes/destinations";
import { costRoutes } from "./routes/costs";
import { utmRoutes } from "./routes/utm";
import { healthRoutes } from "./routes/health";
import { apiManagementRoutes } from "./routes/api-management";
import { publicApi } from "./public/plugin";

/** Rotas públicas sem cookie (CORS aberto, sem credenciais): coleta do SDK e webhooks. */
const PUBLIC_PREFIXES = ["/v1/collect", "/v1/webhooks/", "/sdk/", "/health", "/ready"];
/** API pública por chave: sem cookie/CSRF e SEM CORS (uso servidor a servidor; chave nunca no navegador). */
const PUBLIC_API_PREFIX = "/public/";

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    genReqId: (req) => {
      const h = req.headers["x-request-id"];
      return typeof h === "string" && /^[A-Za-z0-9-]{8,64}$/.test(h) ? h : randomUUID();
    },
    bodyLimit: 256 * 1024,
    trustProxy: true,
    return503OnClosing: true,
  });

  app.decorateRequest("auth", null);
  app.decorateRequest("org", null);

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(cors, {
    delegator: (req, cb) => {
      const url = req.url ?? "";
      if (url.startsWith(PUBLIC_API_PREFIX)) return cb(null, { origin: false });
      if (PUBLIC_PREFIXES.some((p) => url.startsWith(p))) return cb(null, { origin: true, credentials: false, methods: ["GET", "POST"] });
      cb(null, { origin: deps.config.corsOrigins, credentials: true, methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] });
    },
  });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
    const url = req.url;
    if (url.startsWith(PUBLIC_API_PREFIX) || PUBLIC_PREFIXES.some((p) => url.startsWith(p))) return;
    // Proteção CSRF para autenticação por cookie: mutações exigem Origin permitido (R40-03).
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
      const origin = req.headers.origin;
      if (origin && !deps.config.corsOrigins.includes(origin)) throw forbidden("csrf_origin", "Origem não permitida");
    }
    const token = req.cookies[deps.config.SESSION_COOKIE_NAME];
    if (token) req.auth = await resolveSession(deps, token);
    const orgHeader = req.headers["x-org-id"];
    if (req.auth && typeof orgHeader === "string" && orgHeader) {
      req.org = await loadOrgContext(deps, req.auth, orgHeader);
    }
  });

  app.addHook("onResponse", async (req, reply) => {
    deps.logger.info(
      { reqId: req.id, method: req.method, url: maskUrl(req.url), status: reply.statusCode, ms: Math.round(reply.elapsedTime), org: req.org?.id },
      "request",
    );
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details, request_id: req.id } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: { code: "validation_error", message: "Dados inválidos", details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })), request_id: req.id },
      });
    }
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: e.code ?? "bad_request", message: e.message, request_id: req.id } });
    }
    deps.logger.error({ reqId: req.id, err: { message: e.message, code: e.code }, url: maskUrl(req.url) }, "unhandled_error");
    return reply.status(500).send({ error: { code: "internal_error", message: "Erro interno. Use o request_id ao contatar o suporte.", request_id: req.id } });
  });

  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: { code: "not_found", message: "Rota não encontrada", request_id: req.id } }));

  await app.register(healthRoutes(deps));
  await app.register(authRoutes(deps), { prefix: "/v1/auth" });
  await app.register(orgRoutes(deps), { prefix: "/v1" });
  await app.register(connectionRoutes(deps), { prefix: "/v1" });
  await app.register(salesRoutes(deps), { prefix: "/v1" });
  await app.register(metricsRoutes(deps), { prefix: "/v1" });
  await app.register(reportRoutes(deps), { prefix: "/v1" });
  await app.register(diagnosticsRoutes(deps), { prefix: "/v1" });
  await app.register(destinationRoutes(deps), { prefix: "/v1" });
  await app.register(costRoutes(deps), { prefix: "/v1" });
  await app.register(utmRoutes(), { prefix: "/v1" });
  await app.register(apiManagementRoutes(deps), { prefix: "/v1" });
  await app.register(publicApi(deps), { prefix: "/public/v1" });
  await app.register(ingestRoutes(deps));
  return app;
}

export function clientIp(req: FastifyRequest): string {
  return req.ip ?? "0.0.0.0";
}
