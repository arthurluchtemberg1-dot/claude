# Testes de carga (R42-07)

Executados com `node scripts/load-test.mjs --orders 2000 --concurrency 32 --visits 2000 --reads 200` na pilha `deploy/docker-compose.yml` (4 núcleos Xeon 2,8 GHz, 17 GB; gerador e pilha na mesma máquina; dados sintéticos). Estimativa de custos: `scripts/cost-estimate.mjs --report <json>`.

| Execução | Mudança | Resumo p50 / p95 logo após a carga | Resumo p50 / p95 após ANALYZE |
| --- | --- | --- | --- |
| [antes](2026-09-24-carga-2000-antes.md) | — | 9.816 ms / 32.015 ms | não medido |
| [otimizado-1](2026-09-24-carga-2000-otimizado-1.md) | créditos de atribuição sem subconsulta por pedido | 416 ms / 22.144 ms | não medido |
| [otimizado-2](2026-09-24-carga-2000-otimizado-2.md) | + medição em duas fases | 452 ms / 22.220 ms | 370 ms / 523 ms |
| [atual](2026-09-24-carga-2000.md) | + autovacuum das tabelas quentes (migração 0016) e `autovacuum_naptime=10s` | 362 ms / 579 ms | 384 ms / 482 ms |

Estáveis em todas as execuções: aceite de webhooks ~310–325 req/s (p95 ~130–145 ms, 0 erros), pipeline ~170–190 pedidos/s por réplica de worker, idempotência preservada com 20% de duplicatas, coleta do SDK ~500–660 req/s (p95 < 110 ms). Diagnóstico e correções em `docs/DECISIONS.md` (D-028).
