# STATUS

Última atualização: 25/10/2026 (sessão 4). Branch: `claude/blissful-hypatia-9ji33p`.

## Sessão 4 — Meta Ads, gerenciador de campanhas e instalação em um comando

- **Meta Ads (R19, R25, R26):** conexão por token de usuário do sistema (D-032), sincronização de contas, campanhas, conjuntos (fase de aprendizado), anúncios, gasto diário em 3 níveis, compras reportadas, pixels e páginas; alertas de limite de gasto, conta com problema e acesso perdido. Gerenciador em **Campanhas** (ligar/desligar, orçamento, lote, duplicar pausado, renomear, histórico) com reconciliação após resposta perdida (D-033). Regras executam pausar/ativar/orçamento/duplicar quando a gestão é liberada e não agem em aprendizado por padrão. Tudo testado contra Graph API falsa; **falta evidência com conta real (DEP-META-ACCOUNT)**.
- **Painel:** destaques (faturamento, investimento, ROAS, lucro, vendas, CPA) com variação, campanhas em destaque, últimas vendas ao vivo; menu em seções; **Primeiros passos** com checklist verificado no servidor.
- **Instalação:** `sudo bash deploy/install.sh --domain … --email …` (Docker, segredos, Caddy/HTTPS, proprietário) — validada em contêineres com domínio local; guia de 20 minutos em [`GUIA_RAPIDO.md`](GUIA_RAPIDO.md) (D-034).
- **Defeitos reais encontrados nesta sessão:** pedido repetido de ação era recusado como "já pausada" em vez de devolvido como duplicado; elementos `sr-only` absolutos dentro de tabelas roláveis alargavam a página no celular; selos do cabeçalho estouravam a largura em 390 px; o instalador abortava quando o DNS ainda não resolvia (pipefail); conexão Meta aparecia com botão "Novo endpoint" na lista de checkouts; campos com largura própria eram sobrescritos por `w-full`.

## Resumo

- **E0 (descoberta): concluída.** Especificação preservada, PRD com 436 requisitos de IDs estáveis, matriz rastreável gerada e validada por script, documentação oficial das primeiras integrações verificada no que foi acessível.
- **E1 (fundação): concluída localmente.** Monorepo, PostgreSQL com RLS/papéis mínimos, autenticação completa com MFA, organizações/membros/convites/projetos, API e worker duráveis (outbox + BullMQ).
- **E2 (primeiro fluxo): implementada localmente, não validada com a Lowify.** SDK → coletor → token → checkout (simulado com o payload documentado) → webhook → pedido/razão → atribuição → painel → estorno, coberto pelo E2E T70. Falta evidência real/sandbox da Lowify (DEP-LOWIFY-*).
- **E3/E4: parcialmente adiantadas** sem acesso externo: custos manuais, importação CSV de gasto (com entidades e histórico de nomes), tabelas de taxas, serviço de métricas com bases temporais, detalhamento por campanha/conjunto/anúncio/rede com junção por ID (tela Campanhas, somente leitura), destino Meta CAPI completo (envio real desligado), parser de insights Meta.
- **E8 (parcial): API pública v1 e webhooks de saída implementados** — chaves com escopos/projetos/sandbox, limites, Idempotency-Key, OpenAPI, webhooks assinados com anti-SSRF, fila de falhas e proteção contra loops.
- **E9 (parcial): implantação em contêineres verificada** — imagens api/worker/web, compose de referência executado ponta a ponta, backup/restauração verificados (T69), SMTP com TLS.
- **E6 (parcial, sessão 3): motor de regras e Gestor IA implementados** — regras com simulação, versões imutáveis, travas e execução agendada (notificar, webhook, tag; ações na rede só simulam até DEP-META-APP); Gestor IA com ferramentas tipadas somente leitura, limites e auditoria (adaptador Anthropic; uso real depende de chave — DEP-AI).
- **E8 (parcial, sessão 3): central de notificações** — venda aprovada/renovação/upsell, reembolso, chargeback e alertas operacionais no painel, e-mail e Web Push, com preferências, horário silencioso e som de venda opcional.
- **E9 (parcial, sessão 3): PWA instalável** — manifesto, ícones, service worker e revisão em tela de celular das telas principais.
- **E5, E7, E10:** planejadas (catálogo completo com estados reais, sem stubs).

### Paridade funcional com LowTrack/UTMify (categorias públicas, implementação própria)

| Categoria | Situação |
| --- | --- |
| SDK, passagem de origem, atribuição, deduplicação CAPI | Implementado localmente; Meta CAPI com envio real desligado até DEP-META-APP |
| Painel, vendas, campanhas, clientes, custos | Implementado (gasto sincronizado da Meta ou importação CSV) |
| Notificação de venda no celular (push + som) | Implementado (Web Push/PWA; app nativo nas lojas planejado — DEP-STORES) |
| Alertas (integração parada, fila, falhas, metas, gasto sem venda) | Implementado (monitores + regras) |
| Regras automáticas | Implementado com simulação; pausar/ativar/orçamento/duplicar executam na Meta com a gestão liberada |
| Gerenciador de campanhas Meta (ligar/desligar, orçamento, duplicar, lote, histórico) | Implementado localmente (Graph API falsa); validar com sua conta (DEP-META-ACCOUNT) |
| Gestor IA | Implementado com provedor Anthropic; requer chave (DEP-AI) |
| Alerta de limite de gasto/conta com problema, duplicação | Implementado (limite de gasto; saldo pré-pago não lido) |
| Criação rápida de campanhas e biblioteca de criativos | Planejado (R25-07, R25-08) |
| Instalação em servidor próprio | Um comando com HTTPS (deploy/install.sh) |
| API pública e webhook de saída | Implementado |

Matriz: 246 requisitos implementados localmente, 99 parciais, 4 bloqueados externamente, 74 planejados, 13 de método/documento. Cenários T01–T70 conforme [`REQUIREMENTS_TRACEABILITY.md`](REQUIREMENTS_TRACEABILITY.md).

## Evidências (executadas nesta sessão)

| Verificação | Comando | Resultado |
| --- | --- | --- |
| Lint | `pnpm lint` | sem erros |
| Tipos | `pnpm typecheck` | sem erros (10 pacotes; conferir o código de saída — `pnpm -s` omite a saída do erro) |
| Unitários + integração (PostgreSQL 16 e Redis 7 reais) | `pnpm test` | 289 testes passando (32 arquivos; 4 de desempenho opcionais com `PERF=1`), incluindo `meta.test.ts`, `meta-actions.test.ts`, `meta-graph.test.ts` e `private-install.test.ts` |
| Instalação | `deploy/install.sh --domain painel.localhost` (imagens locais) | migrações, API, worker, painel e Caddy saudáveis; `/api/health`, painel e SDK pelo HTTPS; cadastro público 403; proprietário criado pelo `admin.js` e login com cookie seguro |
| Navegador (Graph API falsa) | conexão Meta, gerenciador, painel e checklist | pausar e orçamento confirmados pela Meta falsa e refletidos no painel; sem erros de console; sem estouro horizontal a 390 px em todas as rotas |
| E2E navegador (API + worker/BullMQ + painel, banco `tracker_e2e`) | `pnpm test:e2e` | 3 testes passando (sessão 4), incluindo T70 (organização nova abre Primeiros passos, Campanhas, Clientes, Atribuição, chave de API, sino/central de notificações, manifesto e service worker, meta criada por exemplo → simulada → ativada, Gestor IA indisponível sem provedor) |
| Web Push | `packages/connectors/test/web-push.test.ts` | mensagem cifrada (aes128gcm) decifrada com a chave do "navegador"; VAPID; 404/410 desativam a inscrição; anti-SSRF |
| Adaptador Anthropic | `packages/ai/test/anthropic-adapter.test.ts` | pedido do SDK oficial conferido contra servidor local que imita a API (ferramentas estritas, cache, esforço, fallback por recusa); nenhuma chamada real |
| Celular | revisão visual a 390 px | sem estouro de layout em painel, vendas, notificações, automação, Gestor IA e campanhas |
| Contêineres | `docker build --target api` (e `worker`, `web`) + `node deploy/compose-smoke.mjs` | imagens construídas; pilha completa (PostgreSQL, Redis, migrações, API, worker, painel) com cadastro → webhook → worker → pedido aprovado |
| Backup/restauração | `backup-restore.test.ts` (scripts reais com pg_dump/pg_restore) | restauração verificada em banco novo; dump sem segredos/chaves; login e webhook funcionando no banco restaurado |
| Carga | `node scripts/load-test.mjs --orders 2000 --concurrency 32` | webhooks ~320 req/s (p95 ~130 ms, 0 erros), ~170–190 pedidos/s ponta a ponta por réplica de worker, idempotência preservada, coleta ~625 req/s, resumo p95 579 ms logo após a carga (antes: 32 s) — `docs/load-tests/` |
| Build | `pnpm build` | API/worker empacotados (executados com `/health` e `/ready` OK), painel Next standalone, SDK 4,3 KiB gzip |
| Fixture financeira obrigatória | domínio e via webhooks + API | valores exatos com webhooks repetidos 3× |

Sessão 3 (defeitos reais encontrados): teste de recebíveis calculava o dia em UTC (falhava à noite no horário de Brasília); ação de regra que falhava "prendia" a chave de idempotência e não era tentada de novo (circuit breaker nunca disparava); a tabela acessível do gráfico do painel alargava a página no celular e o painel do sino abria fora da tela.

Defeitos reais encontrados e corrigidos pelos testes: corrida relay→worker (job antes do commit), token do SDK exposto em UTM, origem declarada competindo com vínculo por token, desvio de relógio do checkout, isolamento de tentativas de login entre execuções de teste. Sessão 2: importação CSV por campanha com nomes falhava por falta de permissão de escrita em `ad_entity_names`; nível de gasto escolhido por conta no período inteiro descartava dias importados em outro nível; toques do SDK não extraíam IDs "nome|id" das UTMs (vendas atribuídas por token ficavam sem campanha); restrição de membro a projeto inexistente gerava erro 500; rotas respondiam antes do COMMIT (`reply.send` dentro da transação — causa das falhas intermitentes; D-022); opções SMTP ignoradas pelo nodemailer (TLS não exigido) — corrigido antes de ir a produção; base por aprovação levava renovações ao mês da primeira compra e as creditava à campanha de aquisição (D-027); resumo de métricas com p95 de 32 s sob carga (consulta O(n²) e estatísticas desatualizadas; D-028).

## Entregue por módulo

- **Domínio** (`packages/domain`): dinheiro exato, fuso/intervalos, agregado financeiro (pendente/aprovado/falho, reversões sem dupla dedução, disputa ganha, estorno antes da aprovação, renovação, participação da organização, parcelas informativas), registro de 25 métricas com qualidade/indefinido/indisponível, 7 modelos de atribuição, UTMs/macros, sanitização, permissões.
- **Banco**: 19 migrações (0012 upsell/recebíveis, 0013 entidades/nomes por data, 0014 API pública/webhooks de saída, 0015 clientes, 0016 autovacuum, 0017 notificações, 0018 regras, 0019 Gestor IA); RLS em todas as tabelas de negócio; FKs compostas; razão somente leitura para a API; cofre de credenciais cifrado.
- **API**: auth (cadastro, verificação, login, bloqueio, reset, MFA, sessões), organizações/membros/convites/projetos/auditoria, conexões e endpoints (URL exibida uma vez, rotação/revogação), ingestão de webhooks e coleta do SDK, vendas (lista/detalhe com pedidos vinculados e recebíveis/manual/exportação CSV), métricas (resumo/série), detalhamento por campanha/conjunto/anúncio/rede, API pública `/public/v1` (OpenAPI) e gestão de chaves/webhooks de saída, políticas de atribuição (versões, comparação, recálculo), clientes, diagnóstico, destinos, custos/importação, UTMs, health/ready.
- **Worker**: relay, consumidor BullMQ, processamento de recebimentos (vínculo de upsell com resolução adiada, recebíveis/liquidações), atribuição versionada (herança do vínculo do pedido original), emissão e entrega de webhooks de saída, fanout e envio Meta CAPI com retry/circuit breaker, seed de demonstração.
- **Painel**: entrada/onboarding, visão geral, vendas e detalhe (pedidos vinculados, parcelas, recebíveis), campanhas (detalhamento e drill-down), clientes, atribuição (políticas e comparação; seletor no painel), API e webhooks, integrações e catálogo, instalação do SDK, UTMs, pixels, custos, diagnóstico, configurações; módulos futuros identificados como planejados.
- **SDK**: consentimento, identificadores, toques, lotes/beacon, SPA, decoração de checkout, token, iframe.
- **Sessão 3**: `packages/analytics` (métricas e detalhamento compartilhados por API e worker), `packages/ai` (provedores, ferramentas e laço do Gestor IA), notificações (`apps/worker/src/handlers/notifications.ts`, `monitors.ts`, agendador), regras (`packages/domain/src/rules`, `apps/worker/src/handlers/rules.ts`), telas `/notificacoes`, `/automacao`, `/gestor-ia`; migrações 0017–0019.
- **Ferramentas**: `pnpm push:keys` (chaves VAPID), `pnpm diag`, `pnpm webhook:simulate`, `pnpm db:seed:demo`, `pnpm traceability`, `pnpm docs:metrics`.

## Limitações conhecidas (não esconder)

- Lowify: sem assinatura documentada (proteção por URL secreta), moeda/fuso assumidos por configuração, reembolso tratado como integral, passagem de token por UTM ainda não confirmada com venda real.
- Meta: leitura e gestão implementadas e testadas só contra Graph API falsa (formatos dos SDKs oficiais); a primeira conexão real confirma valores em menor unidade e permissões (DEP-META-ACCOUNT). CAPI com envio real ainda não validado; deduplicação navegador×servidor a revalidar (docs bloqueadas). Sem criação de campanhas, criativos, relatórios assíncronos ou contas de terceiros.
- Coorte identifica clientes pelo e-mail informado no checkout; pedidos sem e-mail contam como clientes distintos. Contribuição por cliente pendente.
- Lowify não documenta vínculo de upsell nem parcelas/repasses: esses recursos só funcionam hoje pelo webhook canônico.
- Métricas por movimento financeiro ainda não exibem repasses/recebíveis (tabela disponível para conciliação).
- API pública ainda sem leads/eventos próprios; limite de taxa em janelas no banco (D-020).
- Hospedagem real, domínio/TLS, agendamento de backups e observabilidade externa dependem do operador (DEP-HOSTING, DEP-OBSERVABILITY); e-mail real depende de conta SMTP (DEP-EMAIL).
- Regras: frequência, variação de orçamento e saldo como condição ainda indisponíveis; "desfazer" alterações não existe (o histórico mostra o valor anterior).
- Sem SMTP (instalação padrão) não há recuperação de senha por e-mail nem convites por e-mail: use `admin.js` no servidor ou informe `--smtp-url`.
- Gestor IA: só o adaptador Anthropic existe (OpenAI/Google planejados por falta de documentação verificada); resumo diário programado pendente; o comportamento do modelo (separar fato e hipótese, resistir a injeção) é instruído, não garantido por código.
- Push depende do navegador/serviço de push (não garantido); no iPhone exige instalar o PWA. Monitor de fila roda no próprio worker (worker parado é detectado pelo `/ready`, não por notificação).
- Sem WhatsApp/CRM, funis, relatórios agendados, cobrança do SaaS, app nativo nas lojas.
- Warnings do React ("unique key") emitidos pelo próprio Next 16.3.6 durante o build/start; não afetam funcionamento.

## Impedimentos externos

Ver [`EXTERNAL_DEPENDENCIES.md`](EXTERNAL_DEPENDENCIES.md). Os que mais destravam valor agora:
1. **DEP-LOWIFY-SAMPLES / DEP-LOWIFY-TRACKING** — uma venda de teste autorizada com o webhook apontado para o Tracker (payloads reais anonimizados e confirmação de que o `utm_term` com token volta no webhook).
2. **DEP-META-ACCOUNT** — colar o token de usuário do sistema em Meta Ads (painel) e conferir a primeira sincronização e uma pausa de teste; dataset/token de CAPI para validar a API de Conversões em modo de teste.
3. **DEP-OFFICIAL-DOCS** — liberar domínios de documentação oficial na rede do ambiente.

## Próximo passo executável

1. Com a conta real (DEP-META-ACCOUNT): conferir gasto do dia × Gerenciador de Anúncios, uma pausa/ativação e um ajuste de orçamento; ajustar o manifesto para "Validado em produção" com a evidência.
2. Gestor IA com ferramenta de leitura das campanhas sincronizadas (orçamento, aprendizado, compras reportadas) e resumo diário (R27-03).
3. Criação rápida de campanha pausada a partir de modelo (R25-07) e frequência de período nas regras (R26-02).
4. Contribuição por pedido/cliente com custos variáveis e câmbio (R22-10); relatórios agendados (seção 32).

Para retomar: ler `CLAUDE.md`, este arquivo e a matriz; subir PostgreSQL/Redis (`service postgresql start`; `redis-server --daemonize yes --appendonly yes --dir /tmp`); em contêiner novo, criar `.env` a partir de `.env.example` (senhas locais do `db-setup`) e rodar `pnpm db:setup`; depois `pnpm install && pnpm db:migrate && pnpm test`.
