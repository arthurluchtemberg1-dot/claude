# STATUS

Última atualização: 24/09/2026 (sessão 2). Branch: `claude/blissful-hypatia-9ji33p`.

## Resumo

- **E0 (descoberta): concluída.** Especificação preservada, PRD com 436 requisitos de IDs estáveis, matriz rastreável gerada e validada por script, documentação oficial das primeiras integrações verificada no que foi acessível.
- **E1 (fundação): concluída localmente.** Monorepo, PostgreSQL com RLS/papéis mínimos, autenticação completa com MFA, organizações/membros/convites/projetos, API e worker duráveis (outbox + BullMQ).
- **E2 (primeiro fluxo): implementada localmente, não validada com a Lowify.** SDK → coletor → token → checkout (simulado com o payload documentado) → webhook → pedido/razão → atribuição → painel → estorno, coberto pelo E2E T70. Falta evidência real/sandbox da Lowify (DEP-LOWIFY-*).
- **E3/E4: parcialmente adiantadas** sem acesso externo: custos manuais, importação CSV de gasto (com entidades e histórico de nomes), tabelas de taxas, serviço de métricas com bases temporais, detalhamento por campanha/conjunto/anúncio/rede com junção por ID (tela Campanhas, somente leitura), destino Meta CAPI completo (envio real desligado), parser de insights Meta.
- **E5–E10:** planejadas (catálogo completo com estados reais, sem stubs).

Matriz: 208 requisitos implementados localmente, 81 parciais, 12 bloqueados externamente, 122 planejados, 13 de método/documento. Cenários T01–T70: 54 automatizados e executados, 2 parciais, 13 planejados, 1 bloqueado (ver [`REQUIREMENTS_TRACEABILITY.md`](REQUIREMENTS_TRACEABILITY.md)).

## Evidências (executadas nesta sessão)

| Verificação | Comando | Resultado |
| --- | --- | --- |
| Lint | `pnpm lint` | sem erros |
| Tipos | `pnpm typecheck` | sem erros (8 pacotes; conferir o código de saída — `pnpm -s` omite a saída do erro) |
| Unitários + integração (PostgreSQL 16 e Redis 7 reais) | `pnpm test` | 143 testes passando (14 arquivos) |
| E2E navegador (API + worker/BullMQ + painel, banco `tracker_e2e`) | `pnpm test:e2e` | 3 testes passando, incluindo T70 (com a tela Campanhas) |
| Build | `pnpm build` | API/worker empacotados (executados com `/health` e `/ready` OK), painel Next standalone, SDK 4,3 KiB gzip |
| Fixture financeira obrigatória | domínio e via webhooks + API | valores exatos com webhooks repetidos 3× |

Defeitos reais encontrados e corrigidos pelos testes: corrida relay→worker (job antes do commit), token do SDK exposto em UTM, origem declarada competindo com vínculo por token, desvio de relógio do checkout, isolamento de tentativas de login entre execuções de teste. Sessão 2: importação CSV por campanha com nomes falhava por falta de permissão de escrita em `ad_entity_names`; nível de gasto escolhido por conta no período inteiro descartava dias importados em outro nível; toques do SDK não extraíam IDs "nome|id" das UTMs (vendas atribuídas por token ficavam sem campanha); restrição de membro a projeto inexistente gerava erro 500.

## Entregue por módulo

- **Domínio** (`packages/domain`): dinheiro exato, fuso/intervalos, agregado financeiro (pendente/aprovado/falho, reversões sem dupla dedução, disputa ganha, estorno antes da aprovação, renovação, participação da organização, parcelas informativas), registro de 25 métricas com qualidade/indefinido/indisponível, 7 modelos de atribuição, UTMs/macros, sanitização, permissões.
- **Banco**: 13 migrações (0012 upsell/recebíveis, 0013 entidades/nomes por data); RLS em todas as tabelas de negócio; FKs compostas; razão somente leitura para a API; cofre de credenciais cifrado.
- **API**: auth (cadastro, verificação, login, bloqueio, reset, MFA, sessões), organizações/membros/convites/projetos/auditoria, conexões e endpoints (URL exibida uma vez, rotação/revogação), ingestão de webhooks e coleta do SDK, vendas (lista/detalhe com pedidos vinculados e recebíveis/manual/exportação CSV), métricas (resumo/série), detalhamento por campanha/conjunto/anúncio/rede, diagnóstico, destinos, custos/importação, UTMs, health/ready.
- **Worker**: relay, consumidor BullMQ, processamento de recebimentos (vínculo de upsell com resolução adiada, recebíveis/liquidações), atribuição versionada (herança do vínculo do pedido original), fanout e envio Meta CAPI com retry/circuit breaker, seed de demonstração.
- **Painel**: entrada/onboarding, visão geral, vendas e detalhe (pedidos vinculados, parcelas, recebíveis), campanhas (detalhamento e drill-down), integrações e catálogo, instalação do SDK, UTMs, pixels, custos, diagnóstico, configurações; módulos futuros identificados como planejados.
- **SDK**: consentimento, identificadores, toques, lotes/beacon, SPA, decoração de checkout, token, iframe.
- **Ferramentas**: `pnpm diag`, `pnpm webhook:simulate`, `pnpm db:seed:demo`, `pnpm traceability`, `pnpm docs:metrics`.

## Limitações conhecidas (não esconder)

- Lowify: sem assinatura documentada (proteção por URL secreta), moeda/fuso assumidos por configuração, reembolso tratado como integral, passagem de token por UTM ainda não confirmada com venda real.
- Meta: nenhum envio/leitura real; limites e deduplicação navegador×servidor a revalidar (docs bloqueadas).
- Base "por coorte" usa a base por aprovação (sem identidade de cliente); LTV observado pendente.
- Lowify não documenta vínculo de upsell nem parcelas/repasses: esses recursos só funcionam hoje pelo webhook canônico.
- Métricas por movimento financeiro ainda não exibem repasses/recebíveis (tabela disponível para conciliação).
- Sem Dockerfiles, backups testados, carga, API pública com chaves, webhooks de saída/SSRF, notificações, regras, IA, WhatsApp/CRM, funis, relatórios agendados, cobrança do SaaS, app nativo.
- Warnings do React ("unique key") emitidos pelo próprio Next 16.3.6 durante o build/start; não afetam funcionamento.

## Impedimentos externos

Ver [`EXTERNAL_DEPENDENCIES.md`](EXTERNAL_DEPENDENCIES.md). Os que mais destravam valor agora:
1. **DEP-LOWIFY-SAMPLES / DEP-LOWIFY-TRACKING** — uma venda de teste autorizada com o webhook apontado para o Tracker (payloads reais anonimizados e confirmação de que o `utm_term` com token volta no webhook).
2. **DEP-META-APP** — app Meta + token de sistema/dataset para validar CAPI em modo de teste e sincronizar gastos.
3. **DEP-OFFICIAL-DOCS** — liberar domínios de documentação oficial na rede do ambiente.

## Próximo passo executável

1. API pública v1 com chaves de API (hash, escopos, rate limit, Idempotency-Key) + OpenAPI; webhooks de saída assinados com proteção SSRF (T67).
2. Tela/API de políticas de atribuição (criar versão, janela, comparação) e visão de clientes.
3. Dockerfiles (API, worker, painel), `docker-compose` de referência, backup/restore testado (T69) e checklist de implantação.
4. Após DEP-META-APP: OAuth Meta (state + PKCE), sincronização de contas/entidades/insights com paginação e backfill, validação CAPI com `test_event_code`.

Para retomar: ler `CLAUDE.md`, este arquivo e a matriz; subir PostgreSQL/Redis (`service postgresql start`; `redis-server --daemonize yes --appendonly yes --dir /tmp`); `pnpm install && pnpm db:migrate && pnpm test`.
