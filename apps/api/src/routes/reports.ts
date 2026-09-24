import { localDateRangeToUtc } from "@tracker/domain";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../context";
import { jsonSafe, orgTx } from "../lib/org-tx";
import { assertPermission, assertProjectAccess } from "../services/auth";
import { computeBreakdown } from "../services/breakdown";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Detalhamento hierárquico de desempenho (campanha → conjunto → anúncio; rede), junção por ID (T39, T46). */
export const reportRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.get("/reports/breakdown", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      const q = z
        .object({
          dimension: z.enum(["campaign", "adset", "ad", "network"]).default("campaign"),
          from: date,
          to: date,
          project_id: z.string().uuid().optional(),
          campaign_id: z.string().trim().min(1).max(64).optional(),
          basis: z.enum(["approval", "financial_movement"]).default("approval"),
          policy: z.string().max(60).default("default"),
          include_test: z.coerce.boolean().default(false),
        })
        .parse(req.query);
      if (q.project_id) assertProjectAccess(req.org!, q.project_id);
      localDateRangeToUtc(q.from, q.to, req.org!.timezone); // valida o intervalo
      return orgTx(deps, req, async (c, { org }) => {
        const scope = {
          organizationId: org.id,
          projectIds: q.project_id ? [q.project_id] : org.projectIds,
          from: q.from,
          to: q.to,
          timezone: org.timezone,
          basis: q.basis,
          asOf: deps.now(),
          includeTest: q.include_test,
          policyKey: q.policy,
          dimension: q.dimension,
          campaignId: q.campaign_id ?? null,
        };
        const groups = await computeBreakdown(c, scope);
        return jsonSafe({
          scope: { dimension: q.dimension, from: q.from, to: q.to, timezone: org.timezone, basis: q.basis, policy: q.policy, campaign_id: q.campaign_id ?? null, include_test: q.include_test },
          groups,
          disclaimer: "Vendas confirmadas pelo checkout e atribuídas pela política selecionada; gasto importado/sincronizado das contas. Junção por ID, nunca por nome.",
        });
      });
    });
  };
