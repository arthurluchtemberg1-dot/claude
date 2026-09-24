import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lowifyConnector } from "../src";

const documented = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/lowify/documented-example.json"), "utf8"));
const ctx = { config: {}, receivedAt: new Date("2026-03-10T17:30:05Z"), connectionEnvironment: "production" as const };
const req = (body: unknown, headers: Record<string, string> = {}) => ({ rawBody: Buffer.from(JSON.stringify(body)), headers, receivedAt: ctx.receivedAt });

describe("conector Lowify (exemplo documentado v1.0.0)", () => {
  it("normaliza sale.paid em aprovação com valor exato, item e UTMs declaradas", () => {
    const r = lowifyConnector.normalize(documented, ctx);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const e = r.events[0]!;
    expect(e.eventType).toBe("payment.approved");
    expect(e.externalOrderId).toBe("ord_xxxxxxxxx");
    expect(e.occurredAt.toISOString()).toBe("2026-03-10T17:30:00.000Z"); // fuso assumido America/Sao_Paulo
    const approval = e.financial.find((f) => f.type === "payment.approved");
    expect(approval).toMatchObject({ amountMinor: 19990n, currency: "BRL", transactionKey: "lowify:ord_xxxxxxxxx" });
    const items = e.financial.find((f) => f.type === "order.items");
    expect(items).toMatchObject({ items: [{ externalProductId: "321", itemType: "main", unitAmountMinor: 19990n }] });
    expect(e.declaredTracking?.utm).toEqual({ source: "facebook", medium: "cpc", campaign: "campanha", content: "criativo-a", term: "keyword" });
    // click_id/campaign_id são internos da Lowify: nunca tratados como IDs de anúncio.
    expect(e.declaredTracking?.campaignId).toBeNull();
    expect(e.declaredTracking?.providerRefs).toEqual({ lowify_click_id: "10", lowify_campaign_id: "20" });
    expect(e.notes.join(" ")).toMatch(/Moeda assumida/);
  });

  it("idempotência de recebimento segue o Idempotency-Key documentado", () => {
    const id = lowifyConnector.dedupIdentity(documented, req(documented, { "idempotency-key": "ord_xxxxxxxxx:sale.paid:321" }));
    expect(id).toMatchObject({ key: "ord_xxxxxxxxx:sale.paid:321", method: "provider_idempotency_header" });
    const noHeader = lowifyConnector.dedupIdentity(documented, req(documented));
    expect(noHeader).toMatchObject({ key: "ord_xxxxxxxxx:sale.paid:321", method: "fingerprint" });
    // Bump: outro produto do mesmo pedido gera outra chave de recebimento (mesma transação no domínio).
    const bump = { ...documented, product: { id: 999, name: "Bump", price: 19.9, type: "bump" } };
    expect(lowifyConnector.dedupIdentity(bump, req(bump))!.key).toBe("ord_xxxxxxxxx:sale.paid:999");
  });

  it("T06 sale.pending não gera aprovação", () => {
    const r = lowifyConnector.normalize({ ...documented, event: "sale.pending", status: "pending" }, ctx);
    expect(r.status === "ok" && r.events[0]!.financial.map((f) => f.type)).toEqual(["order.items", "payment.pending"]);
  });

  it("sale.refunded vira reembolso integral com hipótese registrada", () => {
    const r = lowifyConnector.normalize({ ...documented, event: "sale.refunded", status: "refunded" }, ctx);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.events[0]!.financial[1]).toMatchObject({ type: "refund.succeeded", semantics: "full", amountMinor: null });
    expect(r.events[0]!.notes.join(" ")).toMatch(/integral/);
  });

  it("T20 evento desconhecido ou valor ausente vai para quarentena, sem aprovação", () => {
    expect(lowifyConnector.normalize({ ...documented, event: "sale.approved" }, ctx).status).toBe("quarantine");
    const { sale_amount: _drop, ...noAmount } = documented;
    expect(lowifyConnector.normalize(noAmount, ctx)).toMatchObject({ status: "quarantine" });
    expect(lowifyConnector.normalize({ ...documented, sale_amount: 10.005 }, ctx).status).toBe("quarantine");
    expect(lowifyConnector.normalize({ ...documented, timestamp: "10/03/2026" }, ctx).status).toBe("quarantine");
    expect(lowifyConnector.normalize("texto", ctx).status).toBe("quarantine");
  });

  it("autenticação depende do token opaco da URL", () => {
    expect(lowifyConnector.authenticate(req(documented), { secrets: {}, config: {}, urlTokenVerified: false }).ok).toBe(false);
    const ok = lowifyConnector.authenticate(req(documented), { secrets: {}, config: {}, urlTokenVerified: true });
    expect(ok.ok && ok.method).toBe("url_token");
  });

  it("lê token próprio somente do campo configurado como transportador", () => {
    const withToken = { ...documented, tracking: { ...documented.tracking, utm_term: "trk_AbCdEfGhIjKlMnOpQrSt12" } };
    const noCarrier = lowifyConnector.normalize(withToken, ctx);
    expect(noCarrier.status === "ok" && noCarrier.events[0]!.declaredTracking?.trackingToken).toBeNull();
    const carrier = lowifyConnector.normalize(withToken, { ...ctx, config: { token_carrier: "utm_term" } });
    expect(carrier.status === "ok" && carrier.events[0]!.declaredTracking?.trackingToken).toBe("trk_AbCdEfGhIjKlMnOpQrSt12");
  });

  it("conexão de teste marca eventos como teste", () => {
    const r = lowifyConnector.normalize(documented, { ...ctx, connectionEnvironment: "test" });
    expect(r.status === "ok" && r.events[0]!.isTest).toBe(true);
  });
});
