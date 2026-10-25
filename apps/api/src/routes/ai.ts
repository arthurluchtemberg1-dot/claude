import { AI_PROVIDERS, aiLimits, buildProvider, isAiProviderId, type AiProviderId } from "@tracker/ai";
import { localDateOf } from "@tracker/domain";
import type { PoolClient } from "@tracker/db";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDeps, OrgInfo } from "../context";
import { badRequest, conflict, HttpError, notFound } from "../lib/errors";
import { audit, orgSystemTx, orgTx } from "../lib/org-tx";
import { assertPermission } from "../services/auth";
import { loadCredential, storeCredential } from "../services/credentials";

/**
 * Gestor IA (R27). Perguntas viram trabalho do worker (o laço com o provedor pode levar dezenas de segundos);
 * o painel acompanha pela conversa. Ligar a IA e cadastrar chave própria são decisões do proprietário (dados
 * agregados da organização vão ao provedor escolhido) e exigem MFA quando obrigatório.
 */

const MAX_RUNNING_PER_ORG = 3;

async function availability(deps: AppDeps, c: PoolClient, org: OrgInfo) {
  const s = (await c.query("select settings->'ai' as ai from public.organizations where id = $1", [org.id])).rows[0]?.ai ?? {};
  const hasOrgKey = Boolean((await c.query("select 1 from private.credentials where organization_id = $1 and purpose = 'ai_api_key' and revoked_at is null and rotated_at is null limit 1", [org.id])).rows[0]);
  const provider: AiProviderId | null = isAiProviderId(s.provider) ? s.provider : deps.config.ai.provider;
  const env = deps.config.ai;
  let reason: string | null = null;
  if (!provider) reason = "Nenhum provedor de IA configurado (AI_PROVIDER/AI_API_KEY no servidor ou chave própria da organização)";
  else if (AI_PROVIDERS[provider].availability !== "active") reason = `${AI_PROVIDERS[provider].label}: ${AI_PROVIDERS[provider].reason}`;
  else if (!hasOrgKey && !(env.provider === provider && env.apiKey)) reason = `Chave de ${AI_PROVIDERS[provider].label} não configurada`;
  else if (!s.enabled) reason = "Gestor IA desligado nesta organização (o proprietário liga em Configurações da IA)";
  const model = (typeof s.model === "string" && s.model) || (env.provider === provider ? env.model : null) || (provider ? AI_PROVIDERS[provider].defaultModel : null);
  return { available: reason === null, reason, provider, model, enabled: Boolean(s.enabled), has_org_key: hasOrgKey, settings: s, limits: aiLimits(s) };
}

export const aiRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.get("/ai/status", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      return orgSystemTx(deps, req, async (c, { org }) => {
        const a = await availability(deps, c, org);
        const usage = (await c.query("select requests, input_tokens, output_tokens from public.ai_usage_daily where organization_id = $1 and day = $2", [org.id, localDateOf(deps.now(), org.timezone)])).rows[0] ?? { requests: 0, input_tokens: 0, output_tokens: 0 };
        return {
          available: a.available,
          reason: a.reason,
          provider: a.provider,
          model: a.model,
          enabled: a.enabled,
          has_org_key: a.has_org_key,
          limits: a.limits,
          usage_today: { requests: Number(usage.requests), input_tokens: Number(usage.input_tokens), output_tokens: Number(usage.output_tokens) },
          providers: Object.entries(AI_PROVIDERS).map(([id, p]) => ({ id, ...p })),
          modes: [
            { key: "analysis", label: "Análise", availability: "active" },
            { key: "suggestion", label: "Sugestão de regra (simulada, sem salvar)", availability: "active" },
            { key: "execution", label: "Execução sob política", availability: "planned", reason: "A IA não executa ações; regras ativadas por pessoas executam com as travas do motor de regras" },
          ],
          privacy: "Vão ao provedor apenas agregados, IDs e nomes de campanhas/produtos; nunca nome, e-mail ou telefone de compradores.",
        };
      });
    });

    app.put("/ai/settings", async (req) => {
      assertPermission(req.auth, req.org, "org.manage", { sensitive: true });
      const b = z
        .object({
          enabled: z.boolean(),
          provider: z.enum(["anthropic", "openai", "google"]).nullable().default(null),
          model: z.string().trim().max(80).regex(/^[a-zA-Z0-9._:@-]*$/).nullable().default(null),
          daily_requests: z.number().int().min(1).max(10_000).optional(),
          daily_output_tokens: z.number().int().min(1000).max(50_000_000).optional(),
          max_tool_rounds: z.number().int().min(1).max(20).optional(),
        })
        .strict()
        .parse(req.body);
      if (b.provider && AI_PROVIDERS[b.provider].availability !== "active") throw badRequest("provider_unavailable", `${AI_PROVIDERS[b.provider].label}: ${AI_PROVIDERS[b.provider].reason}`);
      return orgTx(deps, req, async (c, { auth, org }) => {
        await c.query("update public.organizations set settings = jsonb_set(settings, '{ai}', $2::jsonb) where id = $1", [org.id, JSON.stringify({ ...b, model: b.model || null })]);
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "ai.settings_updated", details: { enabled: b.enabled, provider: b.provider, model: b.model }, requestId: req.id });
        return { ok: true };
      });
    });

    // Chave própria: gravada cifrada, nunca devolvida; só o worker a lê para chamar o provedor.
    app.put("/ai/key", async (req) => {
      assertPermission(req.auth, req.org, "org.manage", { sensitive: true });
      const b = z.object({ api_key: z.string().trim().min(20).max(300).regex(/^[\x21-\x7e]+$/) }).strict().parse(req.body);
      return orgSystemTx(deps, req, async (c, { auth, org }) => {
        await storeCredential(c, deps.config, { organizationId: org.id, connectionId: null, purpose: "ai_api_key", value: b.api_key });
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "ai.key_stored", requestId: req.id });
        return { ok: true, has_org_key: true };
      });
    });

    app.delete("/ai/key", async (req) => {
      assertPermission(req.auth, req.org, "org.manage", { sensitive: true });
      return orgSystemTx(deps, req, async (c, { auth, org }) => {
        await c.query("update private.credentials set revoked_at = now() where organization_id = $1 and purpose = 'ai_api_key' and revoked_at is null", [org.id]);
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "ai.key_revoked", requestId: req.id });
        return { ok: true, has_org_key: false };
      });
    });

    // Teste explícito de chave e modelo junto ao provedor (única chamada externa feita pela API).
    app.post("/ai/test", async (req) => {
      assertPermission(req.auth, req.org, "org.manage");
      const prep = await orgSystemTx(deps, req, async (c, { org }) => {
        const a = await availability(deps, c, org);
        const key = (await loadCredential(c, deps.config, { organizationId: org.id, connectionId: null, purpose: "ai_api_key" })).current;
        return { a, key };
      });
      const built = buildProvider(deps.config.ai, { provider: isAiProviderId(prep.a.settings.provider) ? prep.a.settings.provider : null, model: prep.a.settings.model ?? null, apiKey: prep.key });
      if ("unavailable" in built) return { ok: false, error: built.unavailable };
      if (!deps.config.ALLOW_EXTERNAL_DELIVERY) return { ok: false, error: "Chamadas externas desligadas neste ambiente (ALLOW_EXTERNAL_DELIVERY=false)" };
      return built.provider.check();
    });

    app.get("/ai/conversations", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      return orgTx(deps, req, async (c) => ({
        conversations: (await c.query("select id, title, status, provider, model, created_at, updated_at from public.ai_conversations order by updated_at desc limit 50")).rows,
      }));
    });

    const ask = async (req: FastifyRequest, existing: string | null, reply: FastifyReply) => {
      assertPermission(req.auth, req.org, "metrics.read");
      const b = z.object({ question: z.string().trim().min(2).max(4000) }).strict().parse(req.body);
      return orgSystemTx(deps, req, async (c, { auth, org }) => {
        const a = await availability(deps, c, org);
        // Sem provedor/chave: estado indisponível explícito; nada é simulado (R27-10).
        if (!a.available) throw new HttpError(409, "ai_unavailable", a.reason!);
        const running = (await c.query("select count(*)::int as n from public.ai_conversations where organization_id = $1 and status = 'running'", [org.id])).rows[0].n;
        if (running >= MAX_RUNNING_PER_ORG) throw new HttpError(429, "ai_busy", "Muitas análises em andamento nesta organização; aguarde alguns segundos");
        let id = existing;
        if (id) {
          const conv = (await c.query("select status from public.ai_conversations where organization_id = $1 and id = $2 and user_id = $3 for update", [org.id, id, auth.userId])).rows[0];
          if (!conv) throw notFound("Conversa não encontrada");
          if (conv.status === "running") throw conflict("ai_running", "Aguarde a resposta anterior ou cancele");
          await c.query("update public.ai_conversations set status = 'running', cancel_requested = false, updated_at = now() where id = $1", [id]);
        } else {
          id = (await c.query("insert into public.ai_conversations (organization_id, user_id, title, status) values ($1, $2, $3, 'running') returning id", [org.id, auth.userId, b.question.slice(0, 80)])).rows[0].id as string;
        }
        const m = (await c.query("insert into public.ai_messages (organization_id, conversation_id, role, status, content) values ($1, $2, 'user', 'pending', $3) returning id", [org.id, id, b.question])).rows[0];
        await c.query("insert into public.outbox (organization_id, topic, payload, dedup_key, priority, max_attempts) values ($1, 'ai.run', $2, $3, 4, 2)", [org.id, JSON.stringify({ conversation_id: id }), `ai:${id}:${m.id}`]);
        reply.status(202);
        return { conversation_id: id, message_id: Number(m.id) };
      });
    };

    app.post("/ai/conversations", async (req, reply) => ask(req, null, reply));
    app.post("/ai/conversations/:id/messages", async (req, reply) => ask(req, z.object({ id: z.string().uuid() }).parse(req.params).id, reply));

    app.get("/ai/conversations/:id", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return orgTx(deps, req, async (c) => {
        const conv = (await c.query("select id, title, status, provider, model, created_at, updated_at from public.ai_conversations where id = $1", [id])).rows[0];
        if (!conv) throw notFound("Conversa não encontrada");
        const messages = (await c.query("select id, role, status, content, error, sources, attachments, model, usage, created_at, completed_at from public.ai_messages where conversation_id = $1 order by id", [id])).rows;
        return { conversation: conv, messages: messages.map((m) => ({ ...m, id: Number(m.id) })) };
      });
    });

    app.post("/ai/conversations/:id/cancel", async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return orgTx(deps, req, async (c) => {
        const r = await c.query("update public.ai_conversations set cancel_requested = true where id = $1 and status = 'running'", [id]);
        return { ok: true, requested: (r.rowCount ?? 0) > 0 };
      });
    });

    app.delete("/ai/conversations/:id", async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return orgTx(deps, req, async (c) => {
        const r = await c.query("delete from public.ai_conversations where id = $1", [id]);
        if (!r.rowCount) throw notFound("Conversa não encontrada");
        return { ok: true };
      });
    });

    // Auditoria (R27-08): proprietário vê todas as consultas da organização; demais membros, as próprias.
    app.get("/ai/audit", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      return orgSystemTx(deps, req, async (c, { auth, org }) => ({
        tool_calls: (
          await c.query(
            `select t.id, t.conversation_id, t.tool, t.input, t.ok, t.result_bytes, t.duration_ms, t.created_at, u.email as user_email
               from public.ai_tool_calls t join public.ai_conversations cv on cv.organization_id = t.organization_id and cv.id = t.conversation_id
               join iam.users u on u.id = cv.user_id
              where t.organization_id = $1 and ($2::boolean or cv.user_id = $3) order by t.id desc limit 200`,
            [org.id, org.permissions.has("org.manage"), auth.userId],
          )
        ).rows.map((r) => ({ ...r, id: Number(r.id) })),
      }));
    });
  };
