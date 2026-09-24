#!/usr/bin/env node
/**
 * Estimador de custos operacionais (R42-06) a partir de um relatório MEDIDO do teste de carga + premissas explícitas.
 *   node scripts/cost-estimate.mjs --report docs/load-tests/AAAA-MM-DD-carga-N.json \
 *     --orders-month 30000 --visits-month 600000 --peak-orders-minute 300 --retention-months 24 \
 *     [--price-vcpu-hour 0.04 --price-gb-month 0.12 --price-backup-gb-month 0.03]
 * Sem preços informados, o resultado é em recursos (vCPU, GB, réplicas) — não inventamos preços de provedores.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    report: { type: "string" },
    "orders-month": { type: "string", default: "30000" },
    "visits-month": { type: "string", default: "600000" },
    "peak-orders-minute": { type: "string", default: "300" },
    "peak-visits-second": { type: "string", default: "50" },
    "retention-months": { type: "string", default: "24" },
    "price-vcpu-hour": { type: "string" },
    "price-gb-month": { type: "string" },
    "price-backup-gb-month": { type: "string" },
  },
  args: process.argv.slice(2).filter((a) => a !== "--"),
});
if (!values.report) {
  console.error("Informe --report com o JSON gerado por scripts/load-test.mjs");
  process.exit(2);
}
const r = JSON.parse(readFileSync(values.report, "utf8"));
const n = (k) => Number(values[k]);
const ordersMonth = n("orders-month");
const visitsMonth = n("visits-month");
const retention = n("retention-months");

const bytesPerOrder = r.resources.bytes_per_order ?? r.resources.approx_bytes_per_order;
const bytesPerVisit = r.resources.bytes_per_visit ?? null;
const pipelinePerSecond = r.results.pipeline.orders_per_second_end_to_end; // 1 réplica de worker, mesma máquina da carga
const collectRps = r.results.collect.rps;

const storageGb = (ordersMonth * retention * bytesPerOrder + (bytesPerVisit ? visitsMonth * retention * bytesPerVisit : 0)) / 1e9;
const workerReplicas = Math.max(1, Math.ceil(n("peak-orders-minute") / 60 / (pipelinePerSecond * 0.6))); // 40% de folga
const apiReplicas = Math.max(2, Math.ceil(n("peak-visits-second") / (collectRps * 0.6))); // mínimo 2 para disponibilidade

const lines = [
  `# Estimativa de custos operacionais`,
  ``,
  `Base medida: ${values.report} (${r.date}; ${r.hardware.cores} núcleos ${r.hardware.cpu}; pipeline ${pipelinePerSecond} pedidos/s por réplica de worker; coleta ${collectRps} req/s; ~${bytesPerOrder} bytes por pedido${bytesPerVisit ? `; ~${bytesPerVisit} bytes por visita` : ""}).`,
  ``,
  `## Premissas (edite pelos parâmetros)`,
  `- Pedidos/mês: ${ordersMonth}; visitas/mês: ${visitsMonth}; pico: ${n("peak-orders-minute")} pedidos/min e ${n("peak-visits-second")} visitas/s; retenção: ${retention} meses.`,
  `- Folga de 40% sobre a capacidade medida; API com no mínimo 2 réplicas; medições feitas com gerador e pilha na mesma máquina (conservador).`,
  bytesPerVisit ? "" : `- Tamanho por visita não medido separadamente neste relatório: armazenamento de rastreamento não incluído.`,
  ``,
  `## Recursos estimados`,
  `| Item | Quantidade |`,
  `| --- | --- |`,
  `| Réplicas de worker para o pico | ${workerReplicas} |`,
  `| Réplicas de API para o pico de coleta | ${apiReplicas} |`,
  `| Armazenamento do banco ao fim da retenção | ${storageGb.toFixed(2)} GB |`,
  `| Backups diários (30 retidos, compactação não considerada) | ${(storageGb * 30).toFixed(1)} GB·mês no pior caso |`,
];
const vcpu = n("price-vcpu-hour");
const gb = n("price-gb-month");
const bgb = n("price-backup-gb-month");
if (values["price-vcpu-hour"] && values["price-gb-month"]) {
  const computeMonth = (workerReplicas + apiReplicas + 1) * 730 * vcpu; // +1 vCPU painel
  const dbMonth = storageGb * gb;
  const backupMonth = values["price-backup-gb-month"] ? storageGb * 30 * bgb : null;
  lines.push(
    ``,
    `## Custo mensal com os preços informados`,
    `| Item | Valor |`,
    `| --- | --- |`,
    `| Computação (${workerReplicas + apiReplicas + 1} vCPU × 730 h × ${vcpu}) | ${computeMonth.toFixed(2)} |`,
    `| Armazenamento do banco (${storageGb.toFixed(2)} GB × ${gb}) | ${dbMonth.toFixed(2)} |`,
    backupMonth === null ? `| Backups | informe --price-backup-gb-month |` : `| Backups (${(storageGb * 30).toFixed(1)} GB × ${bgb}) | ${backupMonth.toFixed(2)} |`,
    `| **Total** | **${(computeMonth + dbMonth + (backupMonth ?? 0)).toFixed(2)}** (sem rede, e-mail, observabilidade e Redis gerenciado) |`,
  );
} else {
  lines.push(``, `Custos em dinheiro: informe --price-vcpu-hour e --price-gb-month (e opcionalmente --price-backup-gb-month) conforme a tabela do seu provedor.`);
}
console.log(lines.filter((l) => l !== "").join("\n").replace(/\n## /g, "\n\n## ").replace(/\n\| Item/g, "\n\n| Item"));
