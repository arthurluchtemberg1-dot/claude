import Anthropic from "@anthropic-ai/sdk";

/**
 * Provedores de IA intercambiáveis (R27-02). Cada adaptador traduz uma rodada (sistema + histórico + ferramentas)
 * para a API oficial do provedor e devolve um formato neutro. O histórico é guardado no formato do provedor que o
 * produziu (blocos devolvidos sem alteração — exigência do raciocínio preservado); trocar de provedor inicia um
 * novo contexto.
 *
 * Só há adaptador para provedores cuja documentação oficial foi verificada (Anthropic, via SDK oficial). OpenAI e
 * Google aparecem como "planejados" com o motivo — nunca simulamos uma análise sem provedor real (R27-10).
 */

export type AiProviderId = "anthropic" | "openai" | "google";

export const AI_PROVIDERS: Record<AiProviderId, { label: string; availability: "active" | "planned"; reason: string | null; defaultModel: string | null }> = {
  anthropic: { label: "Anthropic (Claude)", availability: "active", reason: null, defaultModel: "claude-opus-5-5" },
  openai: { label: "OpenAI", availability: "planned", reason: "Adaptador ainda não implementado: documentação oficial não verificada neste ambiente (DEP-AI)", defaultModel: null },
  google: { label: "Google (Gemini)", availability: "planned", reason: "Adaptador ainda não implementado: documentação oficial não verificada neste ambiente (DEP-AI)", defaultModel: null },
};

export function isAiProviderId(v: unknown): v is AiProviderId {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(AI_PROVIDERS, v);
}

export interface AiToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Esquema estrito (argumentos sempre válidos para o esquema). */
  strict: boolean;
}

export interface AiToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type AiStopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "pause_turn" | "other";

export interface AiTurnResult {
  stopReason: AiStopReason;
  text: string;
  toolCalls: AiToolCall[];
  /** Entrada do histórico a anexar exatamente como veio (formato do provedor). */
  assistantEntry: unknown;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  /** Modelo que efetivamente respondeu (pode diferir em caso de fallback). */
  servedModel: string;
  refusal: { category: string | null; explanation: string | null } | null;
}

export interface AiTurnParams {
  system: string;
  transcript: unknown[];
  tools: AiToolSpec[];
  maxTokens: number;
}

export interface AiProvider {
  id: AiProviderId;
  model: string;
  turn(params: AiTurnParams): Promise<AiTurnResult>;
  userEntry(text: string): unknown;
  toolResultsEntry(results: { id: string; content: string; isError: boolean }[]): unknown;
  /** Verifica chave e modelo junto ao provedor (botão "testar"). */
  check(): Promise<{ ok: true; model: string; displayName: string | null } | { ok: false; error: string }>;
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly kind: "auth" | "rate_limit" | "invalid_request" | "unavailable" | "network" | "other",
  ) {
    super(message);
  }
}

/** Modelos em que a recuperação automática do servidor após recusa ("fallbacks": "default") é aceita. */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-fable-5-1", "claude-opus-5", "claude-sonnet-5-5"]);

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  /** Esforço de raciocínio; null = padrão do modelo. */
  effort: "low" | "medium" | "high" | "xhigh" | "max" | null;
  fallbacks: boolean;
  timeoutMs?: number;
  baseURL?: string;
}

function mapAnthropicError(err: unknown): AiProviderError {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return new AiProviderError("Chave do provedor de IA inválida ou sem permissão", false, "auth");
  if (err instanceof Anthropic.RateLimitError) return new AiProviderError("Limite de uso do provedor de IA atingido; tente mais tarde", true, "rate_limit");
  if (err instanceof Anthropic.NotFoundError) return new AiProviderError("Modelo de IA não encontrado para esta chave (verifique AI_MODEL)", false, "invalid_request");
  if (err instanceof Anthropic.BadRequestError) return new AiProviderError(`Pedido recusado pelo provedor de IA: ${err.message}`.slice(0, 300), false, "invalid_request");
  if (err instanceof Anthropic.APIConnectionError) return new AiProviderError("Sem conexão com o provedor de IA", true, "network");
  if (err instanceof Anthropic.APIError) return new AiProviderError(`Provedor de IA indisponível (HTTP ${err.status ?? "?"})`, (err.status ?? 500) >= 500, "unavailable");
  return new AiProviderError((err as Error).message ?? "Falha no provedor de IA", false, "other");
}

export function createAnthropicProvider(opts: AnthropicOptions): AiProvider {
  const client = new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 120_000, maxRetries: 2, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) });
  const useFallbacks = opts.fallbacks && FALLBACK_MODELS.has(opts.model);
  return {
    id: "anthropic",
    model: opts.model,
    async turn(p) {
      const tools: Anthropic.Beta.BetaTool[] = p.tools.map((t, i) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
        ...(t.strict ? { strict: true } : {}),
        // Ferramentas e sistema são estáveis: cache do prefixo entre rodadas e perguntas.
        ...(i === p.tools.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
      }));
      let res: Anthropic.Beta.BetaMessage;
      try {
        res = await client.beta.messages.create({
          model: opts.model,
          max_tokens: p.maxTokens,
          system: [{ type: "text", text: p.system, cache_control: { type: "ephemeral" } }],
          tools,
          messages: p.transcript as Anthropic.Beta.BetaMessageParam[],
          ...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
          ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        });
      } catch (err) {
        throw mapAnthropicError(err);
      }
      const text = res.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      const toolCalls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input }));
      const sr = res.stop_reason;
      const stopReason: AiStopReason = sr === "end_turn" || sr === "tool_use" || sr === "max_tokens" || sr === "refusal" || sr === "pause_turn" ? sr : "other";
      const details = sr === "refusal" ? (res.stop_details ?? null) : null;
      return {
        stopReason,
        text,
        toolCalls,
        assistantEntry: { role: "assistant", content: res.content },
        usage: { inputTokens: res.usage.input_tokens ?? 0, outputTokens: res.usage.output_tokens ?? 0, cacheReadTokens: res.usage.cache_read_input_tokens ?? 0 },
        servedModel: res.model,
        refusal: details ? { category: details.category ?? null, explanation: details.explanation ?? null } : stopReason === "refusal" ? { category: null, explanation: null } : null,
      };
    },
    userEntry(text) {
      return { role: "user", content: text } satisfies Anthropic.Beta.BetaMessageParam;
    },
    toolResultsEntry(results) {
      return {
        role: "user",
        content: results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })),
      } satisfies Anthropic.Beta.BetaMessageParam;
    },
    async check() {
      try {
        const m = await client.models.retrieve(opts.model);
        return { ok: true, model: m.id, displayName: m.display_name ?? null };
      } catch (err) {
        return { ok: false, error: mapAnthropicError(err).message };
      }
    },
  };
}

export interface AiEnvConfig {
  provider: AiProviderId | null;
  apiKey: string | null;
  model: string | null;
  effort: AnthropicOptions["effort"];
  fallbacks: boolean;
}

export function aiConfigFromEnv(env: Record<string, string | undefined>): AiEnvConfig {
  const p = (env.AI_PROVIDER ?? "none").trim().toLowerCase();
  const effort = (env.AI_EFFORT ?? "medium").trim().toLowerCase();
  return {
    provider: isAiProviderId(p) ? p : null,
    apiKey: env.AI_API_KEY?.trim() || null,
    model: env.AI_MODEL?.trim() || null,
    effort: (["low", "medium", "high", "xhigh", "max"] as const).find((e) => e === effort) ?? null,
    fallbacks: (env.AI_FALLBACKS ?? "default") !== "off",
  };
}

/** Monta o provedor para uma organização: chave própria da organização tem prioridade sobre a do ambiente. */
export function buildProvider(env: AiEnvConfig, org: { provider: AiProviderId | null; model: string | null; apiKey: string | null }): { provider: AiProvider } | { unavailable: string } {
  const providerId = org.provider ?? env.provider;
  if (!providerId) return { unavailable: "Nenhum provedor de IA configurado (AI_PROVIDER/AI_API_KEY ou chave própria da organização)" };
  const def = AI_PROVIDERS[providerId];
  if (def.availability !== "active") return { unavailable: `${def.label}: ${def.reason}` };
  const apiKey = org.apiKey ?? (env.provider === providerId ? env.apiKey : null);
  if (!apiKey) return { unavailable: `Chave de ${def.label} não configurada` };
  const model = org.model ?? (env.provider === providerId ? env.model : null) ?? def.defaultModel;
  if (!model) return { unavailable: "Modelo de IA não definido (AI_MODEL)" };
  return { provider: createAnthropicProvider({ apiKey, model, effort: env.effort, fallbacks: env.fallbacks }) };
}
