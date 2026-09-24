# Arquitetura

Estado em 24/09/2026. Decisões e alternativas: [`DECISIONS.md`](DECISIONS.md).

## Visão geral

```
 Navegador do visitante                     Checkout (Lowify / sistema próprio)
  └─ SDK packages/tracker ──POST /v1/collect──┐        │ POST /v1/webhooks/{token opaco}
                                              ▼        ▼
 Painel (apps/web, Next.js) ──/api/* rewrite──▶ API (apps/api, Fastify)
                                                 │  valida, autentica, persiste recebimento + outbox (1 transação)
                                                 ▼
                                   PostgreSQL (RLS por organização) ◀──────────────┐
                                                 │ outbox (fonte de verdade do trabalho)│
                                                 ▼                                     │
                                   Relay (apps/worker) ──IDs──▶ Redis/BullMQ ──▶ Worker handlers
                                                                   receipt.process → agregado financeiro (domínio)
                                                                   attribution.compute → motor de atribuição
                                                                   destinations.fanout → entregas idempotentes
                                                                   delivery.send → Meta CAPI (desligado por padrão)
```

## Componentes

| Caminho | Responsabilidade |
| --- | --- |
| `packages/domain` | Regras puras e compartilhadas: dinheiro exato (`bigint`), fuso/intervalos `[início, fim)`, agregado financeiro do pedido (transações, reversões, razão idempotente), registro e cálculo de métricas, classificação de toques e motor de atribuição, UTMs/macros, sanitização de URL, permissões. Sem I/O. |
| `packages/contracts` | Contrato canônico de evento v1.0 (Zod). |
| `packages/connectors` | Interfaces tipadas (`CheckoutConnector`, `AdNetworkConnector`, `ConversionDestination`, …), manifestos de capacidade, catálogo completo com estado real, conectores Lowify e sistema próprio, destino Meta CAPI, parser de insights Meta. |
| `packages/db` | Migrações SQL (checksum, lock consultivo), pools por papel, `withTx` com contexto RLS, `inSequence`. |
| `packages/tracker` | SDK de navegador sem dependências (IIFE, orçamento de 6 KiB gzip). |
| `apps/api` | Fastify 5: autenticação, organizações, conexões, ingestão pública (webhooks e coleta), vendas, métricas, diagnóstico, destinos, custos, UTMs. |
| `apps/worker` | Processo persistente: relay outbox→BullMQ, consumidor, handlers, health/readiness, encerramento gracioso. |
| `apps/web` | Next.js 16 (App Router) + React 19 + Tailwind 4; painel consome somente a API (mesma origem via rewrite `/api`). |

`packages/ui` e `apps/mobile` ainda não existem (componentes em `apps/web/components`; app nativo na etapa E9).

## Banco

- PostgreSQL 16, SQL compatível com Supabase (sem dependência do Supabase localmente — D-003).
- **Papéis mínimos**: `tracker_app` (API autenticada; RLS exige usuário membro ativo da organização do contexto via `app.member_org_id()`); `tracker_system` (worker e ingestão; RLS exige `app.org_id` do contexto). O dono do schema só aplica migrações.
- Contexto por transação: `set_config('app.org_id'/'app.user_id', …, true)` — não vaza entre conexões do pool.
- Funções `SECURITY DEFINER` pequenas para operações antes do contexto de organização: `resolve_webhook_endpoint`, `resolve_project_key`, `resolve_invite`, `user_organizations`, `outbox_claim`, `resolve_api_key`.
- Integridade entre organizações por **FKs compostas** `(organization_id, id)`; unicidade no banco (recebimento, pedido, transação, lançamento, entrega).
- Razão financeira (`financial_entries`) somente leitura para a API; correções entram como eventos auditados.
- Credenciais em `private.credentials` (somente `tracker_system`), AES-256-GCM com versão de chave e AAD `org:conexão:finalidade`.
- Grupos de entidades ainda não criados (sem tabelas vazias antecipadas): CRM, WhatsApp, análise salva, ações/regras, SaaS/cobrança.

## Fluxo de um webhook (seção 09)

1. `POST /v1/webhooks/{whk_…}`: token (40 caracteres) → HMAC → `resolve_webhook_endpoint`. Desconhecido/revogado → 404; conexão desabilitada → 410; content-type ≠ JSON → 415; limite 256 KiB e rate limit por endpoint.
2. Autenticação do conector sobre o corpo bruto (Lowify: token da URL — assinatura não documentada; sistema próprio: HMAC-SHA256 com timestamp e segredo anterior aceito por 24 h). Falha → 401 + `webhook_rejections`.
3. Identidade de idempotência (Lowify: `order_id:event:product_id`, igual ao `Idempotency-Key` documentado; próprio: `source.event_id`; senão, SHA-256 do corpo).
4. Uma transação: `webhook_receipts` (`ON CONFLICT` incrementa `delivery_count`) + `outbox receipt.process`. Resposta 200 após commit; erro de banco → 503.
5. Worker: lock do pedido (`SELECT … FOR UPDATE`), carrega agregado, aplica eventos do domínio, grava transações/reversões/itens/razão (`ON CONFLICT DO NOTHING` por chave semântica), conflitos, contato restrito, evento normalizado sem PII, e cria `attribution.compute` e `destinations.fanout` (este somente para transações aprovadas pela primeira vez). Tudo na mesma transação que marca a outbox como concluída.

## Atribuição (seção 16)

Hierarquia: token do SDK devolvido pelo checkout (liga pedido→visitante) > origem declarada pelo checkout (UTMs; IDs "nome|id" validados contra entidades da própria organização) > sessões. Com vínculo por token, a origem declarada vira corroboração. Tolerância de desvio de relógio de 10 min entre checkout e servidor. Cada política ativa gera um resultado versionado; recálculo marca o anterior como não corrente e nunca dispara Purchase.

## Destinos de conversão (seção 17)

Destino nasce `disabled`; ativação exige emissor responsável (`server`/`browser`/`checkout_native`) e passagem por `test_mode`. Entrega única por `(destino, purchase:{pedido}:{transação}, ambiente)`; `event_id` determinístico. HTTP fora da transação; `timeout` → `unknown_outcome` e repetição apenas com o mesmo `event_id` dentro da janela de deduplicação (hipótese de 48 h a revalidar); 429/5xx → backoff com jitter; 5 falhas seguidas abrem circuit breaker por destino por 5 min. `ALLOW_EXTERNAL_DELIVERY=false` impede qualquer chamada externa.

## Segurança

Sessões opacas (48 caracteres, hash HMAC no banco), cookie `httpOnly`/`SameSite=Lax`/`Secure` configurável; CSRF por verificação de `Origin`; bloqueio progressivo de login por e-mail e IP; MFA TOTP com anti-replay e exigência por organização para perfis sensíveis; autorização no servidor em toda rota + RLS no banco; PII mascarada por padrão e revelação auditada; URLs de webhook exibidas uma vez; logs com redação e URLs mascaradas; CSV com neutralização de fórmulas.

## Escalabilidade e evolução

Índices por organização/período/estado; outbox com `SKIP LOCKED` no relay; prioridades por tópico. Pontos de evolução documentados: agregações incrementais diárias para métricas (hoje calculadas sob demanda), particionamento de `tracking_events` por mês, filas por organização para isolamento de carga, CDN para o SDK.
