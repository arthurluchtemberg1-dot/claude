import { describe, expect, it } from "vitest";
import { DEFAULT_NOTIFICATION_PREFERENCES, channelEnabled, inQuietHours, notificationPlaysSound, safeLabel, saleNotificationText } from "../src";

describe("notificações: regras de domínio (R34)", () => {
  it("horário silencioso no fuso da organização, inclusive atravessando a meia-noite", () => {
    const tz = "America/Sao_Paulo"; // UTC-3
    const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 24, h + 3, m));
    expect(inQuietHours(at(23), tz, "22:00", "07:00")).toBe(true);
    expect(inQuietHours(at(3), tz, "22:00", "07:00")).toBe(true);
    expect(inQuietHours(at(7), tz, "22:00", "07:00")).toBe(false); // fim exclusivo
    expect(inQuietHours(at(12), tz, "22:00", "07:00")).toBe(false);
    expect(inQuietHours(at(13, 30), tz, "13:00", "14:00")).toBe(true);
    expect(inQuietHours(at(13), tz, null, null)).toBe(false);
    expect(inQuietHours(at(13), tz, "13:00", "13:00")).toBe(false);
    expect(inQuietHours(at(13), tz, "25:00", "07:00")).toBe(false);
  });

  it("canais: padrão por tipo, preferência do usuário e teste manual sempre entregue", () => {
    const p = { ...DEFAULT_NOTIFICATION_PREFERENCES, kinds: { "sale.approved": { push: false } } };
    expect(channelEnabled(DEFAULT_NOTIFICATION_PREFERENCES, "sale.approved", "push")).toBe(true);
    expect(channelEnabled(DEFAULT_NOTIFICATION_PREFERENCES, "sale.approved", "email")).toBe(false);
    expect(channelEnabled(p, "sale.approved", "push")).toBe(false);
    expect(channelEnabled(p, "sale.approved", "in_app")).toBe(true);
    expect(channelEnabled({ ...p, kinds: { "system.test": { push: false } } }, "system.test", "push")).toBe(true);
    expect(notificationPlaysSound("sale.approved")).toBe(true);
    expect(notificationPlaysSound("sale.refunded")).toBe(false);
  });

  it("texto da venda: valor exato, tipo da venda, teste identificado, valores ocultáveis e nomes externos higienizados", () => {
    const base = { kind: "sale.approved" as const, amountMinor: 19700n, currency: "BRL", productName: "Curso\u0000 Completo\n", projectName: "Loja", origin: "Meta · Black Friday", isTest: false, saleType: "first" as const };
    const t = saleNotificationText(base);
    expect(t.title).toMatch(/^Venda aprovada · R\$\s197,00$/);
    expect(t.body).toBe("Curso Completo · Loja · Meta · Black Friday");
    expect(saleNotificationText(base, { hideAmounts: true }).title).toBe("Venda aprovada");
    expect(saleNotificationText({ ...base, saleType: "renewal", isTest: true }).title).toMatch(/^\[teste\] Renovação aprovada/);
    expect(saleNotificationText({ ...base, origin: null }).body).toContain("origem ainda não atribuída");
    expect(saleNotificationText({ ...base, kind: "sale.refunded", partial: true }).title).toMatch(/^Reembolso parcial · R\$\s197,00$/);
    expect(saleNotificationText({ ...base, kind: "sale.chargeback" }).body).not.toContain("Meta");
    expect(safeLabel("x".repeat(100), 10)).toHaveLength(10);
    expect(safeLabel("   ")).toBeNull();
  });
});
