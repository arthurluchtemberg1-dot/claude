# CLAUDE.md

Plataforma "Tracker" (rastreamento de vendas). Idioma do produto e dos documentos: pt-BR.

## Ao retomar
1. Leia `docs/STATUS.md` (estado, evidências, próximo passo) e `docs/REQUIREMENTS_TRACEABILITY.md` (gerado de `docs/traceability/status.json`).
2. Retome o próximo requisito desbloqueado; não reinicie nem reduza escopo sem justificar. A especificação completa está em `docs/PRD.md` (original em `docs/spec/`).
3. Antes de encerrar: atualize `docs/traceability/status.json`, rode `pnpm traceability`, e atualize `docs/STATUS.md`.

## Comandos
- `pnpm install` · `pnpm db:setup` (local) · `pnpm db:migrate` · `pnpm sdk:build`
- `pnpm dev` (API 4000, worker, painel 3000) · `pnpm diag` · `pnpm webhook:simulate -- --url ...` · `pnpm db:seed:demo -- --email ...`
- `pnpm lint` · `pnpm typecheck` · `pnpm test` (unit + integração; exige PostgreSQL e Redis locais) · `pnpm test:e2e` · `pnpm traceability` · `pnpm docs:metrics`
- Serviços locais neste contêiner: `service postgresql start` e `redis-server --daemonize yes --appendonly yes --dir /tmp`

## Regras permanentes (resumo da seção 03 da especificação)
- Não inventar endpoints, eventos, campos ou capacidades de provedores; registrar URL/data/versão da documentação consultada no manifesto do conector.
- Separar fixtures sintéticas, exemplos documentados e amostras reais (`packages/connectors/test/fixtures/README.md`).
- Não marcar integração como funcionando sem evidência; estados em `packages/connectors/src/catalog.ts`.
- Compra aprovada só com fonte financeira confiável; falta de dado nunca vira zero; dinheiro sempre `bigint` na menor unidade.
- Fórmulas financeiras apenas em `packages/domain/src/metrics` e `financial` (API/web não calculam).
- Toda consulta autenticada passa por `orgTx` (RLS com usuário + organização); worker usa contexto de organização por job.
- Envio externo desligado por padrão (`ALLOW_EXTERNAL_DELIVERY=false`); testes nunca chamam provedores reais.
- Nunca pedir segredos por mensagem; nada de segredos em commits.

## Mapa
`apps/api` · `apps/worker` · `apps/web` · `packages/{domain,connectors,contracts,db,tracker}` · `docs/`
