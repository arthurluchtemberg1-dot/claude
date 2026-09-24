import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyPluginAsync } from "fastify";
import type { AppDeps } from "../context";
import { collect, collectSchema } from "../services/collect";
import { receiveWebhook } from "../services/ingest-webhook";

/** Rotas públicas de ingestão. O corpo é lido como buffer bruto (autenticação sobre bytes originais, R09-03). */
export const ingestRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 256 * 1024 }, (_req, body, done) => done(null, body));

    app.post(
      "/v1/webhooks/:token",
      { config: { rateLimit: { max: deps.config.WEBHOOK_RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute", keyGenerator: (req) => `${(req.params as { token?: string }).token ?? ""}` } } },
      async (req, reply) => {
        const { token } = req.params as { token: string };
        try {
          const res = await receiveWebhook(deps, {
            token,
            rawBody: (req.body as Buffer | undefined) ?? Buffer.alloc(0),
            headers: req.headers,
            contentType: req.headers["content-type"],
          });
          return reply.status(res.status).send(res.body);
        } catch (err) {
          // Sem persistência durável não confirmamos o recebimento (R09-11): o provedor deve reenviar.
          deps.logger.error({ reqId: req.id, err: (err as Error).message }, "webhook_persist_failed");
          return reply.status(503).send({ error: "temporarily_unavailable" });
        }
      },
    );

    app.post("/v1/collect", { config: { rateLimit: { max: deps.config.COLLECT_RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" } } }, async (req, reply) => {
      const raw = req.body as Buffer | undefined;
      if (!raw || raw.length === 0) return reply.status(400).send({ error: "empty_body" });
      if (raw.length > 64 * 1024) return reply.status(413).send({ error: "payload_too_large" });
      let json: unknown;
      try {
        json = JSON.parse(raw.toString("utf8"));
      } catch {
        return reply.status(400).send({ error: "invalid_json" });
      }
      const parsed = collectSchema.safeParse(json);
      if (!parsed.success) return reply.status(400).send({ error: "invalid_payload", issues: parsed.error.issues.slice(0, 5).map((i) => i.path.join(".")) });
      const res = await collect(deps, parsed.data, { ip: req.ip, userAgent: req.headers["user-agent"] ?? null, origin: typeof req.headers.origin === "string" ? req.headers.origin : null });
      return reply.status(res.status).send(res.body);
    });

    // SDK versionado servido pela API (CDN recomendado em produção; ver docs/SDK.md).
    const here = dirname(fileURLToPath(import.meta.url));
    app.get("/sdk/v1/tracker.js", async (_req, reply) => {
      const candidates = [join(here, "../../../../packages/tracker/dist/tracker.min.js"), join(here, "../sdk/tracker.min.js")];
      const file = candidates.find((f) => existsSync(f));
      if (!file) return reply.status(404).send("// SDK não compilado: execute pnpm sdk:build");
      return reply
        .header("content-type", "application/javascript; charset=utf-8")
        .header("cache-control", "public, max-age=300")
        .header("x-content-type-options", "nosniff")
        .send(readFileSync(file));
    });
  };
