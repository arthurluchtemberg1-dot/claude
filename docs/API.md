# API pública v1 e webhooks de saída

Contrato: `GET /public/v1/openapi.json` (OpenAPI 3.1, sem autenticação). Uso **servidor a servidor**: a API pública não responde a CORS e a chave nunca deve ir para o navegador.

## Chaves

- Criadas em **API e webhooks** (proprietário/administrador; MFA quando exigido). O valor aparece uma única vez; o servidor guarda só o HMAC e o prefixo.
- Formato: `tk_live_<8>_<40>` (produção) ou `tk_test_<8>_<40>` (**sandbox**).
- Escopos: `orders:read`, `orders:write`, `products:read`, `integrations:read`, `metrics:read`, `campaigns:read`. Sandbox não recebe `metrics:read`/`campaigns:read` (agregam dados de produção).
- Restrição opcional por projeto. Revogação e expiração têm efeito imediato (`401 api_key_revoked` / `api_key_expired`).
- Uso registrado por chave: método, rota modelo (ex.: `/public/v1/orders/:id`), status, latência e `request_id` — sem query string, corpo ou dados pessoais.

```bash
curl -s https://SEU-API/public/v1/orders?limit=20 -H "Authorization: Bearer $TRACKER_API_KEY"
```

## Sandbox

Chaves `tk_test_` só enxergam pedidos de teste e criam vendas de teste (`is_test: true`), que ficam fora das métricas e nunca vão a destinos de produção. Use-as para validar a integração antes de gerar uma chave de produção.

## Limites

Por minuto, por chave (`API_RATE_LIMIT_PER_KEY`, padrão 120) e por organização (`API_RATE_LIMIT_PER_ORG`, padrão 600). Toda resposta autenticada traz `RateLimit-Limit`, `RateLimit-Remaining` e `RateLimit-Reset`; o excesso responde `429 rate_limited` com `Retry-After`.

## Erros

Sempre `{"error": {"code", "message", "details"?, "request_id"}}`. Códigos: `invalid_api_key`, `api_key_revoked`, `api_key_expired`, `insufficient_scope`, `project_forbidden`, `validation_error`, `invalid_cursor`, `idempotency_key_required`, `idempotency_key_reused` (422), `duplicate` (409), `rate_limited` (429), `not_found`, `internal_error`. Informe o `request_id` ao suporte.

## Recursos

| Método e caminho | Escopo | Observação |
| --- | --- | --- |
| `GET /orders` | `orders:read` | Cursor (`next_cursor`), filtros `status`, `project_id`, `approved_from/to`. Sem dados pessoais |
| `GET /orders/{id}` | `orders:read` | Itens, transações (parcelas), reversões e atribuições atuais |
| `POST /sales` | `orders:write` | Venda confirmada fora do checkout. **Exige `Idempotency-Key`**. Resposta 202 (processamento assíncrono) |
| `GET /metrics/summary` | `metrics:read` | Mesmo serviço do painel; métricas indefinidas/indisponíveis nunca viram zero |
| `GET /campaigns` | `campaigns:read` | Campanha/conjunto/anúncio/rede por ID; gasto ausente = `null` |
| `GET /products` | `products:read` | IDs externos por conta do provedor |
| `GET /integrations` | `integrations:read` | Estado sem URLs, tokens ou segredos |

Valores monetários são strings de inteiros na menor unidade (`"1799"` = R$ 17,99).

### Idempotency-Key (`POST /sales`)

Mesma chave + mesmo corpo → a resposta original é devolvida com `Idempotent-Replayed: true` (inclusive um `409`). Mesma chave + corpo diferente → `422 idempotency_key_reused`. Chaves valem 24 h por chave de API.

```bash
curl -s -X POST https://SEU-API/public/v1/sales \
  -H "Authorization: Bearer $TRACKER_API_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: pedido-9981" \
  -d '{"project_id":"…","external_order_id":"9981","amount_minor":4990,"currency":"BRL","occurred_at":"2026-09-12T10:00:00-03:00","reference":"NF 123","payment_method":"pix"}'
```

## Versionamento e descontinuação

Caminho versionado (`/public/v1`). Adições compatíveis (campos novos, endpoints novos) podem ocorrer na mesma versão; clientes devem ignorar campos desconhecidos. Mudanças incompatíveis só em `/public/v2`. Descontinuações são anunciadas com os cabeçalhos `Deprecation` e `Sunset` e com pelo menos 180 dias de antecedência.

## Webhooks de saída

- Eventos: `order.approved` (por transação aprovada pela primeira vez), `order.reversed` (por lançamento de estorno/chargeback), `order.status_changed`. Payload sem dados pessoais: IDs, valores, status e atribuição atual (`null` se ainda não calculada).
- Cadastro recusa destinos em rede privada, loopback, link-local/metadata, CGNAT, multicast, esquemas diferentes de http/https, credenciais na URL e o próprio Tracker. A resolução DNS é validada **no momento da conexão** e a cada redirecionamento (até 3; só 307/308 são seguidos). Tempo e tamanho de resposta limitados.
- A assinatura nasce **pausada**; a ativação exige que o destino responda 2xx a um `test.ping` assinado.
- Entrega **pelo menos uma vez**: deduplique por `X-Tracker-Webhook-Id` (estável entre tentativas). Falhas: novas tentativas em ~1 min, 5 min, 30 min, 2 h, 6 h, 12 h e 24 h; depois a entrega vai para a fila de falhas e pode ser reenviada manualmente.
- Cabeçalhos: `X-Tracker-Signature: t=<unix>,id=<entrega>,v1=<hex>[,v1=<hex>]`, `X-Tracker-Webhook-Id`, `X-Tracker-Event`, `X-Tracker-Hop`.
- `v1 = HMAC_SHA256(segredo, "<t>.<id>.<corpo bruto>")`. Após rotacionar o segredo, por 24 h cada entrega leva duas assinaturas (novo e anterior).
- Loops: o contador `X-Tracker-Hop` é propagado; entradas com salto acima de 3 são recusadas (`508`) e eventos originados no limite não são reemitidos.

Verificação (Node.js; mesma lógica de `verifyOutbound` em `packages/connectors/src/outbound/signature.ts`, coberta por testes):

```js
import { createHmac, timingSafeEqual } from "node:crypto";
export function verify(header, rawBody, secret, toleranceSeconds = 300) {
  const parts = Object.groupBy(header.split(",").map((kv) => kv.split("=", 2)), ([k]) => k);
  const t = Number(parts.t?.[0]?.[1]);
  const id = parts.id?.[0]?.[1];
  if (!t || !id || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${id}.${rawBody}`).digest();
  return (parts.v1 ?? []).some(([, v]) => /^[0-9a-f]{64}$/.test(v) && timingSafeEqual(expected, Buffer.from(v, "hex")));
}
```
