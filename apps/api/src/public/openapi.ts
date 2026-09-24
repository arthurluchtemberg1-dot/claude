/**
 * Documento OpenAPI 3.1 da API pública v1 (R33-01, R33-04). Todo endpoint registrado no plugin precisa constar aqui
 * (verificado em teste). Valores monetários são strings de inteiros na menor unidade da moeda (ex.: "1799" = R$ 17,99).
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const errorResponses = {
  "400": { description: "Parâmetros inválidos", content: { "application/json": { schema: ref("Error") } } },
  "401": { description: "Chave ausente, inválida, revogada ou expirada", content: { "application/json": { schema: ref("Error") } } },
  "403": { description: "Escopo ou projeto não permitido para a chave", content: { "application/json": { schema: ref("Error") } } },
  "429": {
    description: "Limite de requisições excedido",
    headers: { "Retry-After": { schema: { type: "integer" }, description: "Segundos até a próxima janela" } },
    content: { "application/json": { schema: ref("Error") } },
  },
};
const rateHeaders = {
  "RateLimit-Limit": { schema: { type: "integer" } },
  "RateLimit-Remaining": { schema: { type: "integer" } },
  "RateLimit-Reset": { schema: { type: "integer" }, description: "Segundos até a renovação da janela de 1 minuto" },
};
const ok = (schema: object, description = "OK") => ({ description, headers: rateHeaders, content: { "application/json": { schema } } });
const q = (name: string, schema: object, description?: string, required = false) => ({ name, in: "query", required, schema, ...(description ? { description } : {}) });
const dateQ = (name: string) => q(name, { type: "string", format: "date" }, "Data local no fuso da organização (inclusiva)", true);
const money = { type: "string", pattern: "^-?\\d+$", description: "Inteiro na menor unidade da moeda" };
const nullable = (schema: object) => ({ oneOf: [schema, { type: "null" }] });

export function buildOpenApi(serverUrl: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Tracker — API pública",
      version: "1.0.0",
      description:
        "API REST versionada. Mudanças incompatíveis só em nova versão de caminho (/public/v2); descontinuações são anunciadas com os cabeçalhos Deprecation e Sunset com pelo menos 180 dias. " +
        "Chaves sandbox (tk_test_) acessam somente dados de teste e criam vendas de teste. Erros seguem { error: { code, message, details?, request_id } }.",
    },
    servers: [{ url: `${serverUrl.replace(/\/$/, "")}/public/v1` }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "Chave de API: tk_live_… (produção) ou tk_test_… (sandbox)" } },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message", "request_id"],
              properties: { code: { type: "string" }, message: { type: "string" }, details: {}, request_id: { type: "string" } },
            },
          },
        },
        OrderSummary: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            project_id: { type: "string", format: "uuid" },
            provider: { type: "string" },
            external_order_id: { type: "string" },
            parent_order_id: nullable({ type: "string", format: "uuid" }),
            status: { type: "string", enum: ["pending", "failed", "approved", "partially_reversed", "fully_reversed", "reversal_pending_reconciliation"] },
            currency: nullable({ type: "string" }),
            approved_minor: money,
            reversed_minor: money,
            first_approved_at: nullable({ type: "string", format: "date-time" }),
            first_received_at: { type: "string", format: "date-time" },
            payment_method: nullable({ type: "string" }),
            is_test: { type: "boolean" },
            attribution_category: nullable({ type: "string", enum: ["paid", "organic", "direct", "recovery", "unattributed"] }),
            network: nullable({ type: "string" }),
            campaign_id: nullable({ type: "string" }),
            adset_id: nullable({ type: "string" }),
            ad_id: nullable({ type: "string" }),
            utm_source: nullable({ type: "string" }),
            utm_campaign: nullable({ type: "string" }),
          },
        },
        OrderDetail: {
          allOf: [
            ref("OrderSummary"),
            {
              type: "object",
              properties: {
                items: { type: "array", items: { type: "object" } },
                transactions: { type: "array", items: { type: "object", properties: { transaction_key: { type: "string" }, kind: { type: "string" }, status: { type: "string" }, amount_minor: nullable(money), installments: nullable({ type: "integer" }) } } },
                reversals: { type: "array", items: { type: "object" } },
                attributions: { type: "array", items: { type: "object" } },
              },
            },
          ],
        },
        SaleInput: {
          type: "object",
          required: ["project_id", "external_order_id", "amount_minor", "currency", "occurred_at", "reference"],
          properties: {
            project_id: { type: "string", format: "uuid" },
            external_order_id: { type: "string", maxLength: 200 },
            amount_minor: { type: "integer", minimum: 1, description: "Inteiro na menor unidade da moeda" },
            currency: { type: "string", pattern: "^[A-Z]{3}$" },
            occurred_at: { type: "string", format: "date-time" },
            payment_method: { type: "string", enum: ["pix", "boleto", "credit_card", "debit_card", "wallet", "other", "unknown"] },
            reference: { type: "string", maxLength: 300, description: "Comprovante/referência externa" },
            utm_source: { type: "string" },
            utm_medium: { type: "string" },
            utm_campaign: { type: "string" },
          },
        },
        Metric: {
          type: "object",
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            unit: { type: "string", enum: ["money", "count", "ratio", "percent"] },
            status: { type: "string", enum: ["ok", "undefined", "unavailable"] },
            amount_minor: money,
            currency: { type: "string" },
            value: { type: "string", description: "Decimal exato (até 10 casas)" },
            quality: { type: "string", enum: ["complete", "partial", "estimated"] },
            reason: { type: "string" },
            formula: { type: "string" },
            notes: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    paths: {
      "/openapi.json": { get: { summary: "Este documento", security: [], responses: { "200": { description: "OpenAPI 3.1" } } } },
      "/orders": {
        get: {
          summary: "Listar pedidos (sem dados pessoais)",
          description: "Escopo orders:read. Paginação por cursor (next_cursor). Chaves sandbox listam apenas pedidos de teste.",
          parameters: [
            q("limit", { type: "integer", minimum: 1, maximum: 100, default: 50 }),
            q("cursor", { type: "string" }),
            q("project_id", { type: "string", format: "uuid" }),
            q("status", { type: "string" }),
            q("approved_from", { type: "string", format: "date-time" }),
            q("approved_to", { type: "string", format: "date-time" }),
          ],
          responses: { "200": ok({ type: "object", properties: { data: { type: "array", items: ref("OrderSummary") }, next_cursor: nullable({ type: "string" }) } }), ...errorResponses },
        },
      },
      "/orders/{id}": {
        get: {
          summary: "Detalhe do pedido",
          description: "Escopo orders:read. Pedido de outro projeto/ambiente responde 404.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": ok({ type: "object", properties: { data: ref("OrderDetail") } }), "404": { description: "Não encontrado", content: { "application/json": { schema: ref("Error") } } }, ...errorResponses },
        },
      },
      "/sales": {
        post: {
          summary: "Importar venda confirmada fora do checkout",
          description:
            "Escopo orders:write. Exige Idempotency-Key: repetir a mesma chave com o mesmo corpo devolve a resposta original (Idempotent-Replayed: true); com outro corpo, 422. A venda entra como confirmação manual (não do checkout) e é processada de forma assíncrona.",
          parameters: [{ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", maxLength: 200 } }],
          requestBody: { required: true, content: { "application/json": { schema: ref("SaleInput") } } },
          responses: {
            "202": ok({ type: "object", properties: { data: { type: "object", properties: { receipt_id: { type: "string", format: "uuid" }, status: { const: "queued" }, is_test: { type: "boolean" } } } } }, "Aceita para processamento"),
            "409": { description: "Venda com o mesmo external_order_id já existe", content: { "application/json": { schema: ref("Error") } } },
            "422": { description: "Idempotency-Key reutilizada com outro corpo", content: { "application/json": { schema: ref("Error") } } },
            ...errorResponses,
          },
        },
      },
      "/metrics/summary": {
        get: {
          summary: "Métricas do período (mesmo serviço do painel)",
          description: "Escopo metrics:read (somente chaves de produção). Métricas indefinidas/indisponíveis nunca viram zero.",
          parameters: [dateQ("from"), dateQ("to"), q("project_id", { type: "string", format: "uuid" }), q("basis", { type: "string", enum: ["approval", "financial_movement", "acquisition_cohort"] }), q("policy", { type: "string" })],
          responses: { "200": ok({ type: "object", properties: { data: { type: "array", items: { type: "object", properties: { currency: { type: "string" }, metrics: { type: "array", items: ref("Metric") } } } } } }), ...errorResponses },
        },
      },
      "/campaigns": {
        get: {
          summary: "Desempenho por campanha/conjunto/anúncio/rede (junção por ID)",
          description: "Escopo campaigns:read (somente produção). Gasto sem dado importado/sincronizado é indisponível (null), nunca zero.",
          parameters: [
            dateQ("from"),
            dateQ("to"),
            q("dimension", { type: "string", enum: ["campaign", "adset", "ad", "network"] }),
            q("campaign_id", { type: "string" }, "Detalhar anúncios/conjuntos de uma campanha"),
            q("project_id", { type: "string", format: "uuid" }),
            q("policy", { type: "string" }),
          ],
          responses: { "200": ok({ type: "object", properties: { data: { type: "array", items: { type: "object" } } } }), ...errorResponses },
        },
      },
      "/products": {
        get: {
          summary: "Produtos e IDs externos por conta do provedor",
          description: "Escopo products:read. Paginação por cursor.",
          parameters: [q("limit", { type: "integer", minimum: 1, maximum: 100 }), q("cursor", { type: "string" }), q("project_id", { type: "string", format: "uuid" })],
          responses: { "200": ok({ type: "object", properties: { data: { type: "array", items: { type: "object" } }, next_cursor: nullable({ type: "string" }) } }), ...errorResponses },
        },
      },
      "/integrations": {
        get: {
          summary: "Estado das integrações (sem URLs, tokens ou segredos)",
          description: "Escopo integrations:read.",
          responses: { "200": ok({ type: "object", properties: { data: { type: "array", items: { type: "object" } } } }), ...errorResponses },
        },
      },
    },
    "x-webhooks-outbound": {
      description:
        "Webhooks de saída: POST JSON assinado com X-Tracker-Signature: t=<unix>,id=<entrega>,v1=HMAC_SHA256(segredo, `${t}.${id}.${corpo}`) (dois v1 durante rotação). Entrega pelo menos uma vez; deduplique por X-Tracker-Webhook-Id. Eventos: order.approved, order.reversed, order.status_changed.",
    },
  };
}
