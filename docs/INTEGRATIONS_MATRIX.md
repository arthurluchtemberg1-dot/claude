# Matriz de integrações

Estados de implementação (R11-03): Planejado · Em pesquisa · Bloqueado externamente · **Implementado localmente** (código + testes de contrato neste repositório) · Validado em sandbox · Validado em produção · Degradado. O catálogo completo (mais de 100 itens, com estado, documentação consultada e limitações) é servido por `GET /v1/catalog` e exibido em **Integrações** no painel; fonte: `packages/connectors/src/catalog.ts`.

Nenhuma integração está "Validada em sandbox" ou "Validada em produção" nesta data.

## Integrações com implementação

| Integração | Tipo | Estado | Documentação consultada | Capacidades implementadas | Não disponível / hipóteses | Testes |
| --- | --- | --- | --- | --- | --- | --- |
| **Lowify** — webhook nativo de vendas | Checkout | Implementado localmente | `github.com/lowify/docs` commit `b25e43e` (23/09/2026): `internal-webhook.md` v1.0.0 (eventos `sale.pending`, `sale.paid`, header `Idempotency-Key`, payload) e nota de deploy de 26/08/2026 (`sale.refunded` após aprovação do reembolso). Consultado em 24/09/2026. | Recebimento por URL com token opaco (rotação/revogação); idempotência `order_id:event:product_id`; pendente → tentativa sem receita; aprovado → transação `lowify:{order_id}` com valor total `sale_amount`; um item por disparo (bump soma itens sem nova compra); reembolso; UTMs devolvidas como origem declarada; token do SDK num campo UTM configurado; eventos desconhecidos em quarentena | Assinatura (não documentada); moeda (assumida BRL); fuso do `timestamp` (assumido America/Sao_Paulo); reembolso parcial (tratado como integral); API de consulta/conciliação; identificação de upsell/renovação; `click_id`/`campaign_id` são IDs internos da Lowify | `packages/connectors/test/lowify.test.ts`, `apps/api/test/integration/webhook-pipeline.test.ts`, `tracking-attribution.test.ts`, E2E T70 |
| **Sistema próprio** — webhook canônico assinado | Checkout | Implementado localmente | Contrato próprio `packages/contracts` v1.0 ([CANONICAL_WEBHOOK.md](integrations/CANONICAL_WEBHOOK.md)) | HMAC-SHA256 com timestamp (janela 300 s), rotação com segredo anterior por 24 h, `source.event_id` idempotente, aprovado/pendente/falha/cancelado/expirado, reembolso incremental/cumulativo/integral, chargeback (com cobertura de reembolso), disputa ganha, renovação, itens, participação da organização e taxa informadas, token/UTMs | — | `canonical-meta.test.ts`, `webhook-pipeline.test.ts`, `deliveries-relay.test.ts` |
| **Vendas manuais** | Confirmação manual | Implementado localmente | — | `POST /v1/orders/manual` com permissão `sales.write`, referência obrigatória, auditoria; provedor `manual` distinto do checkout | Ajustes/estornos manuais pela interface | `webhook-pipeline.test.ts` |
| **Meta Conversions API** | Destino | Implementado localmente (envio real bloqueado) | Código oficial `facebook-nodejs-business-sdk@24.0.1` (Graph API v24.0), consultado em 24/09/2026. Páginas de deduplicação/parâmetros bloqueadas neste ambiente | Purchase com `event_time` original, `event_id` estável por pedido/transação/ambiente, `em`/`ph` normalizados e SHA-256, `fbp`/`fbc`/IP/UA sem hash e só com consentimento de publicidade, `test_event_code` em modo de teste, emissor responsável, elegibilidade (demo, teste, idade), retry/circuit breaker, painel de entregas | Envio real (DEP-META-APP); coordenação com pixel do navegador (DEP-META-DOCS); `data_processing_options`; métricas de qualidade oficiais | `canonical-meta.test.ts`, `deliveries-relay.test.ts` (servidor local simulando a Graph API) |
| **Meta Ads** — insights | Rede de mídia | Bloqueado externamente | Mesmo SDK oficial (campos de `AdsInsights`, níveis) | Parser de insights diários por nível para `ad_spend_daily` (gasto exato, impressões, cliques no link, alcance bruto) | OAuth, sincronização, entidades, paginação/relatórios assíncronos (DEP-META-APP) | `canonical-meta.test.ts` |
| **Importação CSV de gastos** | Custos | Implementado localmente | — | Prévia com mapeamento de colunas, moeda/fuso da conta, datas BR/ISO, decimais com vírgula, duplicidades no arquivo, substituição de snapshot (não soma), cobertura por conta | — | `webhook-pipeline.test.ts` (fixture e T45) |

## Catálogo sem implementação (resumo)

| Grupo | Integrações | Estado |
| --- | --- | --- |
| Infoprodutos prioritários | Kiwify, Hotmart (Em pesquisa — docs oficiais inacessíveis aqui), Cakto, Kirvano, PerfectPay, Ticto, Eduzz, Braip, Monetizze | Planejado |
| Funis e vendas digitais | Lastlink, Doppus, Greenn, Hubla, Payt, Pepper, Guru, TriboPay, Vega/Vegacheckout, Paradise | Planejado |
| Checkout e e-commerce | Cartpanda, Yampi, Shopify, WooCommerce, Nuvemshop, Adoorei, Logzz | Planejado |
| Pagamentos | Stripe (Em pesquisa), Mercado Pago, Pagar.me, Asaas, PagBank, PayPal, Appmax, BananaPay | Planejado |
| Internacional | ClickBank, Digistore24, BuyGoods, MaxWeb, Everflow, Systeme.io | Planejado |
| Catálogo complementar (lista pública UTMify) | 56 nomes, de MundPay a KitePay | Planejado — identidade/domínio/API não confirmados |
| Redes de mídia | Google Ads, TikTok Ads (Bloqueado externamente), Microsoft, Pinterest, LinkedIn, Snapchat, Kwai, Taboola, Outbrain | Planejado |
| Destinos | TikTok Events API (Bloqueado), Google Ads/Data Manager (Em pesquisa), GA4 MP, Microsoft, Pinterest, Snapchat, LinkedIn, Kwai, Taboola, Outbrain | Planejado |
| CRM | Kommo, HubSpot, Pipedrive, RD Station, Salesforce, Zoho | Planejado |
| Mensageria | WhatsApp Business Platform | Bloqueado externamente |
| Exportação/automação | Google Sheets, Drive, BigQuery, Metabase, Looker Studio, Make, n8n, Zapier | Planejado |

## Como um conector sobe de estado

1. **Em pesquisa → Implementado localmente:** documentação oficial consultada e registrada no manifesto (URL, data, versão), normalização com fixtures documentadas/sintéticas separadas, testes de repetição/estorno/quarentena.
2. **→ Validado em sandbox:** evento de teste real do ambiente de teste do provedor recebido e processado, corpo anonimizado salvo em `packages/connectors/test/fixtures/<provedor>/real-anonymized/`, data registrada em `lastVerifiedSuccess`.
3. **→ Validado em produção:** venda real autorizada processada e conciliada, com evidência e data.
