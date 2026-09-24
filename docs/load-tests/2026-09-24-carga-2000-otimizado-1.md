# Teste de carga — 2026-09-24T05:00:49.072Z

Comando: `node scripts/load-test.mjs --orders 2000 --concurrency 32 --visits 2000 --reads 200` (pilha `deploy/docker-compose.yml`, dados sintéticos; limites de ingestão elevados: WEBHOOK_RATE_LIMIT_PER_MINUTE=100000, COLLECT_RATE_LIMIT_PER_MINUTE=100000).

**Hardware:** Intel(R) Xeon(R) Processor @ 2.80GHz, 4 núcleos, 17 GB, Linux 6.18.44-fc-v37. Mesma máquina executa gerador de carga e pilha (compete por CPU).
**Versões:** Node v22.22.2, PostgreSQL 16.13 (Debian 16.13-1.pgdg13+1), Docker version 29.3.1, build c2be9cc.

| Cenário | Requisições | Concorrência | Req/s | p50 ms | p95 ms | p99 ms | máx ms | Erros |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Webhooks (aceite) | 2000 | 32 | 316.2 | 95.5 | 144.7 | 178.8 | 219.3 | 0 |
| Duplicatas (20%) | 400 | 32 | 359.3 | 85.9 | 141.9 | 157.5 | 175.5 | 0 |
| Coleta do SDK | 2000 | 32 | 664.8 | 45.6 | 66.4 | 86.4 | 104.2 | 0 |
| Resumo de métricas | 200 | 16 | 2.9 | 415.7 | 22144.3 | 22936.5 | 23164.1 | 0 |

**Pipeline ponta a ponta:** 2000 vendas aceitas em 6.327 s; pedidos e razão processados em 10.382 s (192.6 pedidos/s; 4.055 s após o último aceite); atribuição (prioridade menor na fila) concluída para todos em 14.676 s (151 prontas quando os pedidos terminaram).
**Idempotência sob carga:** preservada (pedidos:soma após duplicatas = 2000:6900000).
**Recursos:** banco com 2001 pedidos ocupa 28.0 MB (~10435 bytes por pedido em tabelas de vendas — recebimentos, eventos, razão, atribuição — e ~3535 bytes por visita em tabelas de rastreamento; tamanhos incluem índices e são inflados em bases pequenas).

Limitações: gerador e pilha na mesma máquina; worker com uma réplica e concorrência padrão; resultados indicam ordem de grandeza, não SLA.
