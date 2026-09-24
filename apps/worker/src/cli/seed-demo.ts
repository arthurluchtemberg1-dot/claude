/**
 * Organização de DEMONSTRAÇÃO isolada (R39-04, T68): dados sintéticos, marcados `is_demo`, nunca enviados a destinos
 * e nunca misturados a organizações reais. Passam pelo mesmo pipeline (recebimento → worker → razão → atribuição).
 *
 * Uso: pnpm db:seed:demo -- --email voce@exemplo.com   (o usuário precisa já existir; vira proprietário da organização demo)
 */
import { createHash, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { createPool, requireEnv, withTx } from "@tracker/db";
import { drainOutbox, type WorkerDeps } from "../dispatch";
import { createSecretLoader, createSubscriptionSecretLoader } from "../secrets";

// pnpm repassa "--" literalmente; é removido para aceitar `pnpm db:seed:demo -- --email ...`.
const { values } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== "--"), options: { email: { type: "string" }, days: { type: "string", default: "14" } } });
if (!values.email) {
  console.error("Informe --email de um usuário existente (será proprietário da organização de demonstração).");
  process.exit(2);
}
const admin = createPool(requireEnv("DATABASE_URL_ADMIN"), { max: 2 });
const system = createPool(requireEnv("DATABASE_URL_SYSTEM"), { max: 4 });
const user = (await admin.query("select id from iam.users where email = $1", [values.email.toLowerCase()])).rows[0];
if (!user) {
  console.error("Usuário não encontrado. Cadastre-se no painel primeiro.");
  process.exit(1);
}
const orgId = randomUUID();
const rnd = (n: number) => Math.floor(Math.random() * n);
await withTx(system, { organizationId: orgId }, async (c) => {
  await c.query("insert into public.organizations (id, name, slug, is_demo, internal_mode, created_by) values ($1, 'Demonstração (dados sintéticos)', $2, true, true, $3)", [orgId, `demo-${orgId.slice(0, 8)}`, user.id]);
  await c.query("insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'owner')", [orgId, user.id]);
  const p = await c.query("insert into public.projects (organization_id, name, public_key) values ($1, 'Projeto demo', $2) returning id", [orgId, `pk_demo${randomUUID().replace(/-/g, "").slice(0, 20)}`]);
  await c.query("insert into public.attribution_policies (organization_id, policy_key, name, version, model, window_days, is_default) values ($1, 'default', 'Último clique pago elegível — 7 dias', 1, 'last_paid_click', 7, true)", [orgId]);
  const acct = await c.query("insert into public.provider_accounts (organization_id, project_id, provider, external_account_id, display_name) values ($1, $2, 'custom', 'demo', 'Checkout demo') returning id", [orgId, p.rows[0].id]);
  const conn = await c.query("insert into public.provider_connections (organization_id, project_id, provider_account_id, provider, kind, name, status) values ($1, $2, $3, 'custom', 'checkout', 'Checkout demo (sintético)', 'connected') returning id", [orgId, p.rows[0].id, acct.rows[0].id]);
  const days = Number(values.days);
  for (let i = 0; i < days * 6; i++) {
    const occurred = new Date(Date.now() - rnd(days * 86_400_000));
    const ext = `DEMO-${1000 + i}`;
    const paid = Math.random() < 0.8;
    const campaign = ["Lançamento|120000000000101", "Remarketing|120000000000102", "Frio|120000000000103"][rnd(3)];
    const events = [
      { event_type: paid ? "payment.approved" : "payment.pending", amount: [4700, 9700, 19700][rnd(3)] },
      ...(paid && Math.random() < 0.1 ? [{ event_type: "refund.succeeded", amount: 0 }] : []),
    ];
    for (const [k, ev] of events.entries()) {
      const body = {
        schema_version: "1.0",
        source: { provider: "demo", event_id: `${ext}-${k}` },
        event_type: ev.event_type,
        occurred_at: new Date(occurred.getTime() + k * 86_400_000).toISOString(),
        order: { external_order_id: ext, external_transaction_id: `${ext}-tx`, currency: "BRL", amount_minor: ev.amount || undefined, payment_method: "pix", fee_minor: ev.amount ? Math.round(ev.amount * 0.05) : undefined },
        ...(ev.event_type === "refund.succeeded" ? { refund: { external_refund_id: `${ext}-r`, semantics: "full" } } : {}),
        attribution: Math.random() < 0.7 ? { utm_source: "facebook", utm_medium: "paid_social", utm_campaign: campaign } : null,
      };
      const raw = Buffer.from(JSON.stringify(body));
      const r = await c.query(
        `insert into public.webhook_receipts (organization_id, project_id, connection_id, provider, provider_account_id, dedup_key, dedup_method, source_event_type, body, body_sha256, content_type, auth_method, is_demo)
         values ($1,$2,$3,'custom',$4,$5,'provider_event_id',$6,$7,$8,'application/json','seed_demo',true) returning id`,
        [orgId, p.rows[0].id, conn.rows[0].id, acct.rows[0].id, `evt:${ext}-${k}`, ev.event_type, raw, createHash("sha256").update(raw).digest()],
      );
      await c.query("insert into public.outbox (organization_id, topic, payload, dedup_key, priority) values ($1, 'receipt.process', $2, $3, 1)", [orgId, JSON.stringify({ receipt_id: r.rows[0].id }), `receipt:${r.rows[0].id}`]);
    }
  }
});
const deps: WorkerDeps = {
  pools: { system },
  tokenHmacKey: Buffer.from(requireEnv("TOKEN_HMAC_SECRET"), "base64"),
  now: () => new Date(),
  log: () => undefined,
  delivery: { environment: "demo", allowExternalDelivery: false, fetchImpl: fetch, loadSecret: createSecretLoader() },
  // Demonstração nunca envia nada para fora (T68): sem rede pública nem privada.
  outbound: { policy: { allowPrivateNetworks: false, allowPublicNetworks: false, requireHttps: true }, loadSecrets: createSubscriptionSecretLoader() },
};
const processed = await drainOutbox(deps, { maxRounds: 50 });
console.log(`Organização de demonstração criada (${orgId}); ${processed} itens processados. Selecione-a no painel.`);
await Promise.all([admin.end(), system.end()]);
