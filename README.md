# Tracker (nome provisório)

Plataforma de rastreamento de vendas e gestão de performance: vendas confirmadas pelo checkout, origem com evidência, métricas financeiras com custos conhecidos e diagnóstico do transporte de eventos. Especificação: [`docs/PRD.md`](docs/PRD.md) (original preservado em `docs/spec/`). Estado atual: [`docs/STATUS.md`](docs/STATUS.md).

> Nenhuma integração está validada com provedores externos. Lowify e Meta CAPI estão **implementados localmente** (ver [`docs/INTEGRATIONS_MATRIX.md`](docs/INTEGRATIONS_MATRIX.md) e [`docs/EXTERNAL_DEPENDENCIES.md`](docs/EXTERNAL_DEPENDENCIES.md)).

## Estrutura

```
apps/api        API Fastify (auth, organizações, webhooks, coleta do SDK, vendas, métricas, diagnóstico, destinos, custos, API pública /public/v1)
apps/worker     Relay outbox→BullMQ, processamento, atribuição, entregas a destinos
apps/web        Painel Next.js 16 (React 19, Tailwind 4) + E2E Playwright
packages/domain Regras de negócio puras (dinheiro, fuso, agregado financeiro, métricas, atribuição, UTMs, permissões)
packages/connectors  Conectores (Lowify, webhook próprio, Meta CAPI, insights Meta) e catálogo com estado real
packages/contracts   Contrato canônico de evento v1.0 (Zod)
packages/db     Migrações SQL, papéis e RLS; cliente PostgreSQL
packages/tracker SDK de navegador (sem dependências)
docs/           PRD, matriz de rastreabilidade, arquitetura, decisões, integrações, métricas, dependências, status
```

## Requisitos

- Node.js 22.12+ (testado com 22.22.2) e pnpm 10 (`corepack enable`)
- PostgreSQL 16 (local) — os papéis `tracker_app` e `tracker_system` são criados pelo setup
- Redis 6+ com persistência AOF (para o worker)
- Opcional: Chromium para os testes E2E (Playwright; caminho configurável por `PLAYWRIGHT_CHROMIUM_PATH`)

## Preparação do ambiente local

```bash
pnpm install
cp .env.example .env            # preencha as chaves (instruções no próprio arquivo)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # gere CREDENTIALS_KEYS e TOKEN_HMAC_SECRET
pnpm db:setup                   # cria bancos tracker_dev, tracker_test, tracker_e2e e define senhas LOCAIS dos papéis
pnpm db:migrate                 # aplica migrações em DATABASE_URL_ADMIN (tracker_dev)
pnpm sdk:build                  # compila o SDK servido em /sdk/v1/tracker.js
```

`pnpm db:setup` usa o usuário `postgres` via socket local (ou `DATABASE_URL_SUPERUSER`) e **não deve ser usado em produção**. Qual banco cada comando usa:

| Comando | Banco |
| --- | --- |
| `pnpm db:migrate`, `pnpm db:status`, `pnpm dev`, `pnpm db:seed:demo`, `pnpm diag` | `tracker_dev` (URLs do `.env`) |
| `pnpm test` (projeto `integration`) | `tracker_test` (mesmo servidor, nome em `TEST_DATABASE_NAME`) — truncado a cada execução |
| `pnpm test:e2e` | `tracker_e2e` — truncado a cada execução |

## Executar

```bash
pnpm dev            # API (4000), worker (health 4100) e painel (3000) em paralelo
# ou separadamente:
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

Abra http://localhost:3000, crie a conta (o link de verificação aparece no log da API com `EMAIL_TRANSPORT=log`), crie a organização e uma conexão em **Integrações**.

- Demonstração isolada (dados sintéticos, nunca enviados a destinos): `pnpm db:seed:demo -- --email voce@exemplo.com`
- Simular um webhook local: `pnpm webhook:simulate -- --url <URL do webhook> [--event sale.paid|sale.pending|sale.refunded] [--utm-term "kw|trk_..."]` (Lowify, usa o exemplo documentado) ou `--provider custom --secret whsec_...` (webhook canônico assinado)
- Diagnóstico operacional (banco, migrações, fila, Redis): `pnpm diag`

## Qualidade

```bash
pnpm lint           # ESLint (typescript-eslint)
pnpm typecheck      # tsc em todos os pacotes
pnpm test           # unit + integração (PostgreSQL e Redis reais)
pnpm test:unit
pnpm test:integration
pnpm test:e2e       # jornada completa no navegador (API + worker + painel)
pnpm build          # build de todos os pacotes (API/worker com esbuild, painel Next standalone)
pnpm traceability   # regenera e valida docs/REQUIREMENTS_TRACEABILITY.md
pnpm docs:metrics   # regenera docs/METRICS_DICTIONARY.md
```

## Produção (resumo)

API e worker são processos persistentes (não serverless) com `/health` e `/ready` e encerramento gracioso (`SIGTERM`). O painel é gerado com `output: "standalone"` e encaminha `/api/*` e `/sdk/*` para a API (`API_INTERNAL_URL`). Defina `NODE_ENV=production`, `APP_ENV=production`, `SESSION_COOKIE_SECURE=true`, provedor de e-mail real e segredos por ambiente. Dockerfiles e checklist de implantação ainda estão pendentes (ver STATUS). Envio real a destinos exige `ALLOW_EXTERNAL_DELIVERY=true` **e** destino ativado com emissor responsável.

## Documentação

- [Arquitetura](docs/ARCHITECTURE.md) · [Decisões](docs/DECISIONS.md) · [Dicionário de métricas](docs/METRICS_DICTIONARY.md)
- [Matriz de rastreabilidade](docs/REQUIREMENTS_TRACEABILITY.md) · [Integrações](docs/INTEGRATIONS_MATRIX.md) · [Dependências externas](docs/EXTERNAL_DEPENDENCIES.md)
- [Webhook canônico assinado](docs/integrations/CANONICAL_WEBHOOK.md) · [SDK](docs/SDK.md) · [API pública e webhooks de saída](docs/API.md) · [Runbooks](docs/RUNBOOKS.md)
