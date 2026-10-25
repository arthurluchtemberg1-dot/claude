import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMetaGraphClient, MetaGraphError, reportedPurchases } from "../src";

/** Cliente Graph API (unitário, fetch falso): autenticação, paginação segura, classificação de erros e escrita sem resposta. */

type Call = { url: URL; init: RequestInit };
function fakeFetch(responses: ((u: URL, init: RequestInit) => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const impl = (async (input: URL | string, init: RequestInit = {}) => {
    const u = new URL(String(input));
    calls.push({ url: u, init });
    const next = responses.shift();
    if (!next) throw new Error("sem resposta configurada");
    return next(u, init);
  }) as typeof fetch;
  return { impl, calls };
}
const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const fail = (status: number, error: Record<string, unknown>) => () => new Response(JSON.stringify({ error }), { status });

describe("cliente Graph API da Meta", () => {
  it("envia token e appsecret_proof (HMAC-SHA256) e usa a versão configurada", async () => {
    const f = fakeFetch([ok({ id: "1", name: "Sistema" })]);
    const g = createMetaGraphClient({ accessToken: "tok", appSecret: "segredo", version: "v26.0", baseUrl: "https://graph.example", fetchImpl: f.impl });
    expect(await g.me()).toEqual({ id: "1", name: "Sistema" });
    const u = f.calls[0]!.url;
    expect(u.pathname).toBe("/v26.0/me");
    expect(u.searchParams.get("access_token")).toBe("tok");
    expect(u.searchParams.get("appsecret_proof")).toBe(createHmac("sha256", "segredo").update("tok").digest("hex"));
  });

  it("segue paging.next só no mesmo host da API", async () => {
    const f = fakeFetch([
      ok({ data: [{ id: "act_1" }], paging: { next: "https://graph.example/v26.0/me/adaccounts?after=X" } }),
      ok({ data: [{ id: "act_2" }], paging: { next: "https://outro-host.example/roubo?after=Y" } }),
    ]);
    const g = createMetaGraphClient({ accessToken: "tok", baseUrl: "https://graph.example", fetchImpl: f.impl });
    expect((await g.adAccounts()).map((a) => a.id)).toEqual(["act_1", "act_2"]);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.url.searchParams.get("access_token")).toBe("tok");
  });

  it("insights: nível, detalhamento diário e intervalo em JSON", async () => {
    const f = fakeFetch([ok({ data: [] })]);
    const g = createMetaGraphClient({ accessToken: "tok", baseUrl: "https://graph.example", fetchImpl: f.impl });
    await g.insights("123", "adset", "2026-10-01", "2026-10-03");
    const u = f.calls[0]!.url;
    expect(u.pathname).toBe("/v26.0/act_123/insights");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ level: "adset", time_increment: "1", time_range: '{"since":"2026-10-01","until":"2026-10-03"}' });
  });

  it("classifica erros: token, permissão, limite de taxa, transitório e inválido", async () => {
    const cases: [Record<string, unknown>, number, string, boolean][] = [
      [{ code: 190, message: "expired" }, 400, "auth", false],
      [{ code: 200, message: "(#200) Requires ads_management" }, 403, "permission", false],
      [{ code: 17, message: "User request limit reached" }, 400, "rate_limit", true],
      [{ code: 80004, message: "too many calls to this ad-account" }, 400, "rate_limit", true],
      [{ code: 2, message: "Service temporarily unavailable", is_transient: true }, 500, "transient", true],
      [{ code: 100, message: "Invalid parameter" }, 400, "invalid", false],
    ];
    for (const [error, status, kind, retryable] of cases) {
      const g = createMetaGraphClient({ accessToken: "tok", baseUrl: "https://graph.example", fetchImpl: fakeFetch([fail(status, error)]).impl });
      const err = await g.me().catch((e) => e);
      expect(err).toBeInstanceOf(MetaGraphError);
      expect([err.kind, err.retryable, err.code]).toEqual([kind, retryable, error.code]);
    }
  });

  it("escrita sem resposta vira resultado desconhecido (reconciliar antes de repetir); leitura vira erro de rede", async () => {
    const boom = () => {
      throw new TypeError("socket hang up");
    };
    const g = createMetaGraphClient({ accessToken: "tok", baseUrl: "https://graph.example", fetchImpl: fakeFetch([boom, boom]).impl });
    expect(await g.update("C1", { status: "PAUSED" }).catch((e) => e.kind)).toBe("unknown_outcome");
    expect(await g.me().catch((e) => e.kind)).toBe("network");
  });

  it("atualização envia JSON no corpo do nó; cópia usa /copies", async () => {
    const f = fakeFetch([ok({ success: true }), ok({ copied_adset_id: "S9" })]);
    const g = createMetaGraphClient({ accessToken: "tok", baseUrl: "https://graph.example", fetchImpl: f.impl });
    await g.update("S1", { daily_budget: "12000" });
    expect([f.calls[0]!.init.method, f.calls[0]!.url.pathname, JSON.parse(String(f.calls[0]!.init.body))]).toEqual(["POST", "/v26.0/S1", { daily_budget: "12000" }]);
    expect(await g.copy("S1", { status_option: "PAUSED", deep_copy: true })).toEqual({ copied_adset_id: "S9" });
    expect(f.calls[1]!.url.pathname).toBe("/v26.0/S1/copies");
  });

  it("compras reportadas: usa 'purchase' e não soma tipos específicos", () => {
    expect(
      reportedPurchases({
        actions: [
          { action_type: "purchase", value: "3" },
          { action_type: "offsite_conversion.fb_pixel_purchase", value: "3" },
        ],
        action_values: [{ action_type: "purchase", value: "591.30" }],
      } as never),
    ).toEqual({ count: "3", value: "591.30" });
    expect(reportedPurchases({} as never)).toEqual({ count: null, value: null });
  });
});
