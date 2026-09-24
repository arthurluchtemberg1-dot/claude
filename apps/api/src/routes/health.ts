import type { FastifyPluginAsync } from "fastify";
import type { AppDeps } from "../context";

export const healthRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.get("/health", async () => ({ ok: true }));
    // Readiness: banco acessível com ambos os papéis.
    app.get("/ready", async (_req, reply) => {
      try {
        await deps.pools.app.query("select 1");
        await deps.pools.system.query("select 1");
        return { ok: true };
      } catch (err) {
        return reply.status(503).send({ ok: false, error: (err as Error).message });
      }
    });
  };
