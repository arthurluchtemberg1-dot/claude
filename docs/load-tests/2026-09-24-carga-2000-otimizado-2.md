# Teste de carga — 2026-09-24T05:03:04.521Z

Comando: `node scripts/load-test.mjs --orders 2000 --concurrency 32 --visits 2000 --reads 200` (pilha `deploy/docker-compose.yml`, dados sintéticos; limites de ingestão elevados: WEBHOOK_RATE_LIMIT_PER_MINUTE=100000, COLLECT_RATE_LIMIT_PER_MINUTE=100000).

**Hardware:** Intel(R) Xeon(R) Processor @ 2.80GHz, 4 núcleos, 17 GB, Linux 6.18.44-fc-v37. Mesma máquina executa gerador de carga e pilha (compete por CPU).
**Versões:** Node v22.22.2, PostgreSQL 16.13 (Debian 16.13-1.pgdg13+1), Docker version 29.3.1, build c2be9cc.

| Cenário | Requisições | Concorrência | Req/s | p50 ms | p95 ms | p99 ms | máx ms | Erros |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Webhooks (aceite) | 2000 | 32 | 312.8 | 98.4 | 140.2 | 166.2 | 205.3 | 0 |
| Duplicatas (20%) | 400 | 32 | 365.1 | 83.7 | 116.1 | 129.6 | 141.5 | 0 |
| Coleta do SDK | 2000 | 32 | 660.8 | 46.2 | 66.5 | 88.8 | 105.2 | 0 |
| Resumo de métricas (logo após a carga) | 100 | 16 | 1.5 | 451.8 | 22219.9 | 22620.1 | 22780.1 | 0 |
| Resumo de métricas (após ANALYZE) | 100 | 16 | 41.8 | 369.6 | 522.8 | 556.2 | 610.1 | 0 |

**Pipeline ponta a ponta:** 2000 vendas aceitas em 6.396 s; pedidos e razão processados em 10.47 s (191 pedidos/s; 4.074 s após o último aceite); atribuição (prioridade menor na fila) concluída para todos em 13.593 s (152 prontas quando os pedidos terminaram).
**Idempotência sob carga:** preservada (pedidos:soma após duplicatas = 2000:6900000).
**Recursos:** banco com 2001 pedidos ocupa 27.9 MB (~10378 bytes por pedido em tabelas de vendas — recebimentos, eventos, razão, atribuição — e ~3564 bytes por visita em tabelas de rastreamento; tamanhos incluem índices e são inflados em bases pequenas).

Limitações: gerador e pilha na mesma máquina; worker com uma réplica e concorrência padrão; resultados indicam ordem de grandeza, não SLA.
