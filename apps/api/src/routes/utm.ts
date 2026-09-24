import { buildTrackedUrl, findUnexpandedMacros, MACRO_CATALOGS, readUtms } from "@tracker/domain";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

/** Gerador/validador de URLs com UTMs (seção 14) — mesma lógica do domínio usada pela interface. */
export const utmRoutes = (): FastifyPluginAsync => async (app) => {
  app.get("/utm/macros", async () => ({ catalogs: MACRO_CATALOGS }));

  app.post("/utm/build", async (req) => {
    const body = z
      .object({
        base_url: z.string().min(1).max(2000),
        params: z.record(z.string().max(60), z.string().max(500).nullable()),
        keep_existing: z.boolean().default(true),
        protected_params: z.array(z.string().max(60)).max(50).optional(),
      })
      .parse(req.body);
    return buildTrackedUrl({ baseUrl: body.base_url, params: body.params, keepExistingUtms: body.keep_existing, ...(body.protected_params ? { protectedParams: body.protected_params } : {}) });
  });

  app.post("/utm/validate", async (req) => {
    const { url } = z.object({ url: z.string().min(1).max(4000) }).parse(req.body);
    const r = readUtms(url);
    return { ...r, unexpanded_macros: findUnexpandedMacros(url) };
  });
};
