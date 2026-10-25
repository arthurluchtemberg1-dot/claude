import { generateVapidKeys, signCanonicalBody } from "@tracker/connectors";
import { withTx } from "@tracker/db";
import { scheduleTicks } from "@tracker/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConnection, createHarness, createOrg, drain, postWebhook, signupVerified, type Client, type Harness } from "../helpers";

/**
 * Central de notificações (R34-01..R34-04): venda aprovada/renovação/estorno/chargeback para quem tem acesso ao
 * projeto, deduplicação por fato, preferências e horário silencioso, Web Push (endpoint validado, valores ocultos,
 * inscrição expirada desativada), e-mail, conteúdo sem dados pessoais e monitores periódicos.
 */

let h: Harness;
let owner: { client: Client; email: string; userId: string };
let viewer: Client;
let restricted: Client;
let orgId: string;
let p1: string;
let conn: { token: string; signing_secret: string; id: string };
const uid = () => Math.random().toString(36).slice(2, 8);
const FCM = "https://fcm.googleapis.com/fcm/send/";

async function send(body: Record<string, unknown>) {
  const raw = JSON.stringify({ schema_version: "1.0", source: { provider: "erp", event_id: `evt-${uid()}` }, occurred_at: h.clock.now.toISOString(), ...body });
  const r = await postWebhook(h, conn.token, raw, { "x-tracker-signature": signCanonicalBody(conn.signing_secret, raw, Math.floor(h.clock.now.getTime() / 1000)) });
  expect(r.statusCode).toBe(200);
  return raw;
}

async function list(c: Client, qs = "") {
  const r = await c.req("GET", `/v1/notifications${qs}`);
  expect(r.statusCode, r.body).toBe(200);
  return c.json(r) as { unread_count: number; notifications: Array<Record<string, any>> };
}

async function invite(role: string, label: string) {
  const u = await signupVerified(h, label);
  await owner.client.req("POST", "/v1/invites", { email: u.email, role });
  const token = new URL([...h.emails].reverse().find((m) => m.to === u.email && m.kind === "invite")!.actionUrl!).searchParams.get("token")!;
  expect((await u.client.req("POST", "/v1/invites/accept", { token })).statusCode).toBe(200);
  u.client.orgId = orgId;
  return u;
}

beforeAll(async () => {
  const vapid = generateVapidKeys();
  h = await createHarness({ WEB_PUSH_VAPID_PUBLIC_KEY: vapid.publicKey, WEB_PUSH_VAPID_PRIVATE_KEY: vapid.privateKey, WEB_PUSH_SUBJECT: "mailto:ops@example.com" });
  owner = await signupVerified(h, "ntf-owner");
  ({ orgId, projectId: p1 } = await createOrg(owner.client, "Notificações Org"));
  const p2 = owner.client.json(await owner.client.req("POST", "/v1/projects", { name: "Outro projeto" })).id;
  viewer = (await invite("viewer", "ntf-viewer")).client;
  const analyst = await invite("analyst", "ntf-analyst");
  restricted = analyst.client;
  const m = owner.client.json(await owner.client.req("GET", "/v1/members")).members.find((x: { user_id: string }) => x.user_id === analyst.userId);
  expect((await owner.client.req("PUT", `/v1/members/${m.id}/projects`, { project_ids: [p2] })).statusCode).toBe(200);
  conn = await createConnection(owner.client, p1, "custom");
});
afterAll(async () => h.close());

describe("notificações de vendas (R34-02, R34-03, R34-04)", () => {
  const ext = `N-${uid()}`;
  it("venda aprovada chega a quem acessa o projeto, com origem e sem dados pessoais; repetição não duplica", async () => {
    const raw = await send({
      event_type: "payment.approved",
      order: { external_order_id: ext, external_transaction_id: `${ext}-t1`, currency: "BRL", amount_minor: 19700, items: [{ external_product_id: "curso-1", name: "Curso Completo", unit_amount_minor: 19700, quantity: 1 }] },
      customer: { email: "comprador.secreto@cliente.test", name: "Fulano Comprador", phone: "+5511999990000" },
      attribution: { utm_source: "facebook", utm_medium: "paid_social", utm_campaign: "Black Friday|120200000000001" },
    });
    // Mesmo evento reenviado (retry do checkout): mesmo fato, nenhuma notificação nova.
    await postWebhook(h, conn.token, raw, { "x-tracker-signature": signCanonicalBody(conn.signing_secret, raw, Math.floor(h.clock.now.getTime() / 1000)) });
    await drain(h);

    const own = await list(owner.client);
    const sale = own.notifications.filter((n) => n.kind === "sale.approved");
    expect(sale).toHaveLength(1);
    expect(sale[0]).toMatchObject({ severity: "success", sound: true, label: "Venda aprovada", read_at: null });
    expect(sale[0]!.title).toMatch(/^Venda aprovada · R\$\s?197,00$/);
    expect(sale[0]!.body).toContain("Curso Completo");
    expect(sale[0]!.body).toContain("Black Friday"); // origem atribuída (nome da campanha, sem o ID)
    expect(sale[0]!.link).toMatch(/^\/vendas\/[0-9a-f-]{36}$/);
    const all = JSON.stringify(own.notifications);
    for (const pii of ["comprador.secreto", "Fulano", "99999"]) expect(all).not.toContain(pii);
    expect(own.unread_count).toBeGreaterThanOrEqual(1);

    expect((await list(viewer)).notifications.filter((n) => n.kind === "sale.approved")).toHaveLength(1);
    // Analista restrito a outro projeto não recebe.
    expect((await list(restricted)).notifications).toHaveLength(0);
  });

  it("renovação, reembolso parcial e chargeback com tipos e severidades próprios", async () => {
    await send({ event_type: "subscription.renewed", order: { external_order_id: ext, external_transaction_id: `${ext}-t2`, currency: "BRL", amount_minor: 9700 } });
    await send({ event_type: "refund.succeeded", order: { external_order_id: ext, external_transaction_id: `${ext}-t1`, currency: "BRL" }, refund: { external_refund_id: `r-${uid()}`, amount_minor: 5000, semantics: "incremental" } });
    await send({ event_type: "chargeback.confirmed", order: { external_order_id: ext, external_transaction_id: `${ext}-t2`, currency: "BRL" }, dispute: { external_dispute_id: `cb-${uid()}`, amount_minor: 9700 } });
    await drain(h);
    const n = (await list(owner.client)).notifications;
    expect(n.find((x) => x.kind === "sale.approved" && /Renovação aprovada/.test(x.title))?.title).toMatch(/R\$\s?97,00/);
    expect(n.find((x) => x.kind === "sale.refunded")).toMatchObject({ severity: "warning" });
    expect(n.find((x) => x.kind === "sale.refunded")!.title).toMatch(/^Reembolso parcial · R\$\s?50,00$/);
    expect(n.find((x) => x.kind === "sale.chargeback")).toMatchObject({ severity: "critical" });
  });

  it("marcar como lida, contador e leitura incremental (since)", async () => {
    const before = await list(owner.client);
    const first = before.notifications[0]!;
    expect((await owner.client.req("POST", "/v1/notifications/read", { ids: [first.id] })).statusCode).toBe(200);
    expect(c(await owner.client.req("GET", "/v1/notifications/unread-count")).unread_count).toBe(before.unread_count - 1);
    // Outro usuário não marca notificação alheia (RLS por usuário).
    expect(c(await viewer.req("POST", "/v1/notifications/read", { ids: [before.notifications[1]!.id] })).updated).toBe(0);
    // Leitura incremental: só o que foi criado depois do instante informado (base do som "sem reemitir antigas").
    const mark = new Date(h.clock.now.getTime() + 1000);
    h.clock.now = new Date(mark.getTime() + 1000);
    await send({ event_type: "payment.approved", order: { external_order_id: `NI-${uid()}`, currency: "BRL", amount_minor: 3300 } });
    await drain(h);
    const since = await list(owner.client, `?since=${encodeURIComponent(mark.toISOString())}`);
    expect(since.notifications.map((x) => x.title)).toEqual([expect.stringMatching(/33,00/)]);
    expect((await owner.client.req("POST", "/v1/notifications/read", { all: true })).statusCode).toBe(200);
    expect((await list(owner.client)).unread_count).toBe(0);
  });
});

function c(r: { body: string }) {
  return JSON.parse(r.body);
}

describe("preferências, push e e-mail (R34-01, R34-04)", () => {
  it("inscrição de push exige serviço conhecido e https; chaves não voltam pela API", async () => {
    const keys = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
    expect((await owner.client.req("POST", "/v1/notifications/push/subscriptions", { endpoint: "https://intranet.local/push/1", keys })).statusCode).toBe(400);
    expect((await owner.client.req("POST", "/v1/notifications/push/subscriptions", { endpoint: "http://fcm.googleapis.com/fcm/send/x", keys })).statusCode).toBe(400);
    const ok = await owner.client.req("POST", "/v1/notifications/push/subscriptions", { endpoint: `${FCM}owner-device-1`, keys, label: "Chrome no notebook" });
    expect(ok.statusCode, ok.body).toBe(201);
    const subs = c(await owner.client.req("GET", "/v1/notifications/push/subscriptions"));
    expect(subs.channel).toMatchObject({ available: false, public_key: expect.any(String) }); // envio externo desligado no ambiente
    expect(JSON.stringify(subs)).not.toMatch(/p256dh|tBHItJI5/);
    // Viewer não enxerga a inscrição do proprietário.
    expect(c(await viewer.req("GET", "/v1/notifications/push/subscriptions")).subscriptions).toHaveLength(0);
  });

  it("com envio externo desligado, push e e-mail ficam 'skipped' com motivo; a venda é registrada normalmente", async () => {
    const ext = `NS-${uid()}`;
    await send({ event_type: "payment.approved", order: { external_order_id: ext, currency: "BRL", amount_minor: 4700 } });
    await drain(h);
    const d = (await h.admin.query("select d.status, d.last_error from public.notification_deliveries d join public.notifications n on n.id = d.notification_id where n.organization_id = $1 and n.title like '%47,00%' and d.channel = 'push'", [orgId])).rows;
    expect(d).toEqual([expect.objectContaining({ status: "skipped", last_error: expect.stringMatching(/ALLOW_EXTERNAL_DELIVERY/) })]);
    expect(h.pushes).toHaveLength(0);
    const o = c(await owner.client.req("GET", `/v1/orders?q=${ext}&include_test=true`)).orders[0];
    expect(o).toMatchObject({ financial_status: "approved", approved_minor: "4700" });
  });

  it("push cifrado entregue sem dados pessoais; 'ocultar valores' remove o valor do push mas não do painel; e-mail de chargeback", async () => {
    h.worker.notifications.allowExternal = true;
    try {
      expect((await owner.client.req("PUT", "/v1/notifications/preferences", { hide_amounts: true, kinds: { "sale.approved": { email: true } } })).statusCode).toBe(200);
      const ext = `NP-${uid()}`;
      await send({ event_type: "payment.approved", order: { external_order_id: ext, external_transaction_id: `${ext}-t`, currency: "BRL", amount_minor: 29900 }, customer: { email: "outra.pessoa@cliente.test" } });
      await drain(h);
      const call = h.pushes.at(-1)!;
      expect(call.target.endpoint).toBe(`${FCM}owner-device-1`);
      expect(call.payload).toMatchObject({ kind: "sale.approved", title: "Venda aprovada", link: expect.stringMatching(/^\/vendas\//) });
      expect(JSON.stringify(call.payload)).not.toMatch(/299|outra\.pessoa/);
      const panel = (await list(owner.client)).notifications.find((n) => n.title.includes("299,00"));
      expect(panel).toBeTruthy();
      const mail = h.emails.filter((m) => m.to === owner.email && m.kind === "notification:sale.approved").at(-1)!;
      expect(mail.subject).toBe("Venda aprovada");
      expect(mail.text).not.toMatch(/299|outra\.pessoa/);

      await send({ event_type: "chargeback.confirmed", order: { external_order_id: ext, external_transaction_id: `${ext}-t`, currency: "BRL" }, dispute: { external_dispute_id: `cb-${uid()}`, amount_minor: 29900 } });
      await drain(h);
      expect(h.emails.some((m) => m.to === owner.email && m.kind === "notification:sale.chargeback")).toBe(true);

      // Serviço de push informa inscrição expirada (410): desativada, sem novas tentativas.
      h.setPushOutcome(() => ({ ok: false, status: 410, error: "HTTP 410", expired: true, retryable: false }));
      const pushesBefore = h.pushes.length;
      await send({ event_type: "payment.approved", order: { external_order_id: `NX-${uid()}`, currency: "BRL", amount_minor: 1000 } });
      await drain(h);
      expect(h.pushes.length).toBe(pushesBefore + 1);
      const sub = c(await owner.client.req("GET", "/v1/notifications/push/subscriptions")).subscriptions[0];
      expect(sub.disabled_at).toBeTruthy();
      expect(sub.disabled_reason).toMatch(/expirada/);
      await send({ event_type: "payment.approved", order: { external_order_id: `NY-${uid()}`, currency: "BRL", amount_minor: 1000 } });
      await drain(h);
      expect(h.pushes.length).toBe(pushesBefore + 1); // inscrição desativada não recebe mais
    } finally {
      h.worker.notifications.allowExternal = false;
      h.setPushOutcome(() => ({ ok: true, status: 201 }));
    }
  });

  it("tipo desligado não gera notificação; horário silencioso registra no painel sem push/e-mail", async () => {
    expect((await viewer.req("PUT", "/v1/notifications/preferences", { kinds: { "sale.approved": { in_app: false, push: false } } })).statusCode).toBe(200);
    const tz = c(await owner.client.req("GET", "/v1/notifications/preferences")).timezone as string;
    const hh = Number(new Date().toLocaleString("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }));
    const pad = (n: number) => String((n + 24) % 24).padStart(2, "0");
    expect((await owner.client.req("PUT", "/v1/notifications/preferences", { quiet_start: `${pad(hh - 1)}:00`, quiet_end: `${pad(hh + 1)}:00` })).statusCode).toBe(200);
    const sub = await owner.client.req("POST", "/v1/notifications/push/subscriptions", { endpoint: `${FCM}owner-device-2`, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } });
    expect(sub.statusCode).toBe(201);
    const viewerBefore = (await list(viewer)).notifications.length;
    await send({ event_type: "payment.approved", order: { external_order_id: `NQ-${uid()}`, currency: "BRL", amount_minor: 1234 } });
    await drain(h);
    expect((await list(viewer)).notifications.length).toBe(viewerBefore);
    const n = (await h.admin.query("select n.id, (select count(*)::int from public.notification_deliveries d where d.notification_id = n.id) as deliveries from public.notifications n where n.organization_id = $1 and n.user_id = $2 and n.title like '%12,34%'", [orgId, owner.userId])).rows;
    expect(n).toEqual([expect.objectContaining({ deliveries: 0 })]);
    // Preferências inválidas são recusadas.
    expect((await owner.client.req("PUT", "/v1/notifications/preferences", { quiet_start: "25:00", quiet_end: "07:00" })).statusCode).toBe(400);
    expect((await owner.client.req("PUT", "/v1/notifications/preferences", { kinds: { "inexistente.tipo": { push: true } } })).statusCode).toBe(400);
    expect((await owner.client.req("PUT", "/v1/notifications/preferences", {})).statusCode).toBe(200); // volta ao padrão
  });

  it("teste manual cria notificação só para quem pediu", async () => {
    const r = await viewer.req("POST", "/v1/notifications/test");
    expect(r.statusCode).toBe(200);
    await drain(h);
    expect((await list(viewer)).notifications.find((n) => n.kind === "system.test")).toMatchObject({ title: "Teste de notificação", link: "/notificacoes" });
    expect((await list(owner.client)).notifications.some((n) => n.kind === "system.test")).toBe(false);
  });

  it("catálogo de tipos indica o que está planejado e o que o perfil não recebe", async () => {
    const p = c(await viewer.req("GET", "/v1/notifications/preferences"));
    expect(p.kinds.find((k: { kind: string }) => k.kind === "balance.low")).toMatchObject({ availability: "planned", unavailable_reason: expect.stringMatching(/DEP-META-APP/) });
    expect(p.kinds.find((k: { kind: string }) => k.kind === "connection.stale")).toMatchObject({ permitted: false });
    expect(p.kinds.find((k: { kind: string }) => k.kind === "sale.approved")).toMatchObject({ permitted: true });
  });
});

describe("monitores periódicos (R34-02)", () => {
  async function tick() {
    await withTx(h.worker.pools.system, null, (cl) => scheduleTicks(cl, [orgId], h.clock.now));
    await drain(h);
  }

  it("integração sem eventos alerta uma vez na transição, só para quem gerencia integrações, e rearma ao voltar", async () => {
    const realNow = h.clock.now;
    // O teste avança o relógio da aplicação (não o do banco): desliga o monitor de fila para não confundir os dois.
    expect((await owner.client.req("PUT", "/v1/notifications/alert-settings", { queue_delay_minutes: 0 })).statusCode).toBe(200);
    try {
      await tick(); // estado inicial "ok"
      h.clock.now = new Date(realNow.getTime() + 25 * 3600_000);
      await tick();
      await tick();
      h.clock.now = new Date(h.clock.now.getTime() + 6 * 60_000);
      await tick(); // outra janela: continua "stale", sem repetir
      const stale = (await list(owner.client)).notifications.filter((n) => n.kind === "connection.stale");
      expect(stale).toHaveLength(1);
      expect(stale[0]).toMatchObject({ severity: "critical", link: "/diagnostico" });
      expect(stale[0]!.body).toMatch(/sem eventos há mais de 24 h/);
      expect((await list(viewer)).notifications.some((n) => n.kind === "connection.stale")).toBe(false);

      // Volta a receber: estado "ok"; um novo silêncio gera novo alerta.
      await send({ event_type: "payment.pending", order: { external_order_id: `NM-${uid()}`, currency: "BRL", amount_minor: 100 } });
      await drain(h);
      await h.admin.query("update public.webhook_receipts set received_at = $2 where connection_id = $1 and received_at > now() - interval '1 minute'", [conn.id, h.clock.now]);
      h.clock.now = new Date(h.clock.now.getTime() + 6 * 60_000);
      await tick();
      h.clock.now = new Date(h.clock.now.getTime() + 25 * 3600_000);
      await tick();
      expect((await list(owner.client)).notifications.filter((n) => n.kind === "connection.stale")).toHaveLength(2);
    } finally {
      h.clock.now = realNow;
    }
  });

  it("fila atrasada alerta e limiar 0 desliga o monitor", async () => {
    const r = await h.admin.query(
      "insert into public.outbox (organization_id, topic, payload, dedup_key, status, available_at, enqueued_at) values ($1, 'receipt.process', '{}', $2, 'enqueued', now() - interval '1 hour', now()) returning id",
      [orgId, `stuck-${uid()}`],
    );
    try {
      expect((await owner.client.req("PUT", "/v1/notifications/alert-settings", { queue_delay_minutes: 15 })).statusCode).toBe(200);
      h.clock.now = new Date(Date.now() + 11 * 60_000);
      await tick();
      const q = (await list(owner.client)).notifications.filter((n) => n.kind === "queue.delayed");
      expect(q).toHaveLength(1);
      expect(q[0]!.body).toMatch(/aguardando há mais de 15 min/);
      expect((await owner.client.req("PUT", "/v1/notifications/alert-settings", { queue_delay_minutes: 0 })).statusCode).toBe(200);
      expect((await viewer.req("PUT", "/v1/notifications/alert-settings", { queue_delay_minutes: 5 })).statusCode).toBe(403);
      expect(c(await owner.client.req("GET", "/v1/notifications/alert-settings")).alerts).toMatchObject({ queue_delay_minutes: 0 });
    } finally {
      await h.admin.query("delete from public.outbox where id = $1", [r.rows[0].id]);
      h.clock.now = new Date();
    }
  });
});
