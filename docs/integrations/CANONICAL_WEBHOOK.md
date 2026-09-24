# Webhook canônico assinado (sistema próprio)

Contrato **próprio** do Tracker (não é formato de nenhum checkout). Schema: `packages/contracts/src/canonical-event.ts`.

## Endpoint e autenticação

- Crie uma conexão **Sistema próprio** em Integrações. São exibidos uma única vez: a URL `…/v1/webhooks/whk_…` e o segredo `whsec_…`.
- Envie `POST` com `Content-Type: application/json` e o cabeçalho:

```
X-Tracker-Signature: t=<unix_segundos>,v1=<hex(HMAC_SHA256(segredo, "<t>." + corpo_bruto))>
```

- A assinatura é verificada sobre os bytes exatos enviados; janela de ±300 s. Durante rotação (`POST /v1/connections/:id/rotate-secret`) o segredo anterior é aceito por 24 h.
- Respostas: `200 {received, duplicate, receipt_id}` após persistência; `401` assinatura inválida; `404` endpoint desconhecido/revogado; `410` conexão desativada; `415` tipo de conteúdo; `503` indisponível (reenvie).

Exemplo (Node.js):

```js
import { createHmac } from "node:crypto";
const body = JSON.stringify(evento);
const t = Math.floor(Date.now() / 1000);
const sig = createHmac("sha256", process.env.TRACKER_WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex");
await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-tracker-signature": `t=${t},v1=${sig}` }, body });
```

## Recebíveis e liquidações (repasses)

`settlement.scheduled` (recebível previsto), `settlement.paid` (liquidado/repassado) e `settlement.canceled` exigem `order` (pedido e transação a que se referem) e `settlement`. São registrados para conciliação e exibidos no detalhe da venda, **sem** gerar venda, receita, lançamento no razão ou evento de conversão. Cada estágio de um `external_settlement_id` é registrado uma vez (reenvios não duplicam). Parcelas de cartão devem ser enviadas assim — nunca como novas `payment.approved` com outro `external_transaction_id`.

## Idempotência

`source.event_id` identifica o evento semântico: reenvios do mesmo ID não geram novo efeito (contados em `delivery_count`). A transação é identificada por `order.external_transaction_id` (ou `order:{external_order_id}`); dois IDs de evento para a mesma cobrança não duplicam receita.

## Campos

| Campo | Obrigatório | Observação |
| --- | --- | --- |
| `schema_version` | sim | `"1.0"` |
| `source.event_id` | sim | ID estável do evento na origem |
| `event_type` | sim | `payment.pending`, `payment.approved`, `payment.failed`, `payment.canceled`, `payment.expired`, `refund.succeeded`, `chargeback.confirmed`, `dispute.won`, `subscription.renewed` (efeito financeiro); `refund.created`, `dispute.opened`, etc. são registrados sem efeito |
| `occurred_at` | sim | ISO 8601 com offset — data real do evento na origem |
| `order.external_order_id` | sim (eventos de pagamento) | |
| `order.currency` | sim | ISO 4217 |
| `order.amount_minor` | sim em `payment.approved` | inteiro na menor unidade (ex.: 1799 = R$ 17,99). Aprovação sem valor vai para quarentena |
| `order.transaction_kind` | não | `initial`, `upsell`, `downsell`, `renewal`, `manual` |
| `order.parent_order_id` | não | Pedido original de um upsell/downsell com **outra** transação. Vincula somente pedidos da mesma conexão/conta e projeto; se o original ainda não chegou, o vínculo é feito quando ele chegar. Nunca é inferido por e-mail |
| `order.installments` | não | Número de parcelas no cartão (1–99). Informativo: a receita é o valor aprovado, uma única vez |
| `order.org_share_minor`, `order.fee_minor` | não | Participação da organização e taxa efetiva informadas pela origem |
| `order.items[]` | não | `external_product_id`, `name`, `item_type`, `unit_amount_minor`, `quantity` |
| `refund` | em `refund.succeeded` | `external_refund_id`, `amount_minor`, `semantics` (`incremental` \| `cumulative` \| `full`) |
| `dispute` | em chargeback/disputa | `external_dispute_id`, `amount_minor`, `covers_refund_id` (quando o chargeback cobre um reembolso já registrado) |
| `settlement` | em `settlement.*` | `external_settlement_id`, `net_amount_minor` (obrigatório), `gross_amount_minor`, `fee_minor`, `installment_number`, `installment_count`, `expected_at`, `anticipated` |
| `attribution` | não | `tracking_token` (do SDK), `utm_*`, `campaign_id`/`adset_id`/`ad_id`, `fbclid`, `gclid` — dados declaratórios |
| `customer` | não | `email`, `phone`, `name` — armazenados em estrutura restrita |
| `organization_id` | — | **Ignorado**: a organização é determinada pela conexão |

Eventos inválidos ficam em quarentena (Diagnóstico → Recebimentos) sem efeito financeiro e podem ser reprocessados após correção.
