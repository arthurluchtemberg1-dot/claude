# Matriz de rastreabilidade de requisitos

> Arquivo **gerado** por `pnpm traceability` a partir de [`PRD.md`](PRD.md) e [`traceability/status.json`](traceability/status.json). Edite o JSON e regenere; o comando falha se algum requisito do PRD ou cenário T01–T70 desaparecer.

Atualizado em: 2026-09-24. Estados de requisito conforme R11-03/R46-01: "Implementado localmente" = código + testes executados neste repositório; não significa validado com o provedor externo.

## Resumo

| Estado | Requisitos |
| --- | --- |
| ✅ Implementado localmente | 223 |
| 🟡 Parcial | 75 |
| ⛔ Bloqueado externamente | 12 |
| ⏳ Planejado | 113 |
| 📄 Método/documento | 13 |
| **Total** | **436** |

| Cenários de teste (seção 43) | Quantidade |
| --- | --- |
| ✅ Automatizado e executado | 56 |
| 🟡 Parcial | 2 |
| ⏳ Planejado | 11 |
| ⛔ Bloqueado | 1 |

## Cenários obrigatórios T01–T70

| ID | Estado | Evidência / pendência |
| --- | --- | --- |
| T01 | ✅ Automatizado e executado | financial.test.ts; webhook-pipeline.test.ts |
| T02 | ✅ Automatizado e executado | financial.test.ts; webhook-pipeline.test.ts |
| T03 | ✅ Automatizado e executado | rls.itest.ts; webhook-pipeline.test.ts |
| T04 | ✅ Automatizado e executado | financial.test.ts; webhook-pipeline.test.ts (reembolso com outro event_id) |
| T05 | ✅ Automatizado e executado | webhook-pipeline.test.ts |
| T06 | ✅ Automatizado e executado | financial.test.ts; lowify.test.ts; webhook-pipeline.test.ts |
| T07 | ✅ Automatizado e executado | financial.test.ts |
| T08 | ✅ Automatizado e executado | financial.test.ts; webhook-pipeline.test.ts |
| T09 | ✅ Automatizado e executado | financial.test.ts; webhook-pipeline.test.ts |
| T10 | ✅ Automatizado e executado | financial.test.ts |
| T11 | ✅ Automatizado e executado | financial.test.ts; webhook-pipeline.test.ts |
| T12 | ✅ Automatizado e executado | financial.test.ts; webhook-pipeline.test.ts |
| T13 | ✅ Automatizado e executado | financial.test.ts; webhook-pipeline.test.ts |
| T14 | ✅ Automatizado e executado | financial.test.ts |
| T15 | ✅ Automatizado e executado | financial.test.ts; webhook-pipeline.test.ts |
| T16 | ✅ Automatizado e executado | order-links-settlements.test.ts (vínculo, ordem invertida, sem vínculo por e-mail/outra conta, conflito, herança de vínculo por token) |
| T17 | ✅ Automatizado e executado | financial.test.ts; webhook-pipeline.test.ts |
| T18 | ✅ Automatizado e executado | order-links-settlements.test.ts; financial.test.ts (parcelas e repasses sem nova compra/receita) |
| T19 | ✅ Automatizado e executado | canonical-meta.test.ts; webhook-pipeline.test.ts |
| T20 | ✅ Automatizado e executado | lowify.test.ts; canonical-meta.test.ts; webhook-pipeline.test.ts |
| T21 | ✅ Automatizado e executado | canonical-meta.test.ts; webhook-pipeline.test.ts |
| T22 | ✅ Automatizado e executado | webhook-pipeline.test.ts |
| T23 | ✅ Automatizado e executado | deliveries-relay.test.ts |
| T24 | ✅ Automatizado e executado | canonical-meta.test.ts; deliveries-relay.test.ts |
| T25 | ✅ Automatizado e executado | deliveries-relay.test.ts |
| T26 | ✅ Automatizado e executado | deliveries-relay.test.ts |
| T27 | ✅ Automatizado e executado | deliveries-relay.test.ts; tracking-attribution.test.ts |
| T28 | ✅ Automatizado e executado | canonical-meta.test.ts |
| T29 | ✅ Automatizado e executado | attribution.test.ts; tracking-attribution.test.ts; E2E |
| T30 | ✅ Automatizado e executado | attribution.test.ts; tracking-attribution.test.ts |
| T31 | ✅ Automatizado e executado | attribution.test.ts; tracking-attribution.test.ts |
| T32 | ✅ Automatizado e executado | attribution.test.ts; tracking-attribution.test.ts |
| T33 | ✅ Automatizado e executado | attribution.test.ts |
| T34 | ✅ Automatizado e executado | sdk.test.ts; tracking-attribution.test.ts |
| T35 | ✅ Automatizado e executado | sdk.test.ts |
| T36 | ✅ Automatizado e executado | sdk.test.ts; E2E |
| T37 | ✅ Automatizado e executado | sdk.test.ts; tracking-attribution.test.ts |
| T38 | ✅ Automatizado e executado | utm-money-time.test.ts; tracking-attribution.test.ts |
| T39 | ✅ Automatizado e executado | breakdown-projects.test.ts (renomeação preserva junção por ID; nome vigente e anteriores) |
| T40 | ✅ Automatizado e executado | tracking-attribution.test.ts; rls.itest.ts |
| T41 | ✅ Automatizado e executado | attribution.test.ts |
| T42 | 🟡 Parcial | event_id estável; coordenação com pixel do navegador pendente (DEP-META-DOCS) |
| T43 | ✅ Automatizado e executado | deliveries-relay.test.ts |
| T44 | ⏳ Planejado | GA4/Google Ads (DEP-GOOGLE-APP) |
| T45 | ✅ Automatizado e executado | webhook-pipeline.test.ts |
| T46 | ✅ Automatizado e executado | breakdown-projects.test.ts (conta+campanha+anúncio no mesmo dia sem multiplicar; drill-down) |
| T47 | ✅ Automatizado e executado | utm-money-time.test.ts |
| T48 | ✅ Automatizado e executado | utm-money-time.test.ts; nota de fuso da conta em metrics-repo |
| T49 | ✅ Automatizado e executado | utm-money-time.test.ts; metrics-fixture.test.ts |
| T50 | ✅ Automatizado e executado | metrics-fixture.test.ts |
| T51 | ✅ Automatizado e executado | financial.test.ts; metrics-fixture.test.ts |
| T52 | ✅ Automatizado e executado | rls.itest.ts; auth-isolation.test.ts |
| T53 | 🟡 Parcial | Exportação isolada; realtime/storage inexistentes |
| T54 | ✅ Automatizado e executado | rls.itest.ts; auth-isolation.test.ts |
| T55 | ⛔ Bloqueado | OAuth (DEP-META-APP) |
| T56 | ⏳ Planejado | Regras (E6) |
| T57 | ⏳ Planejado | Regras (E6) |
| T58 | ⏳ Planejado | Regras (E6) |
| T59 | ⏳ Planejado | Gestão de mídia (E6) |
| T60 | ⏳ Planejado | IA (E6) |
| T61 | ⏳ Planejado | IA (E6) |
| T62 | ⏳ Planejado | WhatsApp (E7) |
| T63 | ⏳ Planejado | Recuperação (E7) |
| T64 | ⏳ Planejado | SaaS (E8) |
| T65 | ⏳ Planejado | SaaS (E8) |
| T66 | ✅ Automatizado e executado | webhook-pipeline.test.ts |
| T67 | ✅ Automatizado e executado | outbound.test.ts (IPs internos, IPv6/mapeados, DNS na conexão, redirect para interno/metadata/rebind); webhooks-out.test.ts (cadastro bloqueado) |
| T68 | ✅ Automatizado e executado | canonical-meta.test.ts; deliveries-relay.test.ts |
| T69 | ✅ Automatizado e executado | backup-restore.test.ts (restauração verificada em banco novo; sem segredos/chaves no dump; login, pedidos e webhook funcionando no banco restaurado) |
| T70 | ✅ Automatizado e executado | apps/web/e2e/journey.spec.ts (payload Lowify documentado, local) |

## Requisitos

Colunas: ID · requisito (resumo; texto completo no PRD) · etapa · estado · implementação · testes · dependência externa · observação.

### 01. Missão

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R01-01 | Construir a aplicação real no repositório, com decisões técnicas fundamentadas, código, testes executados e documentação de operação. | E0 | 🟡 Parcial | Monorepo completo (apps/*, packages/*) | pnpm test (131), E2E T70 |  | Construção progressiva; E0–E2 entregues localmente |
| R01-02 | O produto deve responder: vendas confirmadas pelo checkout; origem/campanha/conjunto/anúncio de cada venda com evidência; investimento, rec… | E0 | 🟡 Parcial | apps/api/src/routes/*, apps/web/app/(app)/* | T70 |  | Vendas, origem, métricas e eventos respondidos; campanhas/automações planejadas (E6) |
| R01-03 | Público: produtores digitais, afiliados, e-commerces, prestadores de serviços, gestores de tráfego e agências. | E0 | 📄 Método/documento | docs/PRD.md |  |  |  |
| R01-04 | Identidade, código, interface e textos originais; não copiar marcas, ativos, páginas privadas, termos ou código proprietário de UTMify/LowT… | E0 | ✅ Implementado localmente | Identidade/UI originais; sem ativos de terceiros | — |  |  |
| R01-05 | Nome provisório "Tracker"; nome, logo, cores, domínio e textos comerciais centralizados em configuração. | E0 | ✅ Implementado localmente | apps/web/lib/brand.ts (NEXT_PUBLIC_BRAND_NAME) | — |  |  |

### 02. Premissas e abrangência

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R02-01 | SaaS com isolamento entre organizações; modo de uso interno que desativa cobrança sem enfraquecer autenticação/isolamento. | E0 | ✅ Implementado localmente | packages/db/migrations/0002 organizations.internal_mode; RLS | apps/api/test/integration/auth-isolation.test.ts |  | Modo interno sem cobrança; cobrança do SaaS ainda não implementada (E8) |
| R02-02 | Idioma pt-BR com estrutura preparada para en-US e es. | E0 | 🟡 Parcial | Textos pt-BR; iam.users.locale pt-BR/en-US/es | — |  | Catálogo de traduções en-US/es pendente |
| R02-03 | Fuso padrão America/Sao_Paulo; horários armazenados em UTC. | E0 | ✅ Implementado localmente | packages/domain/src/time.ts; timestamptz UTC; organizations.timezone | packages/domain/test/utm-money-time.test.ts (T47) |  |  |
| R02-04 | Moeda de apresentação BRL; valores originais preservados por moeda. | E0 | ✅ Implementado localmente | packages/domain/src/money.ts; moeda por pedido/entrada | packages/domain/test/utm-money-time.test.ts (T49) |  |  |
| R02-05 | Integrações prioritárias: Lowify e Meta Ads. | E0 | 🟡 Parcial | packages/connectors/src/checkout/lowify.ts; packages/connectors/src/destinations/meta-capi.ts; packages/connectors/src/ads/meta-ads.ts | lowify.test.ts, canonical-meta.test.ts | DEP-LOWIFY-SAMPLES, DEP-META-APP |  |
| R02-06 | Modelo de atribuição inicial: último clique pago elegível, janela de 7 dias, configurável. | E0 | ✅ Implementado localmente | packages/db/migrations/0005 attribution_policies (default last_paid_click 7d); packages/domain/src/attribution/engine.ts | packages/domain/test/attribution.test.ts, apps/api/test/integration/tracking-attribution.test.ts |  |  |
| R02-07 | Identificação determinística; nunca vincular pessoas apenas por IP. | E0 | ✅ Implementado localmente | Vínculo só por token/IDs; nenhuma junção por IP | apps/api/test/integration/tracking-attribution.test.ts |  |  |
| R02-08 | Envio externo de eventos desligado até conexão, validação e definição de emissor responsável. | E0 | ✅ Implementado localmente | packages/db/migrations/0006 conversion_destinations.status default disabled; ALLOW_EXTERNAL_DELIVERY | apps/api/test/integration/deliveries-relay.test.ts |  |  |
| R02-09 | Gestão de mídia inicialmente em leitura; escrita habilitada por permissão e configuração. | E0 | ⏳ Planejado | Escrita de mídia não implementada (somente leitura planejada) |  | DEP-META-APP |  |
| R02-10 | Regras automáticas em simulação inicialmente; execução habilitada por regra e escopo. | E0 | ⏳ Planejado | Motor de regras (E6) |  |  |  |
| R02-11 | Ambientes local/teste separados de homologação e produção. | E0 | 🟡 Parcial | APP_ENV; bancos tracker_dev/test/e2e separados; connections.environment | — | DEP-HOSTING | Homologação/produção dependem de hospedagem |
| R02-12 | Defaults alteráveis por organização. | E0 | 🟡 Parcial | organizations.timezone/currency/mfa_required/settings; políticas por org | auth-isolation.test.ts |  |  |
| R02-13 | Escopo completo inclui captura, UTMs, atribuição, vendas, produtos, custos, anúncios, pixels, CAPI, diagnósticos, relatórios, regras, IA, W… | E0 | 📄 Método/documento | docs/PRD.md; esta matriz |  |  |  |
| R02-14 | Dependência externa de um conector não bloqueia módulos independentes; progresso preservado entre sessões. | E0 | 📄 Método/documento | docs/STATUS.md; docs/EXTERNAL_DEPENDENCIES.md |  |  |  |

### 03. Regras invioláveis

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R03-01 | Não inventar endpoints, eventos, campos, escopos OAuth, autenticações ou capacidades de provedores. | E0 | ✅ Implementado localmente | Nenhum endpoint inventado; Lowify só com campos documentados; Meta a partir do SDK oficial | lowify.test.ts |  |  |
| R03-02 | Consultar documentação oficial atual antes de cada integração; registrar URL, data, produto e versão. | E0 | 🟡 Parcial | Manifestos com URL/data/versão em packages/connectors; docs oficiais Meta/Google/TikTok inacessíveis neste ambiente | — | DEP-OFFICIAL-DOCS |  |
| R03-03 | Separar fixtures sintéticas, exemplos documentados e amostras reais anonimizadas. | E0 | ✅ Implementado localmente | packages/connectors/test/fixtures/README.md (documentado × sintético × real) | — |  |  |
| R03-04 | Não marcar como funcionando integração que só salva credenciais, mostra botão ou retorna dados falsos. | E0 | ✅ Implementado localmente | Catálogo com estado real; conexão só "Conectada" após evento autenticado | apps/api/test/integration/webhook-pipeline.test.ts |  |  |
| R03-05 | Não usar dados simulados em métricas de produção; demonstrações isoladas e identificadas. | E0 | ✅ Implementado localmente | organizations.is_demo; demo nunca enviada a destinos (T68) | apps/api/test/integration/deliveries-relay.test.ts |  |  |
| R03-06 | Compra aprovada exige fonte financeira confiável (não página de obrigado, clique, Pix gerado ou formulário). | E0 | ✅ Implementado localmente | Aprovação somente por evento financeiro do checkout/confirmação manual auditada | packages/domain/test/financial.test.ts |  |  |
| R03-07 | Falta de informação não vira zero: desconhecido, indisponível, desatualizado e sem atribuição são estados distintos. | E0 | ✅ Implementado localmente | MetricResult undefined/unavailable/partial; categorias de atribuição distintas | packages/domain/test/metrics-fixture.test.ts |  |  |
| R03-08 | Não prometer 100% de rastreamento, redução de CPA, nota de pixel ou lucro automático. | E0 | ✅ Implementado localmente | Textos sem promessas; limitações exibidas | — |  |  |
| R03-09 | Cada funcionalidade com comportamento observável e critério de aceite. | E0 | 📄 Método/documento | Critérios em testes automatizados | pnpm test |  |  |
| R03-10 | Não solicitar segredos em mensagens, commits ou screenshots; usar configuração local, formulários protegidos e armazenamento seguro. | E0 | ✅ Implementado localmente | Segredos em .env local, formulários protegidos, cofre cifrado; nunca pedidos em mensagens | — |  |  |
| R03-11 | Não copiar o mesmo Purchase para vários emissores sem estratégia de deduplicação comprovada. | E0 | ✅ Implementado localmente | Emissor responsável único por destino (purchase_emitter) | apps/api/test/integration/deliveries-relay.test.ts (T43) |  |  |
| R03-12 | Não publicar anúncios, alterar orçamento, cobrar ou enviar mensagens reais em testes. | E0 | ✅ Implementado localmente | ALLOW_EXTERNAL_DELIVERY=false por padrão; testes usam servidor HTTP local | deliveries-relay.test.ts |  |  |
| R03-13 | Adotar defaults para decisões reversíveis e registrá-las; perguntar apenas bloqueios materiais. | E0 | 📄 Método/documento | docs/DECISIONS.md | — |  |  |
| R03-14 | Dados externos (páginas, mensagens, nomes de campanha, payloads) são dados não confiáveis, nunca instruções. | E0 | ✅ Implementado localmente | Macros/nomes tratados como dados; IA não implementada | attribution tests |  |  |

### 04. Método de trabalho

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R04-01 | Inspecionar arquivos, dependências, configuração e Git antes de alterar; respeitar trabalho existente. | E0 | 📄 Método/documento | docs/*, commits pequenos, testes executados antes de declarar | pnpm test |  |  |
| R04-02 | Manter `docs/PRD.md`, `ARCHITECTURE.md`, `REQUIREMENTS_TRACEABILITY.md`, `INTEGRATIONS_MATRIX.md`, `METRICS_DICTIONARY.md`, `STATUS.md`, `D… | E0 | 📄 Método/documento | docs/*, commits pequenos, testes executados antes de declarar | pnpm test |  |  |
| R04-03 | Requisitos com identificadores estáveis, sem perda por compactação de contexto. | E0 | 📄 Método/documento | docs/*, commits pequenos, testes executados antes de declarar | pnpm test |  |  |
| R04-04 | Cada bloco: delimitar, implementar, verificar falhas reais, atualizar estado; commits pequenos; nunca declarar teste não executado. | E0 | 📄 Método/documento | docs/*, commits pequenos, testes executados antes de declarar | pnpm test |  |  |

### 05. Arquitetura de referência

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R05-01 | TypeScript ponta a ponta, monorepo modular (`apps/web`, `apps/api`, `apps/worker`, `packages/tracker`, `packages/domain`, `packages/connect… | E1 | 🟡 Parcial | apps/{api,worker,web}, packages/{domain,connectors,db,contracts,tracker} | — |  | packages/ui e apps/mobile ainda não criados (componentes em apps/web/components) |
| R05-02 | PostgreSQL (Supabase como alvo) para banco, autenticação e armazenamento privado. | E1 | 🟡 Parcial | PostgreSQL 16 com SQL compatível com Supabase (packages/db/migrations) | rls.itest.ts | DEP-SUPABASE | Auth própria (D-003); Supabase Auth/Storage não usados localmente |
| R05-03 | Fila BullMQ com Redis persistente, trabalhadores duráveis e tarefas idempotentes. | E1 | ✅ Implementado localmente | apps/worker/src/main.ts, apps/worker/src/relay.ts (BullMQ 6 + ioredis) | apps/api/test/integration/deliveries-relay.test.ts (T23) |  |  |
| R05-04 | Outbox transacional no PostgreSQL; a fila não é o único registro de trabalho. | E1 | ✅ Implementado localmente | packages/db/migrations/0003 outbox + app.outbox_claim | apps/api/test/integration/deliveries-relay.test.ts, webhook-pipeline.test.ts (T22) |  |  |
| R05-05 | pnpm workspaces; ferramentas adicionais só com benefício concreto. | E1 | ✅ Implementado localmente | pnpm-workspace.yaml | — |  |  |
| R05-06 | Zod para validar entradas e contratos. | E1 | ✅ Implementado localmente | zod em API e contratos | canonical-meta.test.ts |  |  |
| R05-07 | Biblioteca de tabelas/gráficos adequada a muitos registros, paginação no servidor e acessibilidade. | E1 | 🟡 Parcial | Tabelas paginadas no servidor e gráficos SVG acessíveis próprios | E2E |  | Colunas selecionáveis/redimensionáveis pendentes (R23-09) |
| R05-08 | Vitest para domínio; Playwright para jornadas de interface. | E1 | ✅ Implementado localmente | vitest (unit/integration) + Playwright | 131 testes + E2E |  |  |
| R05-09 | Logs estruturados, métricas e rastreamento de erros com dados sensíveis removidos. | E1 | 🟡 Parcial | apps/api/src/lib/logger.ts (pino com redação) | — | DEP-OBSERVABILITY | Métricas/rastreamento de erros externos pendentes |
| R05-10 | Versões estáveis fixadas, runtime registrado e lockfile. | E1 | ✅ Implementado localmente | Versões fixadas em package.json, pnpm-lock.yaml, .node-version 22.22.2 | — |  |  |
| R05-11 | Regras de negócio compartilhadas; web, API, worker e app não têm fórmulas financeiras independentes. | E1 | ✅ Implementado localmente | packages/domain/src/metrics/* usado pela API (metrics-repo apenas soma) | packages/domain/test/metrics-fixture.test.ts |  |  |

### 06. Autenticação, organizações e permissões

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R06-01 | Cadastro, login, verificação de e-mail, recuperação de senha e encerramento de sessões. | E1 | ✅ Implementado localmente | apps/api/src/services/auth.ts, routes/auth.ts, apps/web/app/(auth)/* | apps/api/test/integration/auth-isolation.test.ts, E2E |  |  |
| R06-02 | Proteção contra abuso (rate limit, bloqueio progressivo) em autenticação. | E1 | ✅ Implementado localmente | Bloqueio progressivo por e-mail/IP (iam.auth_attempts) + rate limit | apps/api/test/integration/auth-isolation.test.ts |  |  |
| R06-03 | MFA para perfis sensíveis. | E1 | ✅ Implementado localmente | TOTP RFC 6238, anti-replay, organizations.mfa_required, assertPermission(sensitive) | apps/api/test/integration/auth-isolation.test.ts |  |  |
| R06-04 | Login Google somente quando configurado; sem integração social inventada. | E1 | ⛔ Bloqueado externamente | Login Google não implementado |  | DEP-GOOGLE-APP |  |
| R06-05 | Usuário em várias organizações por associação explícita; organização é a fronteira de isolamento. | E1 | ✅ Implementado localmente | memberships; RLS por organização | apps/api/test/integration/auth-isolation.test.ts, rls.itest.ts |  |  |
| R06-06 | Organização contém projetos, domínios, integrações, contas de anúncio, produtos, dashboards e regras. | E1 | 🟡 Parcial | projects, provider_connections, ad_accounts, products, attribution_policies por org | — |  | Dashboards salvos e regras ainda não modelados |
| R06-07 | Projeto pode ter membros e permissões mais restritas. | E1 | ✅ Implementado localmente | project_memberships + assertProjectAccess | breakdown-projects.test.ts (R06-07: pedidos, detalhe, métricas, série, detalhamento, exportação, conexões) |  | Projeto inexistente/de outra organização → 400 |
| R06-08 | Agência acessa clientes por vínculos explícitos e revogáveis, sem bypass genérico. | E1 | 🟡 Parcial | packages/db/migrations/0009 agency_links (explícito e revogável) | — |  | Fluxo de UI/API de agência pendente (E8) |
| R06-09 | Perfis: Proprietário, Administrador, Gestor, Analista, Financeiro, Cliente/leitor com capacidades definidas. | E1 | ✅ Implementado localmente | packages/domain/src/permissions.ts ROLE_PERMISSIONS | packages/domain/test/utm-money-time.test.ts, auth-isolation.test.ts |  |  |
| R06-10 | Permissões granulares: ler métricas, ler dados pessoais, exportar, configurar pixel, conectar provedor, administrar membros, alterar custos… | E1 | ✅ Implementado localmente | packages/domain/src/permissions.ts PERMISSIONS | auth-isolation.test.ts |  |  |
| R06-11 | Convite com token de uso único e expiração. | E1 | ✅ Implementado localmente | invites.token_hash, expires_at, accepted_at | apps/api/test/integration/auth-isolation.test.ts |  |  |
| R06-12 | Alteração de permissão revoga acesso efetivo rapidamente. | E1 | ✅ Implementado localmente | RLS app.member_org_id() avaliado a cada consulta | rls.itest.ts, auth-isolation.test.ts (T54) |  |  |
| R06-13 | Troca de organização limpa cache, assinaturas em tempo real e seleções anteriores. | E1 | ✅ Implementado localmente | apps/web/lib/api.ts setOrgId limpa cache e visões | E2E (parcial) |  |  |
| R06-14 | Testes de vazamento por busca, exportação, URLs diretas e WebSocket/SSE. | E1 | 🟡 Parcial | Testes de URL direta, cabeçalho de org e exportação | auth-isolation.test.ts (T52) |  | Realtime/SSE ainda não existem; busca coberta pela listagem |

### 07. Banco de dados e invariantes

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R07-01 | Mapa de domínio com grupos: Identidade, Operação, Integrações, Mídia, Rastreamento, Financeiro, Atribuição, Transporte, CRM, WhatsApp, Anál… | E1 | 🟡 Parcial | packages/db/migrations/0001–0011 | — |  | Grupos CRM, WhatsApp, Análise, Ações e SaaS ainda não criados (sem tabelas vazias antecipadas) |
| R07-02 | `organization_id` em entidades de negócio; `project_id` quando aplicável. | E1 | ✅ Implementado localmente | packages/db/migrations/* | packages/db/test/rls.itest.ts |  |  |
| R07-03 | FKs compostas ou verificação equivalente impedindo relações entre organizações. | E1 | ✅ Implementado localmente | packages/db/migrations/* | packages/db/test/rls.itest.ts |  |  |
| R07-04 | Dinheiro em inteiro na menor unidade (ou decimal exato) com moeda/escala; nunca ponto flutuante. | E1 | ✅ Implementado localmente | packages/db/migrations/* | packages/db/test/rls.itest.ts |  |  |
| R07-05 | IDs externos como strings opacas (inclusive IDs de anúncio). | E1 | ✅ Implementado localmente | packages/db/migrations/* | packages/db/test/rls.itest.ts |  |  |
| R07-06 | `occurred_at`, `received_at`, `processed_at`, `source_updated_at` distintos. | E1 | ✅ Implementado localmente | occurred_at/received_at/processed_at/source_updated_at distintos (orders, receipts, entries) | webhook-pipeline.test.ts |  |  |
| R07-07 | Valores originais e normalizados rastreáveis; evidência de origem não sobrescrita. | E1 | ✅ Implementado localmente | webhook_receipts.body bruto preservado; normalized_events; declared_tracking | webhook-pipeline.test.ts |  |  |
| R07-08 | Unicidade garantida no banco. | E1 | ✅ Implementado localmente | packages/db/migrations/* | packages/db/test/rls.itest.ts |  |  |
| R07-09 | Índices por organização, período, IDs de origem, estado e cursores. | E1 | ✅ Implementado localmente | packages/db/migrations/* | packages/db/test/rls.itest.ts |  |  |
| R07-10 | Filtros de período `[início, fim)`. | E1 | ✅ Implementado localmente | packages/domain/src/time.ts localDateRangeToUtc [início, fim) | utm-money-time.test.ts (T47) |  |  |
| R07-11 | Migrações reproduzíveis com estratégia de reversão/correção. | E1 | ✅ Implementado localmente | packages/db/src/migrate.ts (checksum, lock, transação) | global-setup aplica em banco limpo |  |  |
| R07-12 | RLS e grants em tabelas, views e funções expostas; views sem bypass involuntário. | E1 | ✅ Implementado localmente | packages/db/migrations/* | packages/db/test/rls.itest.ts |  |  |
| R07-13 | Credenciais fora de tabelas/schemas expostos ao cliente. | E1 | ✅ Implementado localmente | private.credentials só para tracker_system; AES-256-GCM | rls.itest.ts |  |  |
| R07-14 | Workers privilegiados validam organização, conexão e projeto em toda execução; funções privilegiadas pequenas e auditáveis. | E1 | ✅ Implementado localmente | Worker valida org/conexão/projeto (processReceipt); funções SECURITY DEFINER mínimas | rls.itest.ts |  |  |

### 08. Modelo canônico de eventos

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R08-01 | Contrato interno versionado (`schema_version`) próprio, não confundido com formato de checkout. | E2 | ✅ Implementado localmente | packages/contracts/src/canonical-event.ts | canonical-meta.test.ts |  |  |
| R08-02 | Organização e projeto resolvidos pelo servidor a partir da conexão; ignorar `organization_id` do corpo público. | E2 | ✅ Implementado localmente | Org/projeto resolvidos pelo endpoint; organization_id do corpo ignorado | canonical-meta.test.ts, webhook-pipeline.test.ts (T21) |  |  |
| R08-03 | Schemas tratam obrigatórios, opcionais e desconhecidos sem adivinhar estados ou dinheiro. | E2 | ✅ Implementado localmente | Zod com obrigatórios/opcionais; campos desconhecidos listados | canonical-meta.test.ts (T20) |  |  |
| R08-04 | Dados pessoais em estrutura restrita, não propagados automaticamente; procedência, finalidade e retenção registradas. | E2 | ✅ Implementado localmente | order_contacts (restrito, retenção, finalidade); PII fora de normalized_events | webhook-pipeline.test.ts |  |  |
| R08-05 | Vocabulário interno: `checkout.started`, `payment.pending`, `payment.approved`, `payment.failed`, `refund.created`, `refund.succeeded`, `di… | E2 | ✅ Implementado localmente | INTERNAL_EVENT_TYPES; conectores mapeiam só o documentado | lowify.test.ts |  |  |

### 09. Recebimento confiável de webhooks

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R09-01 | Resolver conexão por identificador opaco e verificar situação. | E2 | ✅ Implementado localmente | apps/api/src/services/ingest-webhook.ts, apps/worker/src/dispatch.ts, handlers/process-receipt.ts | webhook-pipeline.test.ts |  |  |
| R09-02 | Limitar tamanho, método, taxa e tipo de conteúdo. | E2 | ✅ Implementado localmente | bodyLimit 256 KiB, POST, content-type JSON, rate limit por endpoint | webhook-pipeline.test.ts (T19) |  |  |
| R09-03 | Preservar corpo bruto quando a autenticação exigir. | E2 | ✅ Implementado localmente | apps/api/src/services/ingest-webhook.ts, apps/worker/src/dispatch.ts, handlers/process-receipt.ts | webhook-pipeline.test.ts |  |  |
| R09-04 | Validar assinatura/token e política de replay por provedor. | E2 | ✅ Implementado localmente | apps/api/src/services/ingest-webhook.ts, apps/worker/src/dispatch.ts, handlers/process-receipt.ts | webhook-pipeline.test.ts |  |  |
| R09-05 | Persistir recebimento, chave de idempotência e trabalho pendente em transação durável. | E2 | ✅ Implementado localmente | apps/api/src/services/ingest-webhook.ts, apps/worker/src/dispatch.ts, handlers/process-receipt.ts | webhook-pipeline.test.ts |  |  |
| R09-06 | Responder rápido, após persistência, sem aguardar CAPI/relatórios/IA. | E2 | ✅ Implementado localmente | 200 após commit; processamento assíncrono via outbox | webhook-pipeline.test.ts |  |  |
| R09-07 | Normalizar e processar no worker com transações e locks. | E2 | ✅ Implementado localmente | apps/api/src/services/ingest-webhook.ts, apps/worker/src/dispatch.ts, handlers/process-receipt.ts | webhook-pipeline.test.ts |  |  |
| R09-08 | Atualizar pedido e lançamentos; efeitos externos por outbox. | E2 | ✅ Implementado localmente | apps/api/src/services/ingest-webhook.ts, apps/worker/src/dispatch.ts, handlers/process-receipt.ts | webhook-pipeline.test.ts |  |  |
| R09-09 | Agendar atribuição, agregações e notificações sem duplicar efeitos. | E2 | 🟡 Parcial | attribution.compute e destinations.fanout por outbox com dedup | webhook-pipeline.test.ts |  | Notificações e agregações incrementais pendentes |
| R09-10 | Registrar tentativas, erro acionável, próxima tentativa e resultado final. | E2 | ✅ Implementado localmente | outbox.attempts/last_error/available_at; delivery_attempts; status de recebimento | deliveries-relay.test.ts |  |  |
| R09-11 | Sem persistência, não confirmar recebimento. | E2 | ✅ Implementado localmente | 503 quando a persistência falha (routes/ingest.ts) | — |  | Teste de falha de banco dedicado pendente |
| R09-12 | Evento válido desconhecido guardado para diagnóstico sem virar venda. | E2 | ✅ Implementado localmente | apps/api/src/services/ingest-webhook.ts, apps/worker/src/dispatch.ts, handlers/process-receipt.ts | webhook-pipeline.test.ts |  |  |
| R09-13 | Requisição não autenticada rejeitada sem alterar finanças. | E2 | ✅ Implementado localmente | apps/api/src/services/ingest-webhook.ts, apps/worker/src/dispatch.ts, handlers/process-receipt.ts | webhook-pipeline.test.ts |  |  |
| R09-14 | Idempotência em camadas: recebimento (org+conta+evento), pedido (org+provedor+conta+pedido), transação (identidade da cobrança/captura/esto… | E2 | ✅ Implementado localmente | apps/api/src/services/ingest-webhook.ts, apps/worker/src/dispatch.ts, handlers/process-receipt.ts | webhook-pipeline.test.ts |  |  |
| R09-15 | Reconexões/dois webhooks da mesma conta não criam duas vendas. | E2 | ✅ Implementado localmente | apps/api/src/services/ingest-webhook.ts, apps/worker/src/dispatch.ts, handlers/process-receipt.ts | webhook-pipeline.test.ts |  |  |
| R09-16 | Sem ID de evento: fingerprint determinístico de campos estáveis (sem horário de recebimento), limitações documentadas e detecção de colisão. | E2 | ✅ Implementado localmente | Fingerprint sha256 do corpo sem horário; colisão logada | lowify.test.ts |  |  |
| R09-17 | Tratar repetição, concorrência, perda de conexão após commit, fora de ordem e falha após envio externo; não ordenar só pela data do webhook. | E2 | ✅ Implementado localmente | apps/api/src/services/ingest-webhook.ts, apps/worker/src/dispatch.ts, handlers/process-receipt.ts | webhook-pipeline.test.ts |  |  |
| R09-18 | Backoff exponencial com jitter, limite de tentativas, dead letters, circuit breaker por provedor e reprocessamento seletivo. | E2 | ✅ Implementado localmente | Backoff exponencial com jitter, max_attempts, status dead, circuit breaker, reprocessamento seletivo | deliveries-relay.test.ts |  |  |
| R09-19 | Reprocessar contabilidade/atribuição não reenvia conversões externas automaticamente. | E2 | ✅ Implementado localmente | Fanout só em aprovação nova; recálculo não reenvia | deliveries-relay.test.ts, tracking-attribution.test.ts (T27) |  |  |
| R09-20 | Autenticação fraca/não documentada: registrar risco e usar consulta autenticada de confirmação quando disponível; não aceitar qualquer JSON… | E2 | 🟡 Parcial | Lowify sem assinatura: risco registrado, token opaco; consulta de confirmação indisponível | lowify.test.ts | DEP-LOWIFY-AUTH |  |
| R09-21 | Segredos em URL protegidos contra exposição em logs e interface. | E2 | ✅ Implementado localmente | Token hasheado; URL exibida uma vez; logs com URL mascarada | webhook-pipeline.test.ts |  |  |

### 10. Pedidos, cobranças e ciclo financeiro

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R10-01 | Separar pedido, tentativa de pagamento, transação confirmada, itens, estornos, disputas, comissão e repasse; status de pagamento separado d… | E2 | ✅ Implementado localmente | packages/domain/src/financial/order-aggregate.ts; packages/db/migrations/0004 | packages/domain/test/financial.test.ts |  |  |
| R10-02 | Pix gerado, boleto emitido e cartão recusado não somam faturamento aprovado. | E2 | ✅ Implementado localmente | packages/domain/src/financial/order-aggregate.ts; packages/db/migrations/0004 | packages/domain/test/financial.test.ts |  |  |
| R10-03 | Várias tentativas de pagamento do mesmo pedido não multiplicam vendas. | E2 | ✅ Implementado localmente | packages/domain/src/financial/order-aggregate.ts; packages/db/migrations/0004 | packages/domain/test/financial.test.ts |  |  |
| R10-04 | Capturas parciais/complementares seguem semântica documentada do provedor. | E2 | 🟡 Parcial | Várias transações aprovadas somam; semântica de captura parcial por provedor não documentada | financial.test.ts | DEP-LOWIFY-SAMPLES |  |
| R10-05 | Order bump no mesmo pedido soma valor e itens sem criar outra compra. | E2 | ✅ Implementado localmente | packages/domain/src/financial/order-aggregate.ts; packages/db/migrations/0004 | packages/domain/test/financial.test.ts |  |  |
| R10-06 | Upsell/downsell com outra transação gera registro próprio com vínculo ao pedido original quando comprovado. | E2 | ✅ Implementado localmente | orders.parent_order_id/parent_external_order_id (migração 0012); apps/worker/src/handlers/process-receipt.ts linkParentOrders (mesma conta lógica e projeto; resolução adiada quando o original chega depois); upsell herda vínculo por token do original (attribution.ts) | order-links-settlements.test.ts (T16) |  | Somente declaração explícita da origem (parent_order_id do contrato canônico). Lowify não documenta vínculo de upsell (DEP-LOWIFY-TRACKING) |
| R10-07 | Não vincular compras apenas por e-mail coincidente. | E2 | ✅ Implementado localmente | Nenhuma junção por e-mail | order-links-settlements.test.ts (mesmo e-mail sem declaração e conta de outro provedor não vinculam) |  |  |
| R10-08 | Parcela de cartão não é nova compra; distinguir captura, recebível e liquidação. | E2 | ✅ Implementado localmente | settlement.scheduled/paid/canceled no contrato canônico (adição compatível ao v1.0); tabela public.settlements fora do razão de receita; payment_transactions.installments informativo | order-links-settlements.test.ts (T18); financial.test.ts; canonical-meta.test.ts |  | Lowify não documenta parcelas/repasses; métricas por movimento financeiro ainda não exibem repasses |
| R10-09 | Renovação de assinatura é receita nova separável da aquisição inicial. | E2 | ✅ Implementado localmente | packages/domain/src/financial/order-aggregate.ts; packages/db/migrations/0004 | packages/domain/test/financial.test.ts |  |  |
| R10-10 | Estorno parcial preserva histórico e reduz líquido pela quantia efetiva. | E2 | ✅ Implementado localmente | packages/domain/src/financial/order-aggregate.ts; packages/db/migrations/0004 | packages/domain/test/financial.test.ts |  |  |
| R10-11 | Chargeback, reembolso e reversão não subtraem o mesmo valor duas vezes. | E2 | ✅ Implementado localmente | packages/domain/src/financial/order-aggregate.ts; packages/db/migrations/0004 | packages/domain/test/financial.test.ts |  |  |
| R10-12 | Disputa ganha restaura valor retido mediante evento confiável. | E2 | ✅ Implementado localmente | packages/domain/src/financial/order-aggregate.ts; packages/db/migrations/0004 | packages/domain/test/financial.test.ts |  |  |
| R10-13 | Pendente atrasado não rebaixa cobrança confirmada. | E2 | ✅ Implementado localmente | packages/domain/src/financial/order-aggregate.ts; packages/db/migrations/0004 | packages/domain/test/financial.test.ts |  |  |
| R10-14 | Estorno antes da confirmação guardado e reconciliado sem fabricar aprovação. | E2 | ✅ Implementado localmente | packages/domain/src/financial/order-aggregate.ts; packages/db/migrations/0004 | packages/domain/test/financial.test.ts |  |  |
| R10-15 | Bases de receita separadas para afiliado, produtor e coprodutor. | E2 | ✅ Implementado localmente | provider_accounts.revenue_role; org_share no razão; métrica org_revenue | financial.test.ts, metrics-fixture.test.ts (T51) |  |  |
| R10-16 | Conciliação por API oficial ou exportação importada: pedidos ausentes, valores divergentes, estados conflitantes e reparação auditável. | E2 | ⏳ Planejado | Conciliação por exportação importada (E3) |  | DEP-LOWIFY-EXPORT |  |

### 11. Estrutura dos conectores

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R11-01 | Interfaces tipadas: `CheckoutConnector`, `AdNetworkConnector`, `ConversionDestination`, `CRMConnector`, `MessagingConnector`, `ExportDestin… | E2 | 🟡 Parcial | packages/connectors/src/types.ts (Checkout, AdNetwork, ConversionDestination completos; CRM/Messaging/Export como contrato mínimo) | — |  |  |
| R11-02 | Capacidades declaradas individualmente por conector. | E2 | ✅ Implementado localmente | packages/connectors/src/types.ts CapabilityDeclaration por capacidade | canonical-meta.test.ts (catálogo) |  |  |
| R11-03 | Estados de implementação: Planejado, Em pesquisa, Bloqueado externamente, Implementado localmente, Validado em sandbox, Validado em produçã… | E2 | ✅ Implementado localmente | ImplementationState + rótulos | canonical-meta.test.ts |  |  |
| R11-04 | Estados de conexão: desconectada, aguardando configuração, aguardando permissão, conectada, token expirado, revogada, falha temporária, sin… | E2 | ✅ Implementado localmente | provider_connections.status (8 estados) | webhook-pipeline.test.ts |  |  |
| R11-05 | Manifesto por integração: provedor/produto, URLs oficiais, versão, autenticação, escopos, webhooks, transporte de UTMs/token, dinheiro e un… | E2 | ✅ Implementado localmente | ConnectorManifest (URLs, versão, auth, dinheiro, fuso, limites, capacidades, testes, limitações) | — |  |  |
| R11-06 | Não usar documentação de conta bancária/Pix como documentação do checkout do mesmo fornecedor. | E2 | ✅ Implementado localmente | Lowify: somente internal-webhook.md (checkout); planos de banking/Pix não usados como doc do checkout | — |  |  |

### 12. Catálogo de checkouts e pagamentos

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R12-01 | Arquitetura para todos os conectores listados (Lowify; Kiwify, Hotmart, Cakto, Kirvano, PerfectPay, Ticto, Eduzz, Braip, Monetizze; Lastlin… | E5/E10 | 🟡 Parcial | packages/connectors/src/catalog.ts (todos os conectores listados com estado real) | canonical-meta.test.ts |  | Implementados: Lowify (local), sistema próprio; demais planejados/pesquisa |
| R12-02 | Implementar primeiro os com documentação verificável e acesso; sem implementações fictícias. | E5/E10 | ✅ Implementado localmente | Sem implementações fictícias | canonical-meta.test.ts |  |  |
| R12-03 | Catálogo complementar (lista pública UTMify: MundPay … KitePay) registrado para pesquisa; confirmar identidade, domínio, produto e APIs; se… | E5/E10 | ✅ Implementado localmente | Catálogo complementar marcado "a pesquisar" | — |  |  |
| R12-04 | Sistema próprio: API autenticada e webhook canônico assinado. | E5/E10 | ✅ Implementado localmente | packages/connectors/src/checkout/canonical.ts (HMAC + anti-replay + rotação) | canonical-meta.test.ts, webhook-pipeline.test.ts |  |  |
| R12-05 | Para cada conector implementado: cadastro orientado, credenciais protegidas, eventos selecionáveis, validação de autenticação, amostras ano… | E5/E10 | 🟡 Parcial | Lowify: cadastro orientado, URL protegida, eventos selecionáveis, normalização, testes de repetição/estorno, instruções | lowify.test.ts | DEP-LOWIFY-SAMPLES | Amostras reais anonimizadas e reconciliação pendentes |
| R12-06 | Mapeador genérico não é chamado de "integração nativa" sem validar eventos e regras do provedor. | E5/E10 | ✅ Implementado localmente | Lowify "Implementado localmente", não "nativa validada" | — |  |  |

### 13. SDK próprio de rastreamento

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R13-01 | Script instalável em uma linha, identificador público de projeto (não é segredo, não autentica vendas) e versão controlada. | E2 | ✅ Implementado localmente | packages/tracker/src/index.ts | packages/tracker/test/sdk.test.ts |  |  |
| R13-02 | Inicialização assíncrona, instalação única e isolamento de variáveis. | E2 | ✅ Implementado localmente | packages/tracker/src/index.ts | packages/tracker/test/sdk.test.ts |  |  |
| R13-03 | Captura de visita, origem, página, referência permitida, sessão e UTMs. | E2 | ✅ Implementado localmente | packages/tracker/src/index.ts | packages/tracker/test/sdk.test.ts |  |  |
| R13-04 | Eventos PageView, ViewContent, Lead, AddToCart, InitiateCheckout, clique em checkout e próprios. | E2 | ✅ Implementado localmente | packages/tracker/src/index.ts | packages/tracker/test/sdk.test.ts |  |  |
| R13-05 | Distinguir clique no botão de checkout de checkout iniciado. | E2 | ✅ Implementado localmente | packages/tracker/src/index.ts | packages/tracker/test/sdk.test.ts |  |  |
| R13-06 | Capturar `fbclid`, `gclid`, `gbraid`, `wbraid`, `ttclid`, `msclkid`, `_fbp`, `_fbc` quando disponíveis e permitidos. | E2 | ✅ Implementado localmente | packages/tracker/src/index.ts | packages/tracker/test/sdk.test.ts |  |  |
| R13-07 | Não fabricar click IDs/cookies de plataforma; formatos derivados só conforme documentação do destino. | E2 | ✅ Implementado localmente | packages/tracker/src/index.ts | packages/tracker/test/sdk.test.ts |  |  |
| R13-08 | Preservar separadamente primeiro toque, último toque e último toque pago elegível. | E2 | ✅ Implementado localmente | packages/tracker/src/index.ts | packages/tracker/test/sdk.test.ts |  |  |
| R13-09 | Suporte a páginas tradicionais, SPA/mudança de rota, links dinâmicos, formulários e múltiplas etapas. | E2 | 🟡 Parcial | packages/tracker/src/index.ts | packages/tracker/test/sdk.test.ts |  | SPA (pushState/popstate), links dinâmicos por delegação; formulários não são capturados por design (R13-13) |
| R13-10 | Adaptadores de iframe só com cooperação e origem verificada em `postMessage`. | E2 | ✅ Implementado localmente | Adaptador postMessage com frameOrigins | — |  | Teste dedicado pendente |
| R13-11 | Fila curta, lotes, `sendBeacon`/`fetch`, limites de tamanho e repetição sem travar a página. | E2 | ✅ Implementado localmente | packages/tracker/src/index.ts | packages/tracker/test/sdk.test.ts |  |  |
| R13-12 | API pública documentada (`init`, `track`, `setConsent`, `linkCheckout`, `identify`, `reset`) com validação. | E2 | ✅ Implementado localmente | packages/tracker/src/index.ts | packages/tracker/test/sdk.test.ts |  |  |
| R13-13 | `identify` só com identidade fornecida voluntariamente; nunca capturar formulários automaticamente. | E2 | ✅ Implementado localmente | identify envia somente hash SHA-256 com consentimento | — |  | Vínculo por identidade no servidor pendente (evidência 4) |
| R13-14 | Respeitar CSP, sem `eval` ou acesso invasivo ao DOM. | E2 | ✅ Implementado localmente | packages/tracker/src/index.ts | packages/tracker/test/sdk.test.ts |  |  |
| R13-15 | Compatibilidade documentada: HTML, WordPress/Elementor, Webflow, Wix, Shopify, WooCommerce, React/Next.js, GTM, Typebot e construtores. | E2 | 🟡 Parcial | apps/web/app/(app)/instalacao (instruções por plataforma) | — |  | Validação em cada plataforma pendente |
| R13-16 | Domínio próprio de coleta com DNS/TLS verificados, nunca para contornar consentimento/bloqueios. | E2 | ⏳ Planejado | Domínio próprio de coleta (NEXT_PUBLIC_COLLECT_URL) sem verificação DNS/TLS |  | DEP-HOSTING |  |
| R13-17 | CDN, versionamento, rollback e implantação gradual do SDK. | E2 | 🟡 Parcial | SDK versionado (/sdk/v1, versão no banner, cache 5 min) | — | DEP-HOSTING | CDN/rollback gradual pendentes |
| R13-18 | Consentimento explícito por finalidade (armazenamento, analytics, publicidade). | E2 | ✅ Implementado localmente | packages/tracker/src/index.ts | packages/tracker/test/sdk.test.ts |  |  |
| R13-19 | Padrão: sem persistência/envio publicitário sem sinal de consentimento; políticas alternativas fundamentadas por finalidade, sem bypass glo… | E2 | ✅ Implementado localmente | packages/tracker/src/index.ts | packages/tracker/test/sdk.test.ts |  |  |
| R13-20 | Funcionamento limitado sem storage/cookies/JS/identificação, sem prometer rastreamento integral. | E2 | ✅ Implementado localmente | packages/tracker/src/index.ts | packages/tracker/test/sdk.test.ts |  |  |
| R13-21 | Preservar UTMs sem copiar dados pessoais, senhas ou parâmetros de autenticação para logs. | E2 | ✅ Implementado localmente | packages/tracker/src/index.ts | packages/tracker/test/sdk.test.ts |  |  |
| R13-22 | URL sanitizada (caminho + parâmetros permitidos). | E2 | ✅ Implementado localmente | packages/tracker/src/index.ts | packages/tracker/test/sdk.test.ts |  |  |
| R13-23 | Sem fingerprinting, canvas, leitura de campos sensíveis ou união por IP. | E2 | ✅ Implementado localmente | packages/tracker/src/index.ts | packages/tracker/test/sdk.test.ts |  |  |
| R13-24 | Orçamento de tamanho/impacto medido; sem alegar "zero impacto"; testes com scripts existentes e falhas de rede. | E2 | ✅ Implementado localmente | Orçamento 6 KiB gzip verificado no build (4,3 KiB) | pnpm sdk:build |  |  |

### 14. Gerador de UTMs, links e instalação

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R14-01 | Gerador visual com presets por rede, produto e funil; `utm_source/medium/campaign/content/term` e campos de IDs. | E2 | ✅ Implementado localmente | packages/domain/src/utm/builder.ts; apps/web/app/(app)/origem | utm-money-time.test.ts |  |  |
| R14-02 | Templates dinâmicos só com macros oficialmente suportadas pela rede. | E2 | 🟡 Parcial | packages/domain/src/utm/macros.ts (verified=false) | — | DEP-OFFICIAL-DOCS | Macros a revalidar nas docs oficiais |
| R14-03 | Detectar placeholders não expandidos e UTMs inválidas. | E2 | ✅ Implementado localmente | packages/domain/src/utm/builder.ts | utm-money-time.test.ts (T38) |  |  |
| R14-04 | Preservar case de IDs opacos, acentos, Unicode e parâmetros existentes. | E2 | ✅ Implementado localmente | packages/domain/src/utm/builder.ts | utm-money-time.test.ts (T38) |  |  |
| R14-05 | Evitar dupla codificação, dupla interrogação e destruição de fragmentos. | E2 | ✅ Implementado localmente | packages/domain/src/utm/builder.ts | utm-money-time.test.ts (T38) |  |  |
| R14-06 | Separar parâmetros de campanha dos de checkout/afiliação. | E2 | ✅ Implementado localmente | packages/domain/src/utm/builder.ts | utm-money-time.test.ts (T38) |  |  |
| R14-07 | Não sobrescrever afiliado, cupom, oferta ou token de segurança. | E2 | ✅ Implementado localmente | packages/domain/src/utm/builder.ts | utm-money-time.test.ts (T38) |  |  |
| R14-08 | Taxonomia editável, presets e histórico de alterações. | E2 | ⏳ Planejado | Taxonomia/links curtos/QR/importação (E2 restante) |  |  |  |
| R14-09 | Links curtos com domínio validado, destino permitido, proteção contra open redirect e abuso. | E2 | ⏳ Planejado | Taxonomia/links curtos/QR/importação (E2 restante) |  |  |  |
| R14-10 | QR codes para campanhas físicas, sem prometer identidade de quem escaneou. | E2 | ⏳ Planejado | Taxonomia/links curtos/QR/importação (E2 restante) |  |  |  |
| R14-11 | Importar/exportar templates e links; link de teste e diagnóstico de instalação. | E2 | 🟡 Parcial | Validador de URL recebida na UI; importação/exportação pendente | — |  |  |
| R14-12 | Instruções específicas e verificadas por plataforma. | E2 | 🟡 Parcial | Instruções por plataforma na tela de instalação | — |  |  |
| R14-13 | Assistente de instalação verifica evento de teste real, domínio, consentimento, campos e passagem até o checkout; "código copiado" ≠ "rastr… | E2 | 🟡 Parcial | Tela de instalação mostra eventos reais recebidos; passagem validada pelo diagnóstico do pedido | E2E |  |  |

### 15. Passagem de origem entre página e checkout

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R15-01 | Por checkout, confirmar: parâmetros aceitos no link/criação; preservação em redirecionamentos/upsells; retorno no webhook/consulta; limites… | E2 | 🟡 Parcial | Lowify: retorno de UTMs documentado; parâmetros aceitos na URL/upsell não documentados | — | DEP-LOWIFY-TRACKING |  |
| R15-02 | Preferir token opaco, temporário, sem dados pessoais, vinculado a organização e projeto; integridade protegida e destino validado. | E2 | ✅ Implementado localmente | apps/worker/src/handlers/attribution.ts; apps/api/src/routes/diagnostics.ts | tracking-attribution.test.ts |  |  |
| R15-03 | Não presumir cookies disponíveis entre domínios. | E2 | ✅ Implementado localmente | Token emitido pelo servidor e passado por parâmetro; sem dependência de cookies entre domínios | E2E |  |  |
| R15-04 | Sem token de retorno: usar campos de origem suportados e declarar granularidade. | E2 | ✅ Implementado localmente | apps/worker/src/handlers/attribution.ts; apps/api/src/routes/diagnostics.ts | tracking-attribution.test.ts |  |  |
| R15-05 | Sem ligação confiável: guardar a venda e marcá-la sem atribuição; não adivinhar anúncio. | E2 | ✅ Implementado localmente | apps/worker/src/handlers/attribution.ts; apps/api/src/routes/diagnostics.ts | tracking-attribution.test.ts |  |  |
| R15-06 | URL pública não altera valor, organização ou status de pagamento. | E2 | ✅ Implementado localmente | apps/worker/src/handlers/attribution.ts; apps/api/src/routes/diagnostics.ts | tracking-attribution.test.ts |  |  |
| R15-07 | Campos de atribuição declarados podem ser falsificados: preservar origem da evidência, validar pertencimento de IDs e diferenciar declaraçã… | E2 | ✅ Implementado localmente | apps/worker/src/handlers/attribution.ts; apps/api/src/routes/diagnostics.ts | tracking-attribution.test.ts |  |  |
| R15-08 | Página de diagnóstico: visita capturada, token criado, parâmetro enviado, parâmetro recebido, pedido associado e motivo de perda; sem token… | E2 | ✅ Implementado localmente | apps/worker/src/handlers/attribution.ts; apps/api/src/routes/diagnostics.ts | tracking-attribution.test.ts |  |  |

### 16. Motor de atribuição

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R16-01 | Políticas versionadas com comparação entre modelos: primeiro toque, último toque, último não direto, primeiro clique pago elegível, último … | E2 | ✅ Implementado localmente | Política principal (default) versionada + políticas de comparação (até 6 ativas); API /v1/attribution/* e tela Atribuição; comparação por categoria e receita creditada por rede; seletor de política no painel | attribution-customers.test.ts; attribution.test.ts; E2E |  |  |
| R16-02 | Janelas configuráveis (1, 7, 14, 30 dias), internas, sem replicar configuração das redes. | E2 | ✅ Implementado localmente | Janelas 1/7/14/30 dias por política, editáveis por nova versão (histórico preservado) | attribution-customers.test.ts |  |  |
| R16-03 | Aplicar pela data do toque e da conversão real, não do recebimento do webhook. | E2 | ✅ Implementado localmente | packages/domain/src/attribution/*; apps/worker/src/handlers/attribution.ts | attribution.test.ts, tracking-attribution.test.ts |  |  |
| R16-04 | Hierarquia de evidência: token↔pedido; origem do checkout com IDs validados; sessão/visitante persistidos; identidade própria fornecida com… | E2 | ✅ Implementado localmente | packages/domain/src/attribution/*; apps/worker/src/handlers/attribution.ts | attribution.test.ts, tracking-attribution.test.ts |  |  |
| R16-05 | IP, proximidade temporal, dispositivo ou valor não comprovam identidade; click IDs não são decodificados como se revelassem anúncio. | E2 | ✅ Implementado localmente | packages/domain/src/attribution/*; apps/worker/src/handlers/attribution.ts | attribution.test.ts, tracking-attribution.test.ts |  |  |
| R16-06 | Persistir modelo, versão, janela, toque, IDs, tipo de evidência, qualidade, data do cálculo, motivo e origem manual. | E2 | ✅ Implementado localmente | packages/domain/src/attribution/*; apps/worker/src/handlers/attribution.ts | attribution.test.ts, tracking-attribution.test.ts |  |  |
| R16-07 | Relatórios indicam recálculo; recalcular não muda o webhook nem reenvia Purchase. | E2 | ✅ Implementado localmente | packages/domain/src/attribution/*; apps/worker/src/handlers/attribution.ts; recálculo explícito por período (POST /v1/attribution/recompute, até 5000 vendas) sem Purchase | attribution.test.ts, tracking-attribution.test.ts; attribution-customers.test.ts |  |  |
| R16-08 | Separar pago conhecido, orgânico conhecido, direto, recuperação, sem atribuição (ausente/inválido/expirado/conflitante). | E2 | ✅ Implementado localmente | packages/domain/src/attribution/*; apps/worker/src/handlers/attribution.ts | attribution.test.ts, tracking-attribution.test.ts |  |  |
| R16-09 | Crédito de clique anterior após retorno pela bio conforme política/janela; exibir caminho observado; sem prometer paridade com a Meta. | E2 | ✅ Implementado localmente | packages/domain/src/attribution/*; apps/worker/src/handlers/attribution.ts | attribution.test.ts, tracking-attribution.test.ts |  |  |
| R16-10 | Modelos fracionados: pesos somam 1; receita não multiplica; "conversões creditadas" ≠ pedidos inteiros. | E2 | ✅ Implementado localmente | packages/domain/src/attribution/*; apps/worker/src/handlers/attribution.ts | attribution.test.ts, tracking-attribution.test.ts |  |  |
| R16-11 | Renovações não atribuídas indefinidamente à aquisição sem visão de coorte. | E2 | ✅ Implementado localmente | Renovações (revenue_kind=renewal) contam na receita bruta pela data da renovação e ficam fora da receita atribuída à aquisição nas bases por aprovação/movimento e nas campanhas; base por coorte credita a receita posterior do cliente à atribuição da primeira compra | metrics-bases.test.ts |  |  |
| R16-12 | Métricas internas separadas das conversões reportadas pelas redes; não somar conversões de várias redes como compradores únicos; view-throu… | E2 | ✅ Implementado localmente | Métricas internas separadas; conversões das redes não somadas (aviso no painel) | — |  |  |

### 17. Pixels, Meta CAPI e deduplicação

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R17-01 | Múltiplos destinos por organização com roteamento por projeto, domínio, produto e evento. | E4 | 🟡 Parcial | Vários destinos por org; roteamento por projeto | deliveries-relay.test.ts |  | Roteamento por domínio/produto/evento pendente |
| R17-02 | Configuração de Pixel/dataset ID e credencial no servidor, teste de conexão, versão da API, eventos habilitados e diagnóstico. | E4 | 🟡 Parcial | Pixel ID, token cifrado, versão, eventos; teste honesto (bloqueado sem egress) | deliveries-relay.test.ts | DEP-META-APP |  |
| R17-03 | Modelar evento, horário original, origem da ação, moeda, valor, produtos e identificadores permitidos. | E4 | ✅ Implementado localmente | packages/connectors/src/destinations/meta-capi.ts; apps/worker/src/handlers/deliveries.ts | canonical-meta.test.ts, deliveries-relay.test.ts | DEP-META-APP |  |
| R17-04 | Purchase apenas com política financeira e confirmação válidas. | E4 | ✅ Implementado localmente | packages/connectors/src/destinations/meta-capi.ts; apps/worker/src/handlers/deliveries.ts | canonical-meta.test.ts, deliveries-relay.test.ts | DEP-META-APP |  |
| R17-05 | Hash somente nos campos exigidos pela documentação; não aplicar hash a click IDs, cookies, IP ou User-Agent. | E4 | ✅ Implementado localmente | packages/connectors/src/destinations/meta-capi.ts; apps/worker/src/handlers/deliveries.ts | canonical-meta.test.ts, deliveries-relay.test.ts | DEP-META-APP |  |
| R17-06 | IP/User-Agent do comprador apenas quando capturados e permitidos; nunca IP do servidor do checkout. | E4 | ✅ Implementado localmente | packages/connectors/src/destinations/meta-capi.ts; apps/worker/src/handlers/deliveries.ts | canonical-meta.test.ts, deliveries-relay.test.ts | DEP-META-APP |  |
| R17-07 | Não fabricar e-mail, telefone, nome ou localização. | E4 | ✅ Implementado localmente | packages/connectors/src/destinations/meta-capi.ts; apps/worker/src/handlers/deliveries.ts | canonical-meta.test.ts, deliveries-relay.test.ts | DEP-META-APP |  |
| R17-08 | Preservar consentimento, parâmetros de privacidade e restrições por destino. | E4 | 🟡 Parcial | packages/connectors/src/destinations/meta-capi.ts; apps/worker/src/handlers/deliveries.ts | canonical-meta.test.ts, deliveries-relay.test.ts | DEP-META-APP | Consentimento de publicidade respeitado; data_processing_options (LDU) não implementado |
| R17-09 | Identificador semântico estável por compra/transação, destino e ambiente, reutilizado em tentativas. | E4 | ✅ Implementado localmente | packages/connectors/src/destinations/meta-capi.ts; apps/worker/src/handlers/deliveries.ts | canonical-meta.test.ts, deliveries-relay.test.ts | DEP-META-APP |  |
| R17-10 | Coordenar `event_name` e `event_id` entre navegador e servidor conforme Meta (grafias diferentes entre pixel e API). | E4 | 🟡 Parcial | event_id estável; coordenação com pixel do navegador pendente | — | DEP-META-DOCS |  |
| R17-11 | Event ID independente do horário de envio e não recriado em retry. | E4 | ✅ Implementado localmente | packages/connectors/src/destinations/meta-capi.ts; apps/worker/src/handlers/deliveries.ts | canonical-meta.test.ts, deliveries-relay.test.ts | DEP-META-APP |  |
| R17-12 | Navegador só emite Purchase após confirmação confiável, com o mesmo ID do servidor. | E4 | ⏳ Planejado | Purchase no navegador após confirmação (endpoint de confirmação) pendente |  |  |  |
| R17-13 | Sem coordenação com pixel nativo do checkout: escolher emissor responsável e documentar o que desativar. | E4 | ✅ Implementado localmente | packages/connectors/src/destinations/meta-capi.ts; apps/worker/src/handlers/deliveries.ts | canonical-meta.test.ts, deliveries-relay.test.ts | DEP-META-APP |  |
| R17-14 | Order bumps, upsells e assinaturas sem contar a mesma transação duas vezes. | E4 | ✅ Implementado localmente | packages/connectors/src/destinations/meta-capi.ts; apps/worker/src/handlers/deliveries.ts | canonical-meta.test.ts, deliveries-relay.test.ts | DEP-META-APP |  |
| R17-15 | Respeitar limite de idade dos eventos, tamanho de lote e regras da API. | E4 | 🟡 Parcial | Idade máxima 7 dias e lote 1000 como hipóteses a revalidar | canonical-meta.test.ts (T28) | DEP-META-DOCS |  |
| R17-16 | Painel de entrega: recebido, validado, em fila, enviado, aceito, rejeitado, aguardando reenvio, expirado, não elegível; aceite ≠ correspond… | E4 | ✅ Implementado localmente | packages/connectors/src/destinations/meta-capi.ts; apps/worker/src/handlers/deliveries.ts | canonical-meta.test.ts, deliveries-relay.test.ts | DEP-META-APP |  |
| R17-17 | Registrar HTTP, código do provedor, tentativa, latência e trace id sem conteúdo sensível. | E4 | ✅ Implementado localmente | packages/connectors/src/destinations/meta-capi.ts; apps/worker/src/handlers/deliveries.ts | canonical-meta.test.ts, deliveries-relay.test.ts | DEP-META-APP |  |
| R17-18 | Métricas oficiais de qualidade só quando disponíveis; indicador interno rotulado e explicado. | E4 | ✅ Implementado localmente | Não exibe EMQ; indicador interno não criado | — |  |  |
| R17-19 | Sem Purchase negativo para reembolso; usar ajustes suportados ou corrigir relatório interno e mostrar limitação. | E4 | ✅ Implementado localmente | packages/connectors/src/destinations/meta-capi.ts; apps/worker/src/handlers/deliveries.ts | canonical-meta.test.ts, deliveries-relay.test.ts | DEP-META-APP |  |
| R17-20 | Proteção de domínios não vendida como invulnerabilidade de Pixel ID público. | E4 | ✅ Implementado localmente | packages/connectors/src/destinations/meta-capi.ts; apps/worker/src/handlers/deliveries.ts | canonical-meta.test.ts, deliveries-relay.test.ts | DEP-META-APP |  |

### 18. Outros destinos de conversão

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R18-01 | Adaptadores independentes: TikTok Pixel + Events API; Google Ads/Data Manager API; GA4; Microsoft Advertising; Pinterest, Snapchat, LinkedI… | E5 | 🟡 Parcial | Catálogo com TikTok/Google/GA4/Microsoft/Pinterest/Snapchat/LinkedIn/Kwai/Taboola/Outbrain; webhook próprio de saída pendente | — | DEP-GOOGLE-APP, DEP-TIKTOK-APP |  |
| R18-02 | Google: confirmar rota atual (restrições ao UploadClickConversions legado; Data Manager API); GA4 MP não substitui conversões do Google Ads. | E5 | ⛔ Bloqueado externamente | Rota Data Manager a confirmar |  | DEP-GOOGLE-DOCS |  |
| R18-03 | `gclid`, `gbraid`, `wbraid` guardados sem tratar como intercambiáveis. | E5 | ✅ Implementado localmente | gclid/gbraid/wbraid guardados separadamente | attribution.test.ts |  |  |
| R18-04 | Normalização e hash específicos por destino. | E5 | ✅ Implementado localmente | Normalização/hash específicos no adaptador Meta | canonical-meta.test.ts |  |  |
| R18-05 | Deduplicação, IDs de pedido, janelas, moedas, ação, ambiente e reembolsos definidos por adaptador; HTTP positivo não comprova processamento… | E5 | 🟡 Parcial | Definido para Meta; demais adaptadores pendentes |  |  |  |

### 19. Integração Meta Ads

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R19-01 | Conexão oficial, seleção de negócios/contas autorizados, permissões, revogação, reconexão, expiração e saúde. | E3 | ⛔ Bloqueado externamente | Adaptador Meta Ads (parser) |  | DEP-META-APP |  |
| R19-02 | Distinguir permissões de leitura, administração e envio de eventos. | E3 | ⛔ Bloqueado externamente | Adaptador Meta Ads (parser) |  | DEP-META-APP |  |
| R19-03 | Requisitos de acesso para contas próprias/terceiros (acesso avançado, App Review) documentados, sem contornar revisão. | E3 | ⛔ Bloqueado externamente | Adaptador Meta Ads (parser) |  | DEP-META-APP |  |
| R19-04 | Sincronizar contas (moeda, fuso, estado, limites, saldo quando expostos). | E3 | ⛔ Bloqueado externamente | Adaptador Meta Ads (parser) |  | DEP-META-APP |  |
| R19-05 | Sincronizar campanhas, conjuntos, anúncios, criativos, nomes, IDs e hierarquia. | E3 | ⛔ Bloqueado externamente | Adaptador Meta Ads (parser) |  | DEP-META-APP |  |
| R19-06 | Objetivos, orçamento, estado configurado e efetivo. | E3 | ⛔ Bloqueado externamente | Adaptador Meta Ads (parser) |  | DEP-META-APP |  |
| R19-07 | Investimento, impressões, alcance, cliques por tipo, CPC, CPM, CTR, frequência. | E3 | 🟡 Parcial | packages/connectors/src/ads/meta-ads.ts (parser de insights) | canonical-meta.test.ts | DEP-META-APP |  |
| R19-08 | Ações/resultados/conversões da Meta com definição e janela. | E3 | ⛔ Bloqueado externamente | Adaptador Meta Ads (parser) |  | DEP-META-APP |  |
| R19-09 | Métricas de vídeo, posicionamento e detalhamentos válidos respeitando combinações. | E3 | ⛔ Bloqueado externamente | Adaptador Meta Ads (parser) |  | DEP-META-APP |  |
| R19-10 | Junções por IDs estáveis, histórico de nomes, ativos excluídos/arquivados; renomear não perde vendas. | E3 | 🟡 Parcial | ad_entities por ID estável + ad_entity_names | — | DEP-META-APP |  |
| R19-11 | Paginação, relatórios assíncronos, rate limits, quota por organização, cache, incremental e backfill. | E3 | ⛔ Bloqueado externamente | Adaptador Meta Ads (parser) |  | DEP-META-APP |  |
| R19-12 | Ressincronizar período recente sem somar snapshots repetidos. | E3 | ✅ Implementado localmente | Upsert por (conta, nível, entidade, dia, fonte) substitui snapshot | webhook-pipeline.test.ts (T45) |  |  |
| R19-13 | Status de sincronização com período coberto e última atualização. | E3 | 🟡 Parcial | ad_accounts.synced_from/synced_to/last_synced_at exibidos | — |  |  |
| R19-14 | Alerta de saldo baixo só com campo válido; ausência de saldo ≠ zero. | E3 | ✅ Implementado localmente | Saldo não lido; nenhum alerta de saldo | — |  |  |

### 20. Outras redes e custos externos

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R20-01 | Catálogo: Meta, Google, TikTok, Microsoft, Pinterest, LinkedIn, Snapchat, Kwai, Taboola, Outbrain (ordem Meta → Google/TikTok → demais). | E3/E5 | ✅ Implementado localmente | Catálogo de redes | — |  |  |
| R20-02 | Capacidades separadas por rede: conexão, contas, gastos, hierarquia, detalhamentos, gestão, conversões; modelo comum com extensões (ex.: gr… | E3/E5 | 🟡 Parcial | Capacidades separadas no manifesto; modelo comum com níveis | — |  |  |
| R20-03 | Google: OAuth, contas gerenciadoras, requisitos de acesso; TikTok: autorização, anunciantes, cotas. | E3/E5 | ⛔ Bloqueado externamente | Google/TikTok OAuth |  | DEP-GOOGLE-APP, DEP-TIKTOK-APP |  |
| R20-04 | Custos sem API (influenciadores, afiliados, offline, impulsionamentos, outras despesas). | E3/E5 | ✅ Implementado localmente | apps/api/src/routes/costs.ts cost_entries (categorias) | — |  |  |
| R20-05 | Importação CSV com prévia, mapeamento, moeda, fuso, período, entidade, validação e prevenção de duplicidade. | E3/E5 | ✅ Implementado localmente | Importação CSV com prévia, mapeamento, moeda/fuso da conta, validação, duplicidade | webhook-pipeline.test.ts |  |  |
| R20-06 | Valor manual com origem identificada, sem mistura silenciosa com gasto importado. | E3/E5 | ✅ Implementado localmente | Fonte (api/csv/manual) guardada; uma fonte por dia/entidade no cálculo | — |  |  |

### 21. Conciliação e qualidade dos dados

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R21-01 | Centro de qualidade cobrindo vendas, mídia, atribuição e transporte. | E3 | 🟡 Parcial | apps/web/app/(app)/diagnostico; /v1/diagnostics/overview | webhook-pipeline.test.ts |  |  |
| R21-02 | Comparar pedidos/valores com exportação/API do checkout. | E3 | ⏳ Planejado | Conciliação com exportação do checkout |  | DEP-LOWIFY-EXPORT |  |
| R21-03 | Comparar gastos com a rede no mesmo período, moeda, conta, nível e timezone. | E3 | ⏳ Planejado | Comparação de gastos com a rede |  | DEP-META-APP |  |
| R21-04 | Guardar cobertura e intervalos não sincronizados. | E3 | ✅ Implementado localmente | Cobertura por conta e notas no resultado | webhook-pipeline.test.ts |  |  |
| R21-05 | Diferenciar atraso esperado, erro de conexão, permissão insuficiente, dados incompatíveis e divergência financeira. | E3 | 🟡 Parcial | Estados de conexão e motivos de recebimento distintos |  |  |  |
| R21-06 | Detectar queda de eventos, ausência de vendas com tráfego, vendas sem origem crescendo, token expirado, fila acumulada e mudança de schema. | E3 | 🟡 Parcial | Alertas: quarentena, mortos, rejeições, fila, vendas sem origem, conexões degradadas | webhook-pipeline.test.ts |  |  |
| R21-07 | Backfill com intervalo, prévia de volume, cota e rastreabilidade. | E3 | ⏳ Planejado | Backfill com prévia de volume |  | DEP-META-APP |  |
| R21-08 | Importações históricas atualizam relatórios sem reenviar conversões. | E3 | ✅ Implementado localmente | Importações não disparam fanout (somente aprovações novas) | deliveries-relay.test.ts |  |  |
| R21-09 | Evitar dupla contagem entre níveis campanha/conjunto/anúncio e breakdowns. | E3 | ✅ Implementado localmente | Um nível por conta e dia (o mais agregado disponível no dia); uma fonte por dia/entidade | breakdown-projects.test.ts (T46) |  |  |
| R21-10 | Não somar alcance diário para alcance mensal; frequência não é soma de frequências. | E3 | ✅ Implementado localmente | Alcance só como dado bruto diário; frequência não somada | — |  |  |
| R21-11 | Exibir fórmulas e denominadores; médias ponderadas com totais corretos. | E3 | ✅ Implementado localmente | Fórmula e denominador em cada card | E2E |  |  |
| R21-12 | Snapshot/versão dos dados usados em exportações e avaliações de regras. | E3 | ⏳ Planejado | Snapshot versionado de exportações/regras |  |  |  |
| R21-13 | Correções registram autor, mudança e relatórios recalculados; nunca apagar evidência original. | E3 | ✅ Implementado localmente | audit_logs; evidência original preservada; reprocessamento auditado | auth-isolation.test.ts |  |  |

### 22. Dicionário financeiro e fórmulas

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R22-01 | Serviço único de métricas compartilhado por dashboard, API, relatórios, regras, IA e app; cada métrica declara fonte, fórmula, denominador,… | E3 | ✅ Implementado localmente | packages/domain/src/metrics/*; apps/api/src/services/metrics-repo.ts | metrics-fixture.test.ts, webhook-pipeline.test.ts |  |  |
| R22-02 | Bases temporais: por aprovação, por movimento financeiro, por coorte de aquisição; nunca apresentadas como iguais. | E3 | ✅ Implementado localmente | basisCtes (apps/api/src/services/metrics-repo.ts): aprovação por transação no período com reversões até as_of; movimento por data do lançamento; coorte por clientes com primeira compra no período e receita posterior até as_of; mesmo escopo no resumo, série, campanhas, comparação e API pública | metrics-bases.test.ts; webhook-pipeline.test.ts; metrics-fixture.test.ts |  |  |
| R22-03 | Por aprovação: estornos posteriores ajustam a coorte até `as_of`, mantendo bruto original e histórico. | E3 | ✅ Implementado localmente | packages/domain/src/metrics/*; apps/api/src/services/metrics-repo.ts | metrics-fixture.test.ts, webhook-pipeline.test.ts |  |  |
| R22-04 | Métricas: pedidos gerados, aprovados brutos, retidos, receita bruta aprovada, estornos financeiros, receita após estornos, receita da organ… | E3 | ✅ Implementado localmente | 27 métricas no registro, incluindo clientes adquiridos e LTV observado (somente coorte, nunca previsão) | metrics-bases.test.ts; metrics-fixture.test.ts |  |  |
| R22-05 | Denominador zero/inexistente → "—" com razão; conversões fracionadas rotuladas. | E3 | ✅ Implementado localmente | packages/domain/src/metrics/*; apps/api/src/services/metrics-repo.ts | metrics-fixture.test.ts, webhook-pipeline.test.ts |  |  |
| R22-06 | Custos versionados por vigência: taxa % e fixa de checkout, gateway, antecipação, parcelamento, impostos estimados, comissão, coprodução, c… | E3 | 🟡 Parcial | fee_schedules, cost_entries; antecipação/parcelamento/coprodução como categorias pendentes | — |  |  |
| R22-07 | Priorizar valores reais do provedor; estimativas identificadas; não subtrair taxa duas vezes quando a origem envia líquido. | E3 | ✅ Implementado localmente | packages/domain/src/metrics/*; apps/api/src/services/metrics-repo.ts | metrics-fixture.test.ts, webhook-pipeline.test.ts |  |  |
| R22-08 | Custos materiais ausentes → "resultado parcial" com custos faltantes; nunca chamar faturamento − anúncios de lucro líquido. | E3 | ✅ Implementado localmente | packages/domain/src/metrics/*; apps/api/src/services/metrics-repo.ts | metrics-fixture.test.ts, webhook-pipeline.test.ts |  |  |
| R22-09 | ROAS/CPA de equilíbrio com margem conhecida; sem margem não positiva, moedas misturadas ou premissas ocultas. | E3 | ✅ Implementado localmente | packages/domain/src/metrics/*; apps/api/src/services/metrics-repo.ts | metrics-fixture.test.ts, webhook-pipeline.test.ts |  |  |
| R22-10 | Multimoeda: valor original preservado, câmbio identificado/datado/configurável; sem taxa válida separar moedas; sem taxa fixa inventada. | E3 | 🟡 Parcial | Moedas separadas; exchange_rates cadastráveis; consolidação com câmbio na API pendente | utm-money-time.test.ts |  |  |

### 23. Dashboard

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R23-01 | Painel profissional, responsivo, tema claro/escuro, acessível, densidade ajustável, layout original. | E3 | 🟡 Parcial | Painel responsivo, tema claro/escuro, foco visível | E2E |  | Densidade ajustável pendente |
| R23-02 | Elementos globais: organização/projeto, período, comparação, fuso, moeda, última atualização. | E3 | ✅ Implementado localmente | Org, projeto, período, comparação, fuso, moeda, atualização | E2E |  |  |
| R23-03 | Filtros: checkout, produto, oferta, fonte, rede, conta, campanha, conjunto, anúncio, status, método. | E3 | 🟡 Parcial | Filtros de projeto, status, atribuição e busca | — |  |  |
| R23-04 | Modelo e janela de atribuição visíveis. | E3 | ✅ Implementado localmente | Política/janela exibidas | E2E |  |  |
| R23-05 | Seletor métricas internas vs reportadas pelas redes, sem misturar. | E3 | 🟡 Parcial | Somente métricas internas; métricas das redes aguardam sincronização | — | DEP-META-APP |  |
| R23-06 | Indicador de sincronização parcial, dados estimados e integrações com falha. | E3 | ✅ Implementado localmente | Qualidade parcial/estimada e alertas de integração no painel | E2E |  |  |
| R23-07 | Cards configuráveis (investimento, receita, aprovadas, retidas, CPA, ROAS, ticket, estornos, contribuição, leads, vendas sem atribuição) qu… | E3 | ✅ Implementado localmente | Cards com definição e link para registros | E2E |  |  |
| R23-08 | Gráficos: evolução receita/gasto/contribuição, vendas por hora/dia, composição por produto/canal, funil, qualidade da atribuição; sem empil… | E3 | 🟡 Parcial | Evolução diária, vendas por hora, qualidade da atribuição; composição por rede/campanha/conjunto/anúncio em /v1/reports/breakdown e tela Campanhas | E2E; breakdown-projects.test.ts |  | Composição por produto e funil pendentes |
| R23-09 | Tabelas: colunas selecionáveis, ordenação, redimensionar, fixar, visões salvas, busca, paginação no servidor, filtros compostos, tags, tota… | E3 | 🟡 Parcial | Paginação por cursor, filtros, exportação; detalhamento hierárquico campanha → anúncio com totais corretos (gasto total vs detalhado explicitados) | breakdown-projects.test.ts (T46 drill-down) |  | Colunas selecionáveis, visões salvas e tags pendentes |
| R23-10 | Múltiplos dashboards (produto, cliente, projeto, consolidado autorizado), modelos, duplicação, ordem de widgets e compartilhamento controla… | E3 | ⏳ Planejado | Múltiplos dashboards salvos |  |  |  |
| R23-11 | Metas e alertas de receita, contribuição, gasto, CPA, ROAS; notificações informam o que mudou. | E3 | ⏳ Planejado | Metas e alertas |  |  |  |

### 24. Vendas, produtos e clientes

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R24-01 | Lista de vendas: busca por pedido, filtros, origem, valores, taxas, status, método, produto, oferta, cupom, afiliado, histórico; dados pess… | E2/E3 | ✅ Implementado localmente | apps/web/app/(app)/vendas; /v1/orders | E2E |  |  |
| R24-02 | Detalhe da venda: linha do tempo, recebimentos, eventos, itens, pagamentos, reembolsos, evidência de atribuição, destinos e conciliação; co… | E2/E3 | ✅ Implementado localmente | apps/web/app/(app)/vendas/[id]; /v1/orders/:id | E2E |  |  |
| R24-03 | Produtos: grupos, ofertas, planos, preço de referência, custos com vigência, mapeamento de IDs externos por provedor; mesmo nome em checkou… | E2/E3 | 🟡 Parcial | Produto por (conta, ID externo), sem unificar por nome | webhook-pipeline.test.ts |  | Grupos/ofertas/planos e custos por produto pendentes |
| R24-04 | Clientes: histórico, primeira compra, recorrência, receita/contribuição, consentimentos, vínculos; deduplicação explicável e reversível; se… | E2/E3 | 🟡 Parcial | Clientes por e-mail normalizado (hash) dentro da organização: histórico, primeira/última compra, recorrência, aprovado/líquido por moeda, consentimentos observados, exclusões reversíveis auditadas; PII mascarada sem pii.read | attribution-customers.test.ts; E2E |  | Contribuição por cliente pendente (custos variáveis por pedido ainda não alocados); LTV observado por coorte disponível no painel |
| R24-05 | Vendas manuais/offline por API ou formulário com permissão, origem, comprovante e auditoria; confirmação manual ≠ checkout; correções por a… | E2/E3 | ✅ Implementado localmente | POST /v1/orders/manual e POST /public/v1/sales (serviço createManualSale; auditado com actor_type user/api_key; provedor "manual") | webhook-pipeline.test.ts; public-api.test.ts |  |  |
| R24-06 | E-commerce: pagamento, cancelamento, devolução, frete e atendimento separados; respeitar mecanismos de extensão de cada loja. | E2/E3 | ⏳ Planejado | E-commerce (frete/devolução) |  |  |  |

### 25. Gestão de campanhas

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R25-01 | Consultar/filtrar campanhas, conjuntos/grupos e anúncios nas redes implementadas. | E6 | 🟡 Parcial | Consulta somente leitura de campanhas/conjuntos/anúncios a partir de gastos importados e IDs declarados (apps/web/app/(app)/campanhas; /v1/reports/breakdown) | breakdown-projects.test.ts; E2E T70 | DEP-META-APP | Consulta direta na API da rede e filtros por status dependem do app Meta |
| R25-02 | Pausar, ativar, renomear e editar campos permitidos. | E6 | ⏳ Planejado | Etapa E6 |  | DEP-META-APP |  |
| R25-03 | Orçamento absoluto/percentual respeitando unidade, moeda, mínimo, teto e nível (CBO/ABO). | E6 | ⏳ Planejado | Etapa E6 |  | DEP-META-APP |  |
| R25-04 | Ações em lote com resultado por item, sem repetir concluídos. | E6 | ⏳ Planejado | Etapa E6 |  | DEP-META-APP |  |
| R25-05 | Duplicar na mesma conta e entre contas com remapeamento explícito e validação de ativos. | E6 | ⏳ Planejado | Etapa E6 |  | DEP-META-APP |  |
| R25-06 | Histórico de alterações com autor, regra/IA e antes/depois. | E6 | ⏳ Planejado | Etapa E6 |  | DEP-META-APP |  |
| R25-07 | Criação rápida guiada com presets e validação de objetivo, orçamento, destino, pixel, evento, criativo, identidade, público e UTMs. | E6 | ⏳ Planejado | Etapa E6 |  | DEP-META-APP |  |
| R25-08 | Biblioteca de criativos próprios/autorizados com upload, prévia e metadados. | E6 | ⏳ Planejado | Etapa E6 |  | DEP-META-APP |  |
| R25-09 | Antes de executar: objetos, conta, moeda, valores, limites e validade; revalidar no servidor; políticas autorizadas sem confirmação repetid… | E6 | ⏳ Planejado | Etapa E6 |  | DEP-META-APP |  |
| R25-10 | Novas campanhas/duplicações pausadas por padrão; publicação explícita. | E6 | ⏳ Planejado | Etapa E6 |  | DEP-META-APP |  |
| R25-11 | Timeout em escrita → reconciliar antes de repetir; "desfazer" é compensatório e limitado. | E6 | ⏳ Planejado | Etapa E6 |  | DEP-META-APP |  |

### 26. Motor de regras

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R26-01 | Construtor visual AND/OR com escopo, agenda, timezone, período, fonte de métrica, janela de atribuição, amostra mínima e ação; sem código a… | E6 | ⏳ Planejado | Etapa E6 |  |  |  |
| R26-02 | Condições: gasto, aprovadas/retidas, CPA, ROAS, contribuição, CTR, CPC, CPM, frequência, idade, status, variação de orçamento, saldo real. | E6 | ⏳ Planejado | Etapa E6 |  |  |  |
| R26-03 | Ações: alertar, pausar, ativar, ajustar orçamento, duplicar, tag, webhook autorizado. | E6 | ⏳ Planejado | Etapa E6 |  |  |  |
| R26-04 | Simulação sem escrita com relatório. | E6 | ⏳ Planejado | Etapa E6 |  |  |  |
| R26-05 | Versão imutável da regra e registro dos dados usados. | E6 | ⏳ Planejado | Etapa E6 |  |  |  |
| R26-06 | Cooldown, teto diário de ações, teto de gasto/orçamento e variação máxima. | E6 | ⏳ Planejado | Etapa E6 |  |  |  |
| R26-07 | Lock por entidade, idempotência e prevenção de ciclos. | E6 | ⏳ Planejado | Etapa E6 |  |  |  |
| R26-08 | Política de conflito explícita. | E6 | ⏳ Planejado | Etapa E6 |  |  |  |
| R26-09 | Sem execução com fonte atrasada/incompleta/indisponível; faltante ≠ zero. | E6 | ⏳ Planejado | Etapa E6 |  |  |  |
| R26-10 | Excluir itens em aprendizagem por padrão; respeitar atraso de conversão e janela mínima. | E6 | ⏳ Planejado | Etapa E6 |  |  |  |
| R26-11 | Circuit breaker (integração, relógio, permissão, reconciliação); parada por regra, projeto, organização e sistema. | E6 | ⏳ Planejado | Etapa E6 |  |  |  |
| R26-12 | Explicação legível de cada execução/falha/não-execução; reversão limitada e teste antes da ativação. | E6 | ⏳ Planejado | Etapa E6 |  |  |  |
| R26-13 | Presets desligados e rotulados como exemplo; simulação histórica não prova causalidade. | E6 | ⏳ Planejado | Etapa E6 |  |  |  |

### 27. Gestor com IA

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R27-01 | Assistente que analisa campanhas, explica indicadores, aponta inconsistências, sugere ações e gera relatórios. | E6 | ⏳ Planejado | Etapa E6 |  | DEP-AI |  |
| R27-02 | Provedores intercambiáveis (OpenAI, Anthropic, Google, chaves próprias); modelos não fixados sem consulta. | E6 | ⏳ Planejado | Etapa E6 |  | DEP-AI |  |
| R27-03 | Fluxos: contribuição negativa, mudança de ROAS (observação vs hipótese), vendas sem origem, comparação de criativos com amostra, sugestão d… | E6 | ⏳ Planejado | Etapa E6 |  | DEP-AI |  |
| R27-04 | Ferramentas tipadas e autorizadas; nunca SQL arbitrário do modelo. | E6 | ⏳ Planejado | Etapa E6 |  | DEP-AI |  |
| R27-05 | Cálculos pelo serviço de métricas. | E6 | ⏳ Planejado | Etapa E6 |  | DEP-AI |  |
| R27-06 | Afirmações vinculadas a valores, filtros, período, fontes e atualização; fato vs interpretação vs hipótese vs recomendação vs ausente. | E6 | ⏳ Planejado | Etapa E6 |  | DEP-AI |  |
| R27-07 | Limitação de amostra; sem causalidade não demonstrada. | E6 | ⏳ Planejado | Etapa E6 |  | DEP-AI |  |
| R27-08 | Auditoria de consultas/ações com retenção e mascaramento; sem payloads/dados pessoais por padrão. | E6 | ⏳ Planejado | Etapa E6 |  | DEP-AI |  |
| R27-09 | Nomes de campanha/páginas/mensagens tratados como não confiáveis (anti prompt injection). | E6 | ⏳ Planejado | Etapa E6 |  | DEP-AI |  |
| R27-10 | Sem chave/conectividade: estado indisponível, sem simular análise. | E6 | ⏳ Planejado | Etapa E6 |  | DEP-AI |  |
| R27-11 | Limites de custo, chamadas, tokens, concorrência e cancelamento por organização. | E6 | ⏳ Planejado | Etapa E6 |  | DEP-AI |  |
| R27-12 | Modos: análise, sugestão, execução sob política; mesma autorização/limites/idempotência das regras; sem acesso direto irrestrito. | E6 | ⏳ Planejado | Etapa E6 |  | DEP-AI |  |

### 28. WhatsApp

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R28-01 | Medir leads e vendas originados/recuperados pelo WhatsApp via APIs oficiais ou provedores autorizados; sem automação não oficial. | E7 | ⏳ Planejado | Etapa E7 |  | DEP-WHATSAPP |  |
| R28-02 | Conectar número por fluxo oficial e validar permissões. | E7 | ⏳ Planejado | Etapa E7 |  | DEP-WHATSAPP |  |
| R28-03 | Registrar referências Click-to-WhatsApp quando o webhook as fornecer, com formato/finalidade reais. | E7 | ⏳ Planejado | Etapa E7 |  | DEP-WHATSAPP |  |
| R28-04 | Links com referência curta sem dados pessoais. | E7 | ⏳ Planejado | Etapa E7 |  | DEP-WHATSAPP |  |
| R28-05 | Associar sessão a lead/conversa com ligação comprovada, prevendo perda de vínculo. | E7 | ⏳ Planejado | Etapa E7 |  | DEP-WHATSAPP |  |
| R28-06 | Eventos distintos: clique, mensagem recebida, conversa, lead qualificado, negócio, venda. | E7 | ⏳ Planejado | Etapa E7 |  | DEP-WHATSAPP |  |
| R28-07 | Vincular venda ao lead por CRM, checkout ou registro manual auditado. | E7 | ⏳ Planejado | Etapa E7 |  | DEP-WHATSAPP |  |
| R28-08 | Relatórios por número, atendente, campanha, origem, produto, etapa. | E7 | ⏳ Planejado | Etapa E7 |  | DEP-WHATSAPP |  |
| R28-09 | Deduplicar status/atualizações; janela configurável e histórico do caminho. | E7 | ⏳ Planejado | Etapa E7 |  | DEP-WHATSAPP |  |
| R28-10 | Compra nunca inferida de mensagem/conversa/negócio sem confirmação financeira; minimizar conteúdo de mensagens. | E7 | ⏳ Planejado | Etapa E7 |  | DEP-WHATSAPP |  |
| R28-11 | Mensageria opcional (inbox, templates, recuperação, notificações) com opt-out, limites e regras vigentes do canal. | E7 | ⏳ Planejado | Etapa E7 |  | DEP-WHATSAPP |  |
| R28-12 | Limitações do provedor visíveis; sem prometer rastrear contas pessoais. | E7 | ⏳ Planejado | Etapa E7 |  | DEP-WHATSAPP |  |

### 29. CRM e recuperação

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R29-01 | CRM interno leve: contatos, leads, negócios, pipeline, etapas, responsáveis, notas, tarefas e origem. | E7 | ⏳ Planejado | Etapa E7 |  |  |  |
| R29-02 | Conectores Kommo, HubSpot, Pipedrive, RD Station, Salesforce, Zoho com direção de sincronização por objeto/campo. | E7 | ⏳ Planejado | Etapa E7 |  |  |  |
| R29-03 | Vínculos estáveis, upsert, anti-loop, conflitos explícitos, histórico e origem. | E7 | ⏳ Planejado | Etapa E7 |  |  |  |
| R29-04 | Deduplicação de contatos com revisão de ambíguos; campos de UTM, clique, produto e pedido. | E7 | ⏳ Planejado | Etapa E7 |  |  |  |
| R29-05 | Negócio ganho gera evento comercial, não pagamento confirmado; conversões offline respeitam fonte, consentimento, tempo e destino. | E7 | ⏳ Planejado | Etapa E7 |  |  |  |
| R29-06 | Recuperação: detectar pendência/abandono só com evidência; separar Pix pendente/expirado, boleto, cartão recusado e carrinho. | E7 | ⏳ Planejado | Etapa E7 |  |  |  |
| R29-07 | Elegibilidade, consentimento, frequência, quiet hours e cancelamento após pagamento; revalidar antes do envio (corrida). | E7 | ⏳ Planejado | Etapa E7 |  |  |  |
| R29-08 | Canais e-mail/WhatsApp/SMS/webhook via conectores autorizados; sem mensagem após cancelamento/opt-out. | E7 | ⏳ Planejado | Etapa E7 |  |  |  |
| R29-09 | Origem de aquisição e canal de recuperação medidos separadamente sem duplicar receita; automações exigem habilitação explícita. | E7 | ⏳ Planejado | Etapa E7 |  |  |  |

### 30. Funis, páginas, VSL e testes

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R30-01 | Funis, páginas, ofertas, checkout, bump, upsell, downsell com versões e domínios. | E7 | ⏳ Planejado | Etapa E7 |  |  |  |
| R30-02 | Análise por etapa (visitas, conteúdo, lead, checkout, pagamento gerado, aprovado, retido, estornado), abandono, taxas, latência e perda de … | E7 | ⏳ Planejado | Etapa E7 |  |  |  |
| R30-03 | VSL via APIs de players suportados; sem acesso a iframe de terceiros; repetição ≠ espectador único; definição de retenção. | E7 | ⏳ Planejado | Etapa E7 |  |  |  |
| R30-04 | Experimentos com variantes, alocação estável, datas, população, métrica definida antes, relatórios por variante. | E7 | ⏳ Planejado | Etapa E7 |  |  |  |
| R30-05 | Sem vencedor com poucas observações; estatística com método documentado; observacional ≠ causal. | E7 | ⏳ Planejado | Etapa E7 |  |  |  |
| R30-06 | Sem manipulação de páginas de terceiros; fallback de redirecionamentos de teste. | E7 | ⏳ Planejado | Etapa E7 |  |  |  |

### 31. Criativos

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R31-01 | Biblioteca de criativos das contas conectadas com prévia autorizada, ID, nome, tags, formato, produto, datas e performance; sem scraping. | E7 | ⏳ Planejado | Etapa E7 |  |  |  |
| R31-02 | Comparação por investimento, receita, contribuição, CPA, ROAS, cliques, retenção e vídeo disponíveis; agrupamentos informados pelo usuário … | E7 | ⏳ Planejado | Etapa E7 |  |  |  |
| R31-03 | Reutilização por IDs/assinaturas confiáveis sem multiplicar gasto/receita; detalhamento por posicionamento/dispositivo/período. | E7 | ⏳ Planejado | Etapa E7 |  |  |  |
| R31-04 | Hook/hold rate com fórmula e disponibilidade por rede; fadiga como hipótese. | E7 | ⏳ Planejado | Etapa E7 |  |  |  |
| R31-05 | Exportação e ligação com campanhas, funis e testes; IA sem inventar conteúdo não analisado. | E7 | ⏳ Planejado | Etapa E7 |  |  |  |

### 32. Relatórios e exportações

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R32-01 | Relatórios personalizáveis e salvos (filtros, colunas, agrupamentos, fórmulas, atribuição). | E8 | ⏳ Planejado | Etapa E8 |  |  |  |
| R32-02 | CSV/XLSX tipados com moeda e timezone; PDF com data, fontes e notas. | E8 | 🟡 Parcial | CSV tipado com neutralização | webhook-pipeline.test.ts (T66) |  | XLSX/PDF pendentes |
| R32-03 | Link de relatório com permissão, expiração, revogação e dados pessoais ocultos. | E8 | ⏳ Planejado | Etapa E8 |  |  |  |
| R32-04 | Agendamento diário/semanal/mensal com destinatários autorizados. | E8 | ⏳ Planejado | Etapa E8 |  |  |  |
| R32-05 | Comparações de períodos, campanhas, produtos e fontes. | E8 | ⏳ Planejado | Etapa E8 |  |  |  |
| R32-06 | Exportação assíncrona com progresso e link temporário. | E8 | ⏳ Planejado | Etapa E8 |  |  |  |
| R32-07 | Conectores Google Sheets, Drive, BigQuery, Metabase, Looker Studio; sem chamar CSV de integração nativa. | E8 | ⏳ Planejado | Etapa E8 |  |  |  |
| R32-08 | Make, n8n, Zapier, webhook, e-mail e notificações com templates documentados. | E8 | ⏳ Planejado | Etapa E8 |  |  |  |
| R32-09 | Migração de históricos por APIs/exportações do usuário; sem Purchase histórico por padrão; política de colisão. | E8 | ⏳ Planejado | Etapa E8 |  |  |  |
| R32-10 | Neutralizar fórmulas em células (CSV injection); sem URLs públicas permanentes com dados de clientes. | E8 | ✅ Implementado localmente | apps/api/src/lib/csv.ts neutralizeCell; export sem URL pública | webhook-pipeline.test.ts (T66) |  |  |

### 33. API pública e webhooks de saída

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R33-01 | REST versionada com OpenAPI, paginação por cursor, filtros coerentes, chaves revogáveis com escopos por organização/projetos; hash da chave… | E8 | ✅ Implementado localmente | /public/v1 (apps/api/src/public): chaves tk_live/tk_test com hash HMAC, escopos, projetos, expiração/revogação; cursor; OpenAPI 3.1 em /public/v1/openapi.json | public-api.test.ts (chaves, escopos, projeto, cursor, OpenAPI cobre todas as rotas) |  |  |
| R33-02 | Recursos: métricas, pedidos, produtos, fontes, campanhas, status de integração, leads, eventos, importação de vendas; nada administrativo. | E8 | 🟡 Parcial | Pedidos, importação de vendas, métricas, campanhas, produtos e estado das integrações; nada administrativo | public-api.test.ts |  | Leads e eventos próprios ainda não expostos (sem módulo de leads) |
| R33-03 | Rate limit por organização/chave com cabeçalhos; Idempotency-Key em criações/importações. | E8 | ✅ Implementado localmente | Janelas por chave e organização no PostgreSQL com cabeçalhos RateLimit-* e Retry-After; Idempotency-Key obrigatória em POST /sales (replay, 422 em corpo diferente) | public-api.test.ts |  | D-020 |
| R33-04 | Erro consistente com código, mensagem e request ID; versionamento e depreciação; exemplos testados e sandbox; logs de uso sem conteúdo sens… | E8 | ✅ Implementado localmente | Contrato de erro com código/mensagem/request_id (inclui 404 de rota); versionamento e política de descontinuação em docs/API.md; sandbox (tk_test_); uso por chave sem conteúdo; último acesso; revogação | public-api.test.ts; outbound.test.ts (exemplo documentado executado) |  |  |
| R33-05 | Webhooks de saída: eventos selecionáveis, destino, ownership, assinatura com timestamp e ID, retries, dead letters, teste explícito, rotaçã… | E8 | ✅ Implementado localmente | webhook_subscriptions (nasce pausada; ativação após test.ping 2xx), eventos selecionáveis, projetos, assinatura t/id/v1 com dupla assinatura na rotação (24 h), backoff, fila de falhas e reenvio | webhooks-out.test.ts; outbound.test.ts |  |  |
| R33-06 | Proteção SSRF: bloquear privados, loopback, link-local, metadata e esquemas indevidos; validar DNS e redirects no momento da conexão; limit… | E8 | ✅ Implementado localmente | packages/connectors/src/outbound/safe-http.ts: bloqueio de privados/loopback/link-local/metadata/CGNAT/IPv6 especiais, esquemas e credenciais; DNS validado na conexão; redirects revalidados (máx. 3, só 307/308); timeout e limite de resposta | outbound.test.ts (T67); webhooks-out.test.ts |  |  |
| R33-07 | Webhook de saída que retorna à entrada não cria loop; proveniência e limite de encaminhamento. | E8 | ✅ Implementado localmente | X-Tracker-Hop propagado; entrada recusa salto > 3 (508); evento no limite processado sem reemissão; proveniência (receipt_id, fonte, hop) no payload; host do próprio sistema proibido como destino | webhooks-out.test.ts |  |  |

### 34. Alertas e notificações

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R34-01 | Central com preferências por usuário, projeto, tipo e horário; canais painel, e-mail, web push, app; Telegram/Slack/WhatsApp só conectados. | E8 | ⏳ Planejado | Etapa E8 |  |  |  |
| R34-02 | Alertas: venda aprovada, reembolso, chargeback, meta, conexão perdida, token expirando, fila atrasada, custo excedido, gasto sem conversão,… | E8 | ⏳ Planejado | Etapa E8 |  |  |  |
| R34-03 | Deduplicar por evento semântico; som de venda opcional com teste/mute/volume, sem reemitir vendas antigas. | E8 | ⏳ Planejado | Deduplicação de notificações |  |  |  |
| R34-04 | Tela bloqueada sem dados pessoais; push dependente de consentimento; falha de push não interrompe registro da venda. | E8 | ⏳ Planejado | Etapa E8 |  |  |  |

### 35. Mobile, PWA e app nativo

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R35-01 | Web responsiva e PWA instalável primeiro; dashboard, vendas, notificações, filtros e diagnóstico em telas pequenas. | E9 | 🟡 Parcial | Web responsiva + manifest PWA | — |  | Service worker/offline pendente |
| R35-02 | App `apps/mobile` (Expo) com API compartilhada, armazenamento seguro, biometria opcional, push, deep links e troca de organização. | E9 | ⏳ Planejado | Etapa E9 |  |  |  |
| R35-03 | Escopo móvel: métricas, vendas, integrações, regras, campanhas, ações com mesma validação, modo leitura, offline datado sem ações silencios… | E9 | ⏳ Planejado | Etapa E9 |  |  |  |
| R35-04 | Publicação em lojas só declarada após publicação real; PWA não prova app nas lojas. | E9 | ⏳ Planejado | Etapa E9 |  |  |  |

### 36. Cobrança do SaaS

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R36-01 | Assinaturas da plataforma totalmente separadas dos pedidos rastreados. | E8 | ✅ Implementado localmente | Nenhuma tabela de cobrança do SaaS mistura pedidos rastreados (domínios separados por design) | — |  |  |
| R36-02 | Planos configuráveis, trial, mensal/anual, cupons, upgrade/downgrade, cancelamento, tolerância, reativação, histórico, recibos, portal; pre… | E8 | ⏳ Planejado | Etapa E8 |  |  |  |
| R36-03 | Entitlements aplicados no servidor. | E8 | ⏳ Planejado | Etapa E8 |  |  |  |
| R36-04 | Metering idempotente e auditável; política de estorno de uso definida. | E8 | ⏳ Planejado | Etapa E8 |  |  |  |
| R36-05 | Inadimplência com tolerância limitada, sem descartar vendas silenciosamente; aviso de retenção. | E8 | ⏳ Planejado | Etapa E8 |  |  |  |
| R36-06 | Checkout hospedado pelo provedor; sem cartão/CVV; ativação por webhook autenticado. | E8 | ⏳ Planejado | Etapa E8 |  |  |  |
| R36-07 | Anti-abuso de trial e reembolso auditado; recibo ≠ nota fiscal; NF só com conector verificado. | E8 | ⏳ Planejado | Etapa E8 |  |  |  |

### 37. Agências e personalização

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R37-01 | Vários clientes isolados com contratos de acesso independentes; visão consolidada só com acesso explícito. | E8 | 🟡 Parcial | agency_links (vínculo explícito) | — |  |  |
| R37-02 | Equipes, responsáveis, permissões por projeto e onboarding. | E8 | ⏳ Planejado | Etapa E8 |  |  |  |
| R37-03 | Compartilhamento com cliente leitor; marca própria em relatórios; domínio personalizado com validação e TLS. | E8 | ⏳ Planejado | Etapa E8 |  |  |  |
| R37-04 | Templates (dashboards, UTMs, custos, regras) sem copiar segredos; transferência de projeto com prévia e prevenção de vazamento. | E8 | ⏳ Planejado | Etapa E8 |  |  |  |
| R37-05 | Revogar agência/colaborador não destrói dados do cliente; white-label mantém identificação de processadores; sem revenda ilimitada. | E8 | ⏳ Planejado | Etapa E8 |  |  |  |

### 38. Administração e suporte

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R38-01 | Área administrativa separada: organizações, planos, uso, limites, jobs, saúde, incidentes, custos, conexões degradadas, tickets. | E8/E9 | ⏳ Planejado | Etapa E8/E9 |  |  |  |
| R38-02 | Sem leitura irrestrita de dados pessoais por padrão; acesso excepcional com justificativa, prazo, escopo e auditoria; impersonação explícit… | E8/E9 | ✅ Implementado localmente | is_platform_admin sem bypass de RLS; nenhuma leitura irrestrita implementada | rls.itest.ts |  |  |
| R38-03 | Feature flags, rollout por organização, manutenção, incidentes, status, busca técnica, exportação de diagnóstico sanitizado, suporte contex… | E8/E9 | 🟡 Parcial | feature_flags (tabela)  | — |  |  |
| R38-04 | Desativar conector, drenar filas, isolar organizações abusivas, reprocessar intervalo; sem correções diretas no banco sem registro. | E8/E9 | ⏳ Planejado | Etapa E8/E9 |  |  |  |

### 39. Telas e qualidade de experiência

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R39-01 | Áreas: Entrada, Onboarding, Visão geral, Campanhas, Vendas, Produtos, Origem, Pixels, Integrações, Automação, IA, WhatsApp/CRM, Funis, Rela… | Todas | ✅ Implementado localmente | Módulos não implementados marcados como planejados | apps/web/app/(app)/modulos/[slug], E2E |  |  |
| R39-02 | Sidebar recolhível, filtros persistentes, teclado, contraste, foco visível, erros acionáveis, atalhos, skeletons, estados vazios, carregame… | Todas | 🟡 Parcial | Sidebar recolhível, foco visível, skip link, skeletons, estados vazios | E2E |  | Atalhos e filtros persistentes pendentes |
| R39-03 | Estados em andamento/concluída/parcial/falha; sem sucesso antes da confirmação do servidor; otimismo reversível. | Todas | ✅ Implementado localmente | Toasts somente após resposta do servidor | E2E |  |  |
| R39-04 | Dados reais da API; contas novas sem faturamento fictício; tour em organização demo isolada. | Todas | ✅ Implementado localmente | Sem dados fictícios em contas novas | E2E (painel R$ 0,00 inicial) |  |  |
| R39-05 | Sem detalhes de infraestrutura na navegação normal; responsividade verificada em desktop e mobile. | Todas | 🟡 Parcial | Detalhes técnicos só em Diagnóstico; responsividade básica | — |  |  |

### 40. Segurança, privacidade e retenção

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R40-01 | Autorização no servidor em toda leitura, exportação e mutação. | E1+ | ✅ Implementado localmente | assertPermission + orgTx em todas as rotas | auth-isolation.test.ts |  |  |
| R40-02 | RLS e grants com testes independentes. | E1+ | ✅ Implementado localmente | RLS + grants; testes diretos no banco | rls.itest.ts |  |  |
| R40-03 | Sessões seguras, JWT/JWKS com issuer/audience/expiração, cookies adequados, CSRF. | E1+ | 🟡 Parcial | Sessão opaca httpOnly SameSite=Lax, Secure configurável, CSRF por Origin (JWT/JWKS não usado — D-003) | auth-isolation.test.ts |  |  |
| R40-04 | OAuth com `state`, redirect URI controlada e PKCE. | E1+ | ⏳ Planejado | OAuth com state/PKCE (Meta/Google) |  |  |  |
| R40-05 | Segredos criptografados com gestão de chaves, versão e rotação; chaves fora do banco. | E1+ | ✅ Implementado localmente | AES-256-GCM com versão de chave e AAD; chaves fora do banco | — |  |  |
| R40-06 | Nenhum segredo com prefixo público ou no bundle do navegador. | E1+ | ✅ Implementado localmente | Nenhum segredo NEXT_PUBLIC_; API atrás de rewrite | — |  |  |
| R40-07 | Isolamento em storage, relatórios, caches, filas, realtime e busca. | E1+ | 🟡 Parcial | RLS; filas com org por job; storage/realtime inexistentes | rls.itest.ts |  |  |
| R40-08 | SQL parametrizado, validação, limites de tamanho, XSS e sanitização. | E1+ | ✅ Implementado localmente | SQL parametrizado, zod, limites de tamanho, React escapa saída | — |  |  |
| R40-09 | CORS configurado sem ser autenticação; origem/referrer/segredo público não comprovam identidade. | E1+ | ✅ Implementado localmente | CORS delegado; coleta pública sem credenciais; origem não autentica | tracking-attribution.test.ts |  |  |
| R40-10 | Assinatura de webhooks e anti-replay compatível com retransmissões. | E1+ | ✅ Implementado localmente | HMAC com timestamp e tolerância; idempotência absorve retransmissões | canonical-meta.test.ts |  |  |
| R40-11 | Rate limits, anti-flood e defesa contra eventos sintéticos. | E1+ | ✅ Implementado localmente | Rate limits, janela de horário dos eventos, limites de lote | tracking-attribution.test.ts |  |  |
| R40-12 | SSRF, CSV injection e uploads maliciosos. | E1+ | ✅ Implementado localmente | CSV injection neutralizado; SSRF em webhooks de saída (safeRequest); upload de arquivos ainda inexistente | webhook-pipeline.test.ts (T66); outbound.test.ts (T67) |  |  |
| R40-13 | Logs redigidos, retenção limitada e auditoria de acesso a dados sensíveis. | E1+ | 🟡 Parcial | Logs com redação; auditoria de PII revelada | — |  |  |
| R40-14 | Separação de ambientes e credenciais de teste/produção. | E1+ | 🟡 Parcial | Bancos e credenciais separados por ambiente local/teste/E2E | — |  |  |
| R40-15 | Revogação, exclusão de credenciais, expiração de links e política de incidentes. | E1+ | 🟡 Parcial | Revogação de endpoints/credenciais/convites/sessões/chaves de API/segredos de webhooks de saída | auth-isolation.test.ts; public-api.test.ts; webhooks-out.test.ts |  |  |
| R40-16 | Dependências atualizadas, scan de segredos e tratamento de vulnerabilidades. | E1+ | 🟡 Parcial | Versões atuais fixadas; scan de segredos/vulnerabilidades pendente |  |  |  |
| R40-17 | Privacidade: inventário de dados (finalidade, origem, destinatários, retenção), consentimento/CMP, processamento do serviço vs publicidade. | E1+ | ⏳ Planejado | Inventário de dados (docs/PRIVACY_DATA_INVENTORY.md) |  |  |  |
| R40-18 | Exportação, correção e exclusão/anonimização; exclusão de identificação vs lançamentos financeiros agregados; hash ≠ anonimização. | E1+ | ⏳ Planejado | Exportação/correção/exclusão (privacy_requests modelado) |  |  |  |
| R40-19 | Minimizar IP, telefone, e-mail, endereço, CPF e mensagens; sem monitoramento sensível; exclusão em índices, caches, derivados e backups. | E1+ | 🟡 Parcial | Minimização: URL sanitizada, IP/UA só com consentimento de publicidade, PII restrita | tracking-attribution.test.ts |  |  |
| R40-20 | Minutas de política de privacidade, termos e DPA identificadas para revisão. | E1+ | ⏳ Planejado | Minutas de política/termos/DPA |  |  |  |
| R40-21 | Retenção configurável por categoria com aviso da consequência para reatribuição. | E1+ | 🟡 Parcial | order_contacts.retention_until; política configurável pendente |  |  |  |

### 41. Configuração, desenvolvimento local e implantação

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R41-01 | `.env.example` com descrição, escopo público/servidor, formato, obrigatoriedade e origem; sem valores reais. | E9 | ✅ Implementado localmente | .env.example com escopo, formato, obrigatoriedade e origem | — |  |  |
| R41-02 | Categorias: URLs, Supabase, PostgreSQL por papel, Redis/worker, chaves de criptografia/assinatura, OAuth por provedor, cobrança, SMTP/push/… | E9 | ✅ Implementado localmente | .env.example (todas as categorias) | — |  |  |
| R41-03 | Credenciais de clientes no cofre do servidor por conexão; nunca em variáveis globais ou Git. | E9 | ✅ Implementado localmente | private.credentials por conexão | rls.itest.ts |  |  |
| R41-04 | Desenvolvimento local reproduzível: banco local, Redis, lockfile, migrações, seed sintético marcado; documentar qual banco cada comando usa. | E9 | ✅ Implementado localmente | scripts/db-setup.mjs, pnpm db:migrate, bancos por comando documentados | — |  | Seed de demonstração: pnpm db:seed:demo (dados sintéticos isolados) |
| R41-05 | Comandos reais: dev, build, lint, typecheck, testes, migrações, seed, worker, simulação de webhook, backfill, diagnóstico; README sem coman… | E9 | 🟡 Parcial | Comandos reais no package.json raiz: dev, build, lint, typecheck, test(s), db:setup/migrate/status/seed:demo, worker, webhook:simulate, diag, traceability, docs:metrics; scripts/backup.mjs e restore.mjs | — |  | Backfill ainda inexistente (depende de conectores com consulta histórica) |
| R41-06 | Implantação: web compatível; API/worker em processos persistentes; Dockerfiles, health checks, readiness, encerramento gracioso, migrações … | E9 | ✅ Implementado localmente | Dockerfile multi-alvo (api/worker/web; usuário não root; HEALTHCHECK), deploy/docker-compose.yml (PostgreSQL 16, Redis AOF, migrate + provision-roles, API, worker, painel), readiness, SIGTERM gracioso, migrações por checksum, variáveis por ambiente, TLS/domínio via proxy reverso e reversão documentados (docs/DEPLOYMENT.md) | deploy/compose-smoke.mjs executado: imagens construídas, cadastro → webhook → worker → pedido aprovado em contêineres | DEP-HOSTING | Hospedagem real depende de DEP-HOSTING |
| R41-07 | Sem provisionamento pago implícito; produção não declarada pronta por build. | E9 | ✅ Implementado localmente | Nada provisionado; produção não declarada | — |  |  |

### 42. Operação, capacidade e custo

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R42-01 | Instrumentar webhooks, eventos, rejeições, atraso de fila, processamento, tentativas externas, falhas por provedor, sincronia de gastos, er… | E9 | 🟡 Parcial | Logs estruturados por requisição; contadores no diagnóstico | — |  |  |
| R42-02 | IDs de correlação sem dados pessoais; alertas com alcance e ação recomendada. | E9 | ✅ Implementado localmente | request_id em todas as respostas/logs; sem PII | — |  |  |
| R42-03 | Resiliência: outbox recupera após falha do Redis; worker reinicia sem duplicar; isolamento entre provedores; prioridades/cotas por organiza… | E9 | ✅ Implementado localmente | Outbox + relay + retomada; lock por pedido; circuit breaker; encerramento gracioso | deliveries-relay.test.ts, webhook-pipeline.test.ts |  |  |
| R42-04 | Índices, agregações incrementais, análise de consultas; sem warehouse/Kafka/K8s prematuros. | E9 | ✅ Implementado localmente | Índices por org/período/estado; sem Kafka/warehouse; leituras de métricas sem subconsultas por pedido; autovacuum ajustado nas tabelas quentes (D-028) | — |  |  |
| R42-05 | Backups, restauração e DR com procedimento testado; RPO/RTO/SLA como metas até evidência. | E9 | 🟡 Parcial | scripts/backup.mjs (pg_dump no mesmo snapshot do manifesto) e scripts/restore.mjs (sha256, transação única, comparação de contagens/razão/credenciais cifradas); procedimento em docs/DEPLOYMENT.md | backup-restore.test.ts (T69) |  | RPO/RTO e DR entre regiões dependem da hospedagem (DEP-HOSTING); agendamento do backup é do operador |
| R42-06 | Estimador de custos operacionais com premissas. | E9 | ✅ Implementado localmente | scripts/cost-estimate.mjs: réplicas e armazenamento a partir do relatório medido + premissas explícitas; valores em dinheiro só com preços informados pelo operador | executado sobre docs/load-tests/2026-09-24-carga-2000.json |  |  |
| R42-07 | Teste de carga reproduzível com cenário, dataset, hardware, concorrência, latências, erros e custo. | E9 | ✅ Implementado localmente | scripts/load-test.mjs sobre a pilha de contêineres: cenário, dataset sintético, hardware, versões, concorrência, percentis, erros, pipeline ponta a ponta, idempotência sob duplicatas e armazenamento medido; relatórios em docs/load-tests (antes/depois) | docs/load-tests/2026-09-24-carga-2000*.md; perf-metrics.test.ts (PERF=1) |  | Gerador e pilha na mesma máquina; ordem de grandeza, não SLA |

### 43. Matriz de testes

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R43-01 | Automatizar T01–T70 nas etapas correspondentes (lista completa na matriz de rastreabilidade). | Todas | 🟡 Parcial | Cenários T01–T70 mapeados abaixo | pnpm test, E2E |  |  |
| R43-02 | Fixture financeira sintética obrigatória (R$100 + R$50; mídia R$30; taxas R$5; estornos R$20 e R$50 → bruto 150, estornos 70, líquido 80, 2… | Todas | ✅ Implementado localmente | Fixture obrigatória no domínio e via API com repetição | metrics-fixture.test.ts, webhook-pipeline.test.ts |  |  |
| R43-03 | Testes complementares: login/onboarding, responsividade, teclado, acessibilidade, importação grande, limites do SDK, schemas por provedor, … | Todas | 🟡 Parcial | Jornada de login/onboarding, limites do SDK | E2E, sdk.test.ts |  |  |

### 44–47. Execução, entregáveis e definição de pronto

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R44-01 | Etapas E0–E10 com critérios de conclusão (ver [`STATUS.md`](STATUS.md)); segurança e isolamento desde E1. | Todas | 📄 Método/documento | docs/STATUS.md (etapas) | — |  |  |
| R44-02 | Lowify sem documentação/payload autorizado: pipeline e simulador próprios, sem declarar E2 validada; idem Meta/Google/lojas. | Todas | ✅ Implementado localmente | E2 não declarada validada para Lowify | — |  |  |
| R44-03 | Integrações sem API/acesso: manifesto, limitação comprovada e alternativas legítimas; sem stubs de sucesso. | Todas | ✅ Implementado localmente | Catálogo sem stubs de sucesso | canonical-meta.test.ts |  |  |
| R45-01 | Entregáveis 1–15 da seção 45 (código, schema/RLS, testes, ambiente reproduzível e demo isolada, `.env.example`, docs de conectores, OpenAPI… | Todas | 🟡 Parcial | Entregáveis 1–5, 6 (parcial), 9, 10, 15 entregues; demais pendentes (ver STATUS) | — |  |  |
| R45-02 | README permite preparar e executar sem conhecimento implícito; dependências opcionais separadas; recursos bloqueados documentados. | Todas | ✅ Implementado localmente | README.md | — |  |  |
| R45-03 | Ao fim de cada etapa: resultado, reprodução, testes, limitações, pendências e próximo trabalho. | Todas | 📄 Método/documento | docs/STATUS.md | — |  |  |
| R46-01 | Definição de pronto: interface/contrato, dados reais, autorização/tipos/limites, persistência/concorrência, estados de erro, testes com evi… | Todas | 📄 Método/documento | Definição de pronto aplicada aos estados desta matriz | — |  |  |
| R47-01 | Início: inspecionar, PRD, matriz, verificar docs das primeiras integrações, implementar E1 e primeiro fluxo de E2, continuar etapas desbloq… | E0 | 📄 Método/documento | Sequência executada nesta sessão | — |  |  |

### Anexos

| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RA-01 | Anexo A: referências públicas (UTMify, LowTrack) apenas como categorias funcionais; divergência sobre app LowTrack registrada; promessas co… | E0 | ✅ Implementado localmente | Nenhuma promessa comercial; divergência LowTrack registrada no PRD | — |  |  |
| RA-02 | Anexo A: fontes técnicas oficiais a revalidar ao codificar (Meta autorização/dedup/parâmetros, Google Data Manager e restrições do legado, … | E0 | 🟡 Parcial | Fontes técnicas listadas; maioria inacessível neste ambiente | — | DEP-OFFICIAL-DOCS |  |
| RB-01 | Anexo B: dependências externas rastreáveis (ver `EXTERNAL_DEPENDENCIES.md`). | E0 | ✅ Implementado localmente | docs/EXTERNAL_DEPENDENCIES.md | — |  |  |
| RC-01 | Anexo C: instruções curtas de continuidade (reproduzidas em `CLAUDE.md`). | E0 | ✅ Implementado localmente | CLAUDE.md | — |  |  |
