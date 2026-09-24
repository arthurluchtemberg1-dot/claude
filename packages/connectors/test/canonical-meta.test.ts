import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalConnector,
  createMetaCapiDestination,
  interpretMetaResponse,
  metaEventId,
  parseMetaInsights,
  signCanonicalBody,
  verifyCanonicalSignature,
  buildMetaRequest,
  CONNECTOR_CATALOG,
  type ConversionOrderContext,
} from "../src";

const now = new Date("2026-09-24T12:00:00Z");
const secret = "segredo-de-teste-canonical";
const event = {
  schema_version: "1.0",
  organization_id: "org-falsa-do-corpo",
  source: { provider: "erp", event_id: "evt-1", event_type: "order.paid" },
  event_type: "payment.approved",
  occurred_at: "2026-09-24T11:59:00-03:00",
  order: { external_order_id: "PED-1", external_transaction_id: "CHG-1", currency: "BRL", amount_minor: 1799, payment_method: "pix", items: [{ external_product_id: "P1", unit_amount_minor: 1799 }] },
  attribution: { tracking_token: "trk_AbCdEfGhIjKlMnOpQrSt12", utm_source: "meta", utm_medium: "paid_social" },
};

describe("webhook canônico assinado", () => {
  const raw = Buffer.from(JSON.stringify(event));
  const t = Math.floor(now.getTime() / 1000);

  it("aceita assinatura válida e segredo anterior durante rotação", () => {
    const header = signCanonicalBody(secret, raw, t);
    expect(verifyCanonicalSignature(header, raw, [secret], now)).toEqual({ ok: true });
    expect(verifyCanonicalSignature(header, raw, ["novo", secret], now)).toEqual({ ok: true });
  });

  it("T19 rejeita assinatura inválida, corpo alterado e replay fora da janela", () => {
    const header = signCanonicalBody(secret, raw, t);
    expect(verifyCanonicalSignature(header, raw, ["outro"], now).ok).toBe(false);
    expect(verifyCanonicalSignature(header, Buffer.from(raw.toString().replace("1799", "9999")), [secret], now).ok).toBe(false);
    expect(verifyCanonicalSignature(signCanonicalBody(secret, raw, t - 3600), raw, [secret], now)).toMatchObject({ ok: false, reason: expect.stringMatching(/janela/) });
    expect(verifyCanonicalSignature(undefined, raw, [secret], now).ok).toBe(false);
    const res = canonicalConnector.authenticate({ rawBody: raw, headers: { "x-tracker-signature": header }, receivedAt: now }, { secrets: {}, config: {}, urlTokenVerified: true });
    expect(res.ok).toBe(false);
  });

  it("T21 organization_id do corpo é ignorado e registrado", () => {
    const r = canonicalConnector.normalize(event, { config: {}, receivedAt: now, connectionEnvironment: "production" });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.events[0]!.notes.join(" ")).toMatch(/organization_id do corpo ignorado/);
    expect(r.events[0]!.financial.find((f) => f.type === "payment.approved")).toMatchObject({ transactionKey: "CHG-1", amountMinor: 1799n });
    expect(r.events[0]!.declaredTracking?.trackingToken).toBe("trk_AbCdEfGhIjKlMnOpQrSt12");
  });

  it("T20 aprovação sem valor ou schema desconhecido → quarentena", () => {
    const noAmount = { ...event, order: { ...event.order, amount_minor: undefined } };
    expect(canonicalConnector.normalize(noAmount, { config: {}, receivedAt: now, connectionEnvironment: "production" }).status).toBe("quarantine");
    expect(canonicalConnector.normalize({ ...event, schema_version: "9.9" }, { config: {}, receivedAt: now, connectionEnvironment: "production" }).status).toBe("quarantine");
    expect(canonicalConnector.normalize({ ...event, order: { ...event.order, amount_minor: 17.99 } }, { config: {}, receivedAt: now, connectionEnvironment: "production" }).status).toBe("quarantine");
  });

  it("dedup por source.event_id", () => {
    expect(canonicalConnector.dedupIdentity(event, { rawBody: raw, headers: {}, receivedAt: now })).toMatchObject({ key: "evt:evt-1", method: "provider_event_id" });
  });
});

const orderCtx: ConversionOrderContext = {
  orderId: "0b8f0c1e-0000-4000-8000-000000000001",
  externalOrderId: "PED-1",
  transactionKey: "CHG-1",
  currency: "BRL",
  amountMinor: 19990n,
  approvedAt: new Date("2026-09-24T10:00:00Z"),
  items: [{ externalProductId: "321", quantity: 1, unitAmountMinor: 19990n }],
  contact: { email: "  Cliente@Dominio.com ", phone: "11999999999", name: "Cliente Exemplo" },
  browser: { fbp: "fb.1.1726000000000.123456789", fbc: "fb.1.1726000000000.IwAR1", clientIp: "203.0.113.10", userAgent: "Mozilla/5.0", eventSourceUrl: "https://lp.exemplo.com/oferta", adsConsent: true },
  isTest: false,
  isDemo: false,
};

describe("Meta CAPI", () => {
  const dest = createMetaCapiDestination({ environment: "production", phoneCountryCode: "55" });

  it("hash somente em em/ph; fbc/fbp/IP/UA sem hash; valor e horário originais", () => {
    const id = dest.eventId(orderCtx);
    const p = dest.buildPayload(orderCtx, id);
    expect(p.user_data.em).toEqual([createHash("sha256").update("cliente@dominio.com").digest("hex")]);
    expect(p.user_data.ph).toEqual([createHash("sha256").update("5511999999999").digest("hex")]);
    expect(p.user_data.fbp).toBe(orderCtx.browser!.fbp);
    expect(p.user_data.fbc).toBe(orderCtx.browser!.fbc);
    expect(p.user_data.client_ip_address).toBe("203.0.113.10");
    expect(p.user_data).not.toHaveProperty("fn");
    expect(p.event_time).toBe(Math.floor(orderCtx.approvedAt.getTime() / 1000));
    expect(p.custom_data).toMatchObject({ value: 199.9, currency: "BRL", order_id: "PED-1", num_items: 1 });
    expect(JSON.stringify(dest.redact(p))).not.toContain("5511");
  });

  it("sem consentimento de publicidade não envia sinais do navegador", () => {
    const p = dest.buildPayload({ ...orderCtx, browser: { ...orderCtx.browser!, adsConsent: false } }, "x");
    expect(p.user_data).not.toHaveProperty("fbp");
    expect(p.user_data).not.toHaveProperty("client_ip_address");
  });

  it("T24 event_id estável entre tentativas e distinto por ambiente", () => {
    expect(dest.eventId(orderCtx)).toBe(dest.eventId({ ...orderCtx }));
    expect(metaEventId(orderCtx.orderId, "CHG-1", "production")).not.toBe(metaEventId(orderCtx.orderId, "CHG-1", "test"));
  });

  it("T28 evento mais antigo que a janela não é elegível e a data não é alterada", () => {
    const old = { ...orderCtx, approvedAt: new Date("2026-09-01T10:00:00Z") };
    expect(dest.eligibility(old, now)).toMatchObject({ eligible: false });
    expect(dest.buildPayload(old, "x").event_time).toBe(Math.floor(old.approvedAt.getTime() / 1000));
  });

  it("T68 dados de demonstração nunca são elegíveis", () => {
    expect(dest.eligibility({ ...orderCtx, isDemo: true }, now)).toMatchObject({ eligible: false });
  });

  it("interpreta respostas: aceite, 429/5xx retentável, erro permanente, timeout desconhecido", () => {
    expect(interpretMetaResponse(200, { events_received: 1, fbtrace_id: "T" }, 10, false)).toMatchObject({ outcome: "accepted", traceId: "T" });
    expect(interpretMetaResponse(429, {}, 10, false).outcome).toBe("retryable_error");
    expect(interpretMetaResponse(500, {}, 10, false).outcome).toBe("retryable_error");
    expect(interpretMetaResponse(400, { error: { code: 100, message: "Invalid parameter" } }, 10, false)).toMatchObject({ outcome: "rejected", providerCode: "100" });
    expect(interpretMetaResponse(null, null, 10000, true).outcome).toBe("timeout_unknown");
  });

  it("monta requisição para a versão verificada, validando IDs", () => {
    const r = buildMetaRequest({ pixelId: "123456789012345", apiVersion: "v24.0", testEventCode: "TEST123", actionSource: "website" }, [], "tok", null);
    expect(r.url).toBe("https://graph.facebook.com/v24.0/123456789012345/events");
    expect(r.body.test_event_code).toBe("TEST123");
    expect(() => buildMetaRequest({ pixelId: "../x", apiVersion: "v24.0", testEventCode: null, actionSource: "website" }, [], "t", null)).toThrow();
  });
});

describe("Meta Ads insights", () => {
  it("converte linhas diárias em gasto exato por nível sem somar alcance", () => {
    const { rows, errors } = parseMetaInsights(
      [
        { account_currency: "BRL", campaign_id: "120000000000001", campaign_name: "Campanha A", spend: "30.00", impressions: "1000", inline_link_clicks: "25", reach: "800", date_start: "2026-09-20", date_stop: "2026-09-20" },
        { account_currency: "BRL", campaign_id: "120000000000001", spend: "12.345", date_start: "2026-09-21", date_stop: "2026-09-21" },
        { account_currency: "BRL", spend: "1.00", date_start: "2026-09-20", date_stop: "2026-09-26" },
      ],
      "campaign",
      "BRL",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityExternalId: "120000000000001", spendMinor: 3000n, impressions: 1000n, linkClicks: 25n });
    expect(errors).toHaveLength(2);
  });
});

describe("catálogo", () => {
  it("todos os conectores têm estado real; somente implementados declaram capacidades", () => {
    const ids = new Set<string>();
    for (const m of CONNECTOR_CATALOG) {
      expect(ids.has(m.id)).toBe(false);
      ids.add(m.id);
      if (m.state === "planned") expect(Object.keys(m.capabilities)).toHaveLength(0);
    }
    expect(CONNECTOR_CATALOG.length).toBeGreaterThan(100);
    expect(CONNECTOR_CATALOG.filter((m) => m.state === "validated_production")).toHaveLength(0);
  });
});
