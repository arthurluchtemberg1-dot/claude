#!/usr/bin/env node
/**
 * Teste de carga reproduzível (R42-07) contra a pilha de referência em contêineres (deploy/docker-compose.yml).
 *   node scripts/load-test.mjs --orders 2000 --concurrency 32 [--keep] [--out docs/load-tests]
 * Cenários (todos com dados sintéticos, sem provedores externos):
 *   1. webhooks: N vendas aprovadas via webhook canônico assinado (latência de aceite, erros, vazão);
 *   2. pipeline: tempo até o worker processar tudo (webhook → outbox → Redis/BullMQ → pedido/razão/atribuição);
 *   3. duplicatas: reenvio de 20% dos eventos (idempotência sob carga: nenhum pedido/receita a mais);
 *   4. coleta do SDK: visitas com eventos (latência/erros);
 *   5. leitura: resumo de métricas do painel sob concorrência.
 * Gera JSON + Markdown com hardware, versões, dataset, concorrência, percentis, erros e custo em recursos
 * (armazenamento por pedido medido no banco). Custos em dinheiro: scripts/cost-estimate.mjs com os SEUS preços.
 */
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    orders: { type: "string", default: "2000" },
    concurrency: { type: "string", default: "32" },
    visits: { type: "string", default: "2000" },
    reads: { type: "string", default: "200" },
    keep: { type: "boolean", default: false },
    out: { type: "string", default: "docs/load-tests" },
  },
  args: process.argv.slice(2).filter((a) => a !== "--"),
});
const ORDERS = Number(values.orders);
const CONC = Number(values.concurrency);
const VISITS = Number(values.visits);
const READS = Number(values.reads);
const root = join(import.meta.dirname, "..");
const compose = join(root, "deploy/docker-compose.yml");
// Limites de ingestão elevados para medir a capacidade (registrados no relatório).
const LIMITS = { WEBHOOK_RATE_LIMIT_PER_MINUTE: "100000", COLLECT_RATE_LIMIT_PER_MINUTE: "100000" };
const smokeEnv = join(root, "deploy/.env.smoke");
const envFile = join(root, "deploy/.env.load");
if (!existsSync(smokeEnv)) execFileSync(process.execPath, [join(root, "deploy/compose-smoke.mjs")], { stdio: "inherit" }); // gera segredos efêmeros
copyFileSync(smokeEnv, envFile);
writeFileSync(envFile, readFileSync(envFile, "utf8").split("\n").filter((l) => l && !Object.keys(LIMITS).some((k) => l.startsWith(`${k}=`))).concat(Object.entries(LIMITS).map(([k, v]) => `${k}=${v}`)).join("\n") + "\n", { mode: 0o600 });
const api = "http://127.0.0.1:4000";

const dc = (...args) => execFileSync("docker", ["compose", "-f", compose, "--env-file", envFile, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] * 10) / 10;
};

/** Executa `total` tarefas com no máximo `conc` simultâneas; retorna latências e erros. */
async function pool(total, conc, task) {
  const lat = [];
  const errors = {};
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: conc }, async () => {
      for (;;) {
        const i = next++;
        if (i >= total) return;
        const t0 = performance.now();
        try {
          const status = await task(i);
          if (status >= 400) errors[status] = (errors[status] ?? 0) + 1;
        } catch (e) {
          errors[e.cause?.code ?? e.message] = (errors[e.cause?.code ?? e.message] ?? 0) + 1;
        }
        lat.push(performance.now() - t0);
      }
    }),
  );
  const seconds = (performance.now() - started) / 1000;
  return { requests: total, concurrency: conc, seconds: Math.round(seconds * 100) / 100, rps: Math.round((total / seconds) * 10) / 10, p50_ms: pct(lat, 50), p95_ms: pct(lat, 95), p99_ms: pct(lat, 99), max_ms: pct(lat, 100), errors };
}

let cookie = "";
async function call(method, path, body, headers = {}) {
  const res = await fetch(`${api}${path}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function waitFor(label, fn, ms = 300_000) {
  const start = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* ainda subindo */
    }
    if (Date.now() - start > ms) throw new Error(`Tempo esgotado: ${label}`);
    await sleep(1000);
  }
}

function psql(sql) {
  return dc("exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "tracker", "-At", "-c", sql).trim();
}

// ------------------------------------------------------------------ preparação
execFileSync(process.execPath, [join(root, "deploy/compose-smoke.mjs"), "--keep", "--env-file", envFile], { stdio: "inherit" }); // sobe a pilha e valida o fluxo
const email = `carga-${Date.now()}@teste.local`;
const password = "senha-forte-carga-123";
await call("POST", "/v1/auth/signup", { email, password, displayName: "Carga" });
const token = await waitFor("verificação", async () => /token=([A-Za-z0-9_-]+)/.exec(dc("logs", "api").split("\n").filter((l) => l.includes("verify_email")).at(-1) ?? "")?.[1]);
await call("POST", "/v1/auth/verify-email", { token });
cookie = "";
await call("POST", "/v1/auth/login", { email, password });
const org = (await call("POST", "/v1/orgs", { name: "Carga" })).json;
const H = { "x-org-id": org.id };
const conn = (await call("POST", "/v1/connections", { provider: "custom", project_id: org.project.id, name: "Carga", account_external_id: "carga", account_display_name: "Carga" }, H)).json;
const whToken = String(conn.webhook_url).split("/").pop();

const runId = randomBytes(4).toString("hex");
const events = Array.from({ length: ORDERS }, (_, i) => {
  const ext = `L${runId}-${i}`;
  return JSON.stringify({
    schema_version: "1.0",
    source: { provider: "carga", event_id: `evt-${ext}` },
    event_type: "payment.approved",
    occurred_at: new Date(Date.now() - (i % 600) * 1000).toISOString(),
    order: { external_order_id: ext, currency: "BRL", amount_minor: 1000 + (i % 50) * 100, payment_method: "pix", items: [{ external_product_id: `P${i % 20}`, unit_amount_minor: 1000 + (i % 50) * 100 }] },
    attribution: { utm_source: i % 3 ? "facebook" : "google", utm_medium: i % 3 ? "paid_social" : "cpc", utm_campaign: `Campanha ${i % 10}|${120000000000000 + (i % 10)}` },
    customer: { email: `cliente${i % 700}@carga.test` },
  });
});
const sign = (raw) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac("sha256", conn.signing_secret).update(`${t}.${raw}`).digest("hex")}`;
};
const postWebhook = async (raw) => (await fetch(`${api}/v1/webhooks/${whToken}`, { method: "POST", headers: { "content-type": "application/json", "x-tracker-signature": sign(raw) }, body: raw })).status;

// ------------------------------------------------------------------ cenários
const results = {};
const t0 = Date.now();
results.webhooks = await pool(ORDERS, CONC, (i) => postWebhook(events[i]));
const acceptedAt = Date.now();
const processed = () => Number(psql(`select count(*) from public.orders where external_order_id like 'L${runId}-%' and financial_status = 'approved'`));
await waitFor("processamento do worker", async () => processed() >= ORDERS, 900_000);
const doneAt = Date.now();
const attributedCount = () => Number(psql(`select count(*) from public.order_attributions a join public.orders o on o.id = a.order_id where o.external_order_id like 'L${runId}-%' and a.is_current and a.policy_key = 'default'`));
const attributedAtDone = attributedCount();
await waitFor("atribuição de todos os pedidos", async () => attributedCount() >= ORDERS, 900_000);
const attributedAt = Date.now();
results.pipeline = {
  orders: ORDERS,
  accept_seconds: (acceptedAt - t0) / 1000,
  end_to_end_seconds: (doneAt - t0) / 1000,
  drain_after_accept_seconds: (doneAt - acceptedAt) / 1000,
  orders_per_second_end_to_end: Math.round((ORDERS / ((doneAt - t0) / 1000)) * 10) / 10,
  attributions_when_orders_done: attributedAtDone,
  attribution_complete_seconds: (attributedAt - t0) / 1000,
};

const dupCount = Math.floor(ORDERS * 0.2);
results.duplicates = await pool(dupCount, CONC, (i) => postWebhook(events[i]));
await sleep(3000);
const after = psql(`select count(*) || ':' || coalesce(sum(approved_minor), 0) from public.orders where external_order_id like 'L${runId}-%'`);
const expectedSum = events.reduce((a, e) => a + JSON.parse(e).order.amount_minor, 0);
results.duplicates.orders_and_sum_after = after;
results.duplicates.idempotent = after === `${ORDERS}:${expectedSum}`;

const pk = org.project.public_key;
results.collect = await pool(VISITS, CONC, async (i) =>
  (
    await fetch(`${api}/v1/collect`, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://loja.carga.test", "user-agent": "carga/1.0" },
      body: JSON.stringify({
        v: 1,
        pk,
        aid: `a${runId}${String(i).padStart(13, "0")}`,
        sid: `s${runId}${String(i).padStart(7, "0")}`,
        consent: { analytics: true, ads: false, storage: true },
        ctx: { url: `https://loja.carga.test/oferta?utm_source=facebook&utm_medium=paid_social&utm_campaign=C${i % 10}`, ref: null },
        events: [{ id: `e${runId}${String(i).padStart(11, "0")}`, name: "PageView", ts: Date.now() }],
        token_request: i % 2 === 0,
      }),
    })
  ).status,
);

const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
const readSummary = async () => (await call("GET", `/v1/metrics/summary?from=${today}&to=${today}`, undefined, H)).status;
// Fase 1: logo após a carga (estatísticas do planejador possivelmente desatualizadas); fase 2: após ANALYZE.
results.reads = await pool(Math.ceil(READS / 2), Math.min(CONC, 16), readSummary);
psql("analyze");
results.reads_after_analyze = await pool(Math.ceil(READS / 2), Math.min(CONC, 16), readSummary);

// ------------------------------------------------------------------ custo em recursos (medido)
const sizes = psql(
  `select coalesce(sum(pg_total_relation_size(c.oid)), 0) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'iam', 'private') and c.relkind = 'r'`,
);
const totalOrders = Number(psql("select count(*) from public.orders"));
// Armazenamento separado: rastreamento (por visita/sessão) × demais tabelas (por pedido).
const TRACKING = ["visitors", "sessions", "tracking_events", "touchpoints", "link_tokens", "consent_records"];
const trackingBytes = Number(psql(`select coalesce(sum(pg_total_relation_size(c.oid)), 0) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname = any(array['${TRACKING.join("','")}'])`));
const totalSessions = Number(psql("select count(*) from public.sessions"));
const stats = dc("stats", "--no-stream", "--format", "{{.Name}} {{.CPUPerc}} {{.MemUsage}}");
const report = {
  run_id: runId,
  date: new Date().toISOString(),
  hardware: { cpu: os.cpus()[0]?.model ?? "desconhecido", cores: os.cpus().length, memory_gb: Math.round(os.totalmem() / 1e9), platform: `${os.type()} ${os.release()}`, note: "Mesma máquina executa gerador de carga e pilha (compete por CPU)" },
  versions: { node: process.version, postgres: psql("show server_version"), docker: execFileSync("docker", ["--version"], { encoding: "utf8" }).trim() },
  dataset: { orders: ORDERS, duplicates: dupCount, visits: VISITS, reads: READS, customers: 700, products: 20, campaigns: 10 },
  concurrency: CONC,
  limits: LIMITS,
  results,
  resources: {
    database_bytes_total: Number(sizes),
    orders_in_database: totalOrders,
    approx_bytes_per_order: totalOrders ? Math.round(Number(sizes) / totalOrders) : null,
    tracking_bytes: trackingBytes,
    sessions_in_database: totalSessions,
    bytes_per_order: totalOrders ? Math.round((Number(sizes) - trackingBytes) / totalOrders) : null,
    bytes_per_visit: totalSessions ? Math.round(trackingBytes / totalSessions) : null,
    container_stats_after: stats.trim().split("\n"),
  },
};
mkdirSync(values.out, { recursive: true });
const base = join(values.out, `${report.date.slice(0, 10)}-carga-${ORDERS}`);
writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
const row = (name, r) => `| ${name} | ${r.requests} | ${r.concurrency} | ${r.rps} | ${r.p50_ms} | ${r.p95_ms} | ${r.p99_ms} | ${r.max_ms} | ${Object.keys(r.errors).length ? JSON.stringify(r.errors) : "0"} |`;
writeFileSync(
  `${base}.md`,
  `# Teste de carga — ${report.date}

Comando: \`node scripts/load-test.mjs --orders ${ORDERS} --concurrency ${CONC} --visits ${VISITS} --reads ${READS}\` (pilha \`deploy/docker-compose.yml\`, dados sintéticos; limites de ingestão elevados: ${Object.entries(LIMITS).map(([k, v]) => `${k}=${v}`).join(", ")}).

**Hardware:** ${report.hardware.cpu}, ${report.hardware.cores} núcleos, ${report.hardware.memory_gb} GB, ${report.hardware.platform}. ${report.hardware.note}.
**Versões:** Node ${report.versions.node}, PostgreSQL ${report.versions.postgres}, ${report.versions.docker}.

| Cenário | Requisições | Concorrência | Req/s | p50 ms | p95 ms | p99 ms | máx ms | Erros |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${row("Webhooks (aceite)", results.webhooks)}
${row("Duplicatas (20%)", results.duplicates)}
${row("Coleta do SDK", results.collect)}
${row("Resumo de métricas (logo após a carga)", results.reads)}
${row("Resumo de métricas (após ANALYZE)", results.reads_after_analyze)}

**Pipeline ponta a ponta:** ${ORDERS} vendas aceitas em ${results.pipeline.accept_seconds} s; pedidos e razão processados em ${results.pipeline.end_to_end_seconds} s (${results.pipeline.orders_per_second_end_to_end} pedidos/s; ${results.pipeline.drain_after_accept_seconds} s após o último aceite); atribuição (prioridade menor na fila) concluída para todos em ${results.pipeline.attribution_complete_seconds} s (${results.pipeline.attributions_when_orders_done} prontas quando os pedidos terminaram).
**Idempotência sob carga:** ${results.duplicates.idempotent ? "preservada" : "FALHOU"} (pedidos:soma após duplicatas = ${results.duplicates.orders_and_sum_after}).
**Recursos:** banco com ${report.resources.orders_in_database} pedidos ocupa ${(report.resources.database_bytes_total / 1e6).toFixed(1)} MB (~${report.resources.bytes_per_order} bytes por pedido em tabelas de vendas — recebimentos, eventos, razão, atribuição — e ~${report.resources.bytes_per_visit} bytes por visita em tabelas de rastreamento; tamanhos incluem índices e são inflados em bases pequenas).

Limitações: gerador e pilha na mesma máquina; worker com uma réplica e concorrência padrão; resultados indicam ordem de grandeza, não SLA.
`,
);
console.log(JSON.stringify(results, null, 2));
console.log(`Relatório: ${base}.md`);
if (!values.keep) dc("down", "-v");
