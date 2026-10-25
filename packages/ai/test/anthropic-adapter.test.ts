import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AI_TOOLS, AiProviderError, buildProvider, createAnthropicProvider } from "../src";

/**
 * Adaptador Anthropic contra um servidor LOCAL que imita a Messages API (nenhuma chamada real): confere o pedido
 * montado pelo SDK oficial (modelo, ferramentas estritas, cache, esforço, fallback por recusa) e a leitura da
 * resposta (texto, tool_use, motivo de parada, uso, modelo servido, recusa) e o mapeamento de erros.
 */

let base = "";
let next: { status: number; body: unknown } = { status: 200, body: {} };
const seen: { url: string; headers: IncomingMessage["headers"]; body: any }[] = [];
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    seen.push({ url: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : null });
    res.writeHead(next.status, { "content-type": "application/json" }).end(JSON.stringify(next.body));
  });
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const message = (over: Record<string, unknown>) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
  ...over,
});

describe("adaptador Anthropic", () => {
  it("monta o pedido com ferramentas estritas, cache, esforço e fallback; lê tool_use e uso", async () => {
    const p = createAnthropicProvider({ apiKey: "sk-ant-teste", model: "claude-opus-5-5", effort: "medium", fallbacks: true, baseURL: base });
    next = { status: 200, body: message({ stop_reason: "tool_use", content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "toolu_1", name: "get_metrics_summary", input: { from: null, to: null, project_ids: null } }] }) };
    const r = await p.turn({ system: "sistema", transcript: [p.userEntry("Quanto vendi?")], tools: AI_TOOLS, maxTokens: 16000 });
    const req = seen.at(-1)!;
    expect(req.url).toMatch(/\/v1\/messages/);
    // O SDK oficial decide o cabeçalho de autenticação (na 1.x: Authorization: Bearer).
    expect(req.headers["x-api-key"] ?? req.headers.authorization).toMatch(/sk-ant-teste$/);
    expect(String(req.headers["anthropic-beta"])).toContain("server-side-fallback-2026-07-01");
    expect(req.body).toMatchObject({ model: "claude-opus-5-5", max_tokens: 16000, fallbacks: "default", output_config: { effort: "medium" } });
    expect(req.body.thinking).toBeUndefined(); // padrão do modelo (adaptativo)
    expect(req.body.tool_choice).toBeUndefined(); // escolha automática (forçar ferramenta não é aceito neste modelo)
    expect(req.body.system).toEqual([{ type: "text", text: "sistema", cache_control: { type: "ephemeral" } }]);
    expect(req.body.tools).toHaveLength(AI_TOOLS.length);
    expect(req.body.tools.every((t: { strict?: boolean; input_schema: { additionalProperties: boolean } }) => t.strict === true && t.input_schema.additionalProperties === false)).toBe(true);
    expect(req.body.tools.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(r).toMatchObject({ stopReason: "tool_use", toolCalls: [{ id: "toolu_1", name: "get_metrics_summary" }], usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 900 }, servedModel: "claude-opus-5-5" });
    // Blocos devolvidos sem alteração (inclusive thinking) para o histórico.
    expect((r.assistantEntry as { content: unknown[] }).content).toHaveLength(2);
    expect(p.toolResultsEntry([{ id: "toolu_1", content: "x", isError: true }])).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "x", is_error: true }] });
  });

  it("recusa com detalhes e modelo de fallback servido", async () => {
    const p = createAnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", effort: null, fallbacks: true, baseURL: base });
    next = { status: 200, body: message({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "não" }, model: "claude-opus-5" }) };
    const r = await p.turn({ system: "s", transcript: [p.userEntry("x")], tools: [], maxTokens: 1000 });
    expect(r).toMatchObject({ stopReason: "refusal", refusal: { category: "cyber", explanation: "não" }, servedModel: "claude-opus-5" });
    expect(seen.at(-1)!.body.output_config).toBeUndefined();
  });

  it("modelo sem fallback não envia o parâmetro; erros tipados viram mensagens claras", async () => {
    const p = createAnthropicProvider({ apiKey: "k", model: "claude-haiku-5-5", effort: "low", fallbacks: true, baseURL: base });
    next = { status: 200, body: message({ content: [{ type: "text", text: "olá" }] }) };
    const r = await p.turn({ system: "s", transcript: [p.userEntry("x")], tools: [], maxTokens: 1000 });
    expect(r.text).toBe("olá");
    expect(seen.at(-1)!.body.fallbacks).toBeUndefined();
    next = { status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } };
    await expect(p.turn({ system: "s", transcript: [p.userEntry("x")], tools: [], maxTokens: 1000 })).rejects.toMatchObject({ kind: "auth" });
    next = { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "bad" } } };
    await expect(p.turn({ system: "s", transcript: [p.userEntry("x")], tools: [], maxTokens: 1000 })).rejects.toBeInstanceOf(AiProviderError);
  });

  it("construção do provedor: chave da organização tem prioridade; provedores sem adaptador ficam indisponíveis", () => {
    const env = { provider: "anthropic" as const, apiKey: "env", model: null, effort: "medium" as const, fallbacks: true };
    expect("provider" in buildProvider(env, { provider: null, model: null, apiKey: null })).toBe(true);
    expect(buildProvider({ ...env, apiKey: null }, { provider: null, model: null, apiKey: null })).toEqual({ unavailable: "Chave de Anthropic (Claude) não configurada" });
    expect(buildProvider(env, { provider: "openai", model: null, apiKey: "k" })).toMatchObject({ unavailable: expect.stringMatching(/não implementado/) });
    expect(buildProvider({ ...env, provider: null }, { provider: null, model: null, apiKey: null })).toMatchObject({ unavailable: expect.stringMatching(/Nenhum provedor/) });
  });
});
