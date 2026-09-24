/**
 * Simulador de webhook para ambiente local/teste (R41-05). Envia o exemplo DOCUMENTADO da Lowify
 * (internal-webhook.md v1.0.0) ou um evento canônico assinado para a URL informada.
 * Não é um payload real e não valida a integração com o provedor.
 *
 * Uso:
 *   pnpm webhook:simulate -- --url <URL do webhook> [--provider lowify|custom] [--event sale.paid|sale.pending|sale.refunded]
 *                            [--order ord_123] [--amount 199.90] [--utm-term "kw|trk_..."] [--secret whsec_... (custom)]
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { signCanonicalBody } from "@tracker/connectors";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    url: { type: "string" },
    provider: { type: "string", default: "lowify" },
    event: { type: "string", default: "sale.paid" },
    order: { type: "string" },
    amount: { type: "string", default: "199.90" },
    "utm-term": { type: "string" },
    secret: { type: "string" },
  },
});
if (!values.url) {
  console.error("Informe --url (URL do webhook exibida ao criar a conexão).");
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const orderId = values.order ?? `ord_sim_${Date.now()}`;
let body: string;
const headers: Record<string, string> = { "content-type": "application/json" };
if (values.provider === "lowify") {
  const doc = JSON.parse(readFileSync(join(here, "../../../../packages/connectors/test/fixtures/lowify/documented-example.json"), "utf8"));
  const ts = new Date().toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).replace("T", " ");
  const amount = Number(values.amount);
  const payload = {
    ...doc,
    event: values.event,
    status: values.event === "sale.paid" ? "paid" : values.event === "sale.refunded" ? "refunded" : "pending",
    order_id: orderId,
    sale_amount: amount,
    timestamp: ts,
    product: { ...doc.product, price: amount },
    tracking: { ...doc.tracking, ...(values["utm-term"] ? { utm_term: values["utm-term"] } : {}) },
  };
  body = JSON.stringify(payload);
  headers["idempotency-key"] = `${orderId}:${values.event}:${payload.product.id}`;
} else {
  if (!values.secret) {
    console.error("Para --provider custom informe --secret (segredo de assinatura).");
    process.exit(2);
  }
  const map: Record<string, string> = { "sale.paid": "payment.approved", "sale.pending": "payment.pending", "sale.refunded": "refund.succeeded" };
  const eventType = map[values.event!] ?? values.event!;
  const minor = Math.round(Number(values.amount) * 100);
  const evt: Record<string, unknown> = {
    schema_version: "1.0",
    source: { provider: "simulador", event_id: `sim-${orderId}-${eventType}` },
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    order: { external_order_id: orderId, external_transaction_id: `${orderId}-tx`, currency: "BRL", amount_minor: minor, payment_method: "pix" },
  };
  if (eventType === "refund.succeeded") evt.refund = { external_refund_id: `${orderId}-r`, semantics: "full" };
  body = JSON.stringify(evt);
  headers["x-tracker-signature"] = signCanonicalBody(values.secret, body, Math.floor(Date.now() / 1000));
}
const res = await fetch(values.url, { method: "POST", headers, body });
console.log(`HTTP ${res.status} ${await res.text()}`);
console.log(`Pedido simulado: ${orderId} (dados sintéticos derivados do exemplo documentado)`);
