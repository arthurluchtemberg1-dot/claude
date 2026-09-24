# STATUS

Última atualização: 24/09/2026 (sessão 1). Branch: `claude/blissful-hypatia-9ji33p`.

## Resumo

- **E0 (descoberta): concluída.** Especificação preservada, PRD com 436 requisitos de IDs estáveis, matriz rastreável gerada e validada por script, documentação oficial das primeiras integrações verificada no que foi acessível.
- **E1 (fundação): concluída localmente.** Monorepo, PostgreSQL com RLS/papéis mínimos, autenticação completa com MFA, organizações/membros/convites/projetos, API e worker duráveis (outbox + BullMQ).
- **E2 (primeiro fluxo): implementada localmente, não validada com a Lowify.** SDK → coletor → token → checkout (simulado com o payload documentado) → webhook → pedido/razão → atribuição → painel → estorno, coberto pelo E2E T70. Falta evidência real/sandbox da Lowify (DEP-LOWIFY-*).
- **E3/E4: parcialmente adiantadas** sem acesso externo: custos manuais, importação CSV de gasto, tabelas de taxas, serviço de métricas com bases temporais, destino Meta CAPI completo (envio real desligado), parser de insights Meta.
- **E5–E10:** planejadas (catálogo completo com estados reais, sem stubs).

Matriz: 206 requisitos implementados localmente, 81 parciais, 12 bloqueados externamente, 124 planejados, 13 de método/documento. Cenários T01–T70: 50 automatizados e executados, 5 parciais, 14 planejados, 1 bloqueado (ver [`REQUIREMENTS_TRACEABILITY.md`](REQUIREMENTS_TRACEABILITY.md)).

## Evidências (executadas nesta sessão)

| Verificação | Comando | Resultado |
| --- | --- | --- |
| Lint | `pnpm lint` | sem erros |
| Tipos | `pnpm typecheck` | sem erros (8 pacotes) |
| Unitários + integração (PostgreSQL 16 e Redis 7 reais) | `pnpm test` | 131 testes passando (12 arquivos) |
| E2E navegador (API + worker/BullMQ + painel, banco `tracker_e2e`) | `pnpm test:e2e` | 3 testes passando, incluindo T70 |
| Build | `pnpm build` | API/worker empacotados (executados com `/health` e `/ready` OK), painel Next standalone, SDK 4,3 KiB gzip |
| Fixture financeira obrigatória | domínio e via webhooks + API | valores exatos com webhooks repetidos 3× |

Defeitos reais encontrados e corrigidos pelos testes: corrida relay→worker (job antes do commit), token do SDK exposto em UTM, origem declarada competindo com vínculo por token, desvio de relógio do checkout, isolamento de tentativas de login entre execuções de teste.

## Entregue por módulo

- **Domínio** (`packages/domain`): dinheiro exato, fuso/intervalos, agregado financeiro (pendente/aprovado/falho, reversões sem dupla dedução, disputa ganha, estorno antes da aprovação, renovação, participação da organização), registro de 25 métricas com qualidade/indefinido/indisponível, 7 modelos de atribuição, UTMs/macros, sanitização, permissões.
- **Banco**: 11 migrações; RLS em todas as tabelas de negócio; FKs compostas; razão somente leitura para a API; cofre de credenciais cifrado.
- **API**: auth (cadastro, verificação, login, bloqueio, reset, MFA, sessões), organizações/membros/convites/projetos/auditoria, conexões e endpoints (URL exibida uma vez, rotação/revogação), ingestão de webhooks e coleta do SDK, vendas (lista/detalhe/manual/exportação CSV), métricas (resumo/série), diagnóstico, destinos, custos/importação, UTMs, health/ready.
- **Worker**: relay, consumidor BullMQ, processamento de recebimentos, atribuição versionada, fanout e envio Meta CAPI com retry/circuit breaker, seed de demonstração.
- **Painel**: entrada/onboarding, visão geral, vendas e detalhe, integrações e catálogo, instalação do SDK, UTMs, pixels, custos, diagnóstico, configurações; módulos futuros identificados como planejados.
- **SDK**: consentimento, identificadores, toques, lotes/beacon, SPA, decoração de checkout, token, iframe.
- **Ferramentas**: `pnpm diag`, `pnpm webhook:simulate`, `pnpm db:seed:demo`, `pnpm traceability`, `pnpm docs:metrics`.

## Limitações conhecidas (não esconder)

- Lowify: sem assinatura documentada (proteção por URL secreta), moeda/fuso assumidos por configuração, reembolso tratado como integral, passagem de token por UTM ainda não confirmada com venda real.
- Meta: nenhum envio/leitura real; limites e deduplicação navegador×servidor a revalidar (docs bloqueadas).
- Base "por coorte" usa a base por aprovação (sem identidade de cliente); LTV observado pendente.
- Vínculo de upsell (`parent_order_id`) e parcelas/repasses (T16, T18) não persistidos/modelados.
- Sem Dockerfiles, backups testados, carga, API pública com chaves, webhooks de saída/SSRF, notificações, regras, IA, WhatsApp/CRM, funis, relatórios agendados, cobrança do SaaS, app nativo.
- Warnings do React ("unique key") emitidos pelo próprio Next 16.3.6 durante o build/start; não afetam funcionamento.

## Impedimentos externos

Ver [`EXTERNAL_DEPENDENCIES.md`](EXTERNAL_DEPENDENCIES.md). Os que mais destravam valor agora:
1. **DEP-LOWIFY-SAMPLES / DEP-LOWIFY-TRACKING** — uma venda de teste autorizada com o webhook apontado para o Tracker (payloads reais anonimizados e confirmação de que o `utm_term` com token volta no webhook).
2. **DEP-META-APP** — app Meta + token de sistema/dataset para validar CAPI em modo de teste e sincronizar gastos.
3. **DEP-OFFICIAL-DOCS** — liberar domínios de documentação oficial na rede do ambiente.

## Próximo passo executável

1. Persistir vínculo comprovado de upsell (`orders.parent_order_id`) a partir de `parent_order_id` do contrato canônico + teste T16; modelar eventos de repasse/parcela sem efeito de receita (T18).
2. Testes pendentes baratos: T39 (renomeação de campanha preserva junção por ID), T46 (níveis mistos de gasto), R06-07 (restrição por projeto).
3. API pública v1 com chaves de API (hash, escopos, rate limit, Idempotency-Key) + OpenAPI; webhooks de saída assinados com proteção SSRF (T67).
4. Tela/API de políticas de atribuição (criar versão, janela, comparação) e visão de clientes.
5. Dockerfiles (API, worker, painel), `docker-compose` de referência, backup/restore testado (T69) e checklist de implantação.
6. Após DEP-META-APP: OAuth Meta (state + PKCE), sincronização de contas/entidades/insights com paginação e backfill, validação CAPI com `test_event_code`.

Para retomar: ler `CLAUDE.md`, este arquivo e a matriz; subir PostgreSQL/Redis (`service postgresql start`; `redis-server --daemonize yes --appendonly yes --dir /tmp`); `pnpm install && pnpm db:migrate && pnpm test`.
