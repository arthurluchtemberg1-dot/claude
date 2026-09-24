import { describe, expect, it } from "vitest";
import { attribute, classifyTouch, totalWeight, type AttributionPolicy, type AttributionTouchpoint } from "../src";

const conv = new Date("2026-09-20T12:00:00Z");
const daysBefore = (d: number) => new Date(conv.getTime() - d * 86_400_000);

function tp(id: string, daysAgo: number, signals: Parameters<typeof classifyTouch>[0], extra: Partial<AttributionTouchpoint> = {}): AttributionTouchpoint {
  const c = classifyTouch(signals);
  return {
    id,
    occurredAt: daysBefore(daysAgo),
    channel: c.channel,
    isPaid: c.isPaid,
    network: c.network,
    evidence: "session",
    campaignId: null,
    adsetId: null,
    adId: null,
    idsValidated: false,
    utm: { source: signals.utmSource ?? null, medium: signals.utmMedium ?? null, campaign: signals.utmCampaign ?? null, content: null, term: null },
    declared: false,
    ...extra,
  };
}

const policy = (model: AttributionPolicy["model"], windowDays = 7): AttributionPolicy => ({ id: "p1", version: 1, model, windowDays });

const paidMeta = { utmSource: "facebook", utmMedium: "paid_social", utmCampaign: "c1" };
const bio = { referrerHost: "l.instagram.com", landingHost: "loja.exemplo.com" };

describe("classificação de toques", () => {
  it("fbclid sozinho não comprova mídia paga", () => {
    const c = classifyTouch({ clickIds: { fbclid: "abc" } });
    expect(c.isPaid).toBe(false);
    expect(c.network).toBe("meta");
  });
  it("gclid comprova clique pago do Google", () => {
    expect(classifyTouch({ clickIds: { gclid: "x" } })).toMatchObject({ isPaid: true, network: "google" });
  });
  it("sem sinais → direto", () => {
    expect(classifyTouch({}).channel).toBe("direct");
  });
});

describe("motor de atribuição", () => {
  it("T29 visita com UTM paga e compra vinculada", () => {
    const r = attribute(policy("last_paid_click"), conv, [tp("t1", 1, paidMeta, { evidence: "token_link" })]);
    expect(r.category).toBe("paid");
    expect(r.selectedTouchpointId).toBe("t1");
    expect(r.evidence).toBe("token_link");
    expect(r.quality).not.toBe("none");
  });

  it("T30 compra sem origem → sem atribuição com motivo", () => {
    const r = attribute(policy("last_paid_click"), conv, []);
    expect(r.category).toBe("unattributed");
    expect(r.unattributedReason).toBe("no_touchpoints");
    expect(r.credits).toHaveLength(0);
  });

  it("T31 retorno pela bio após clique pago: depende da política escolhida", () => {
    const touches = [tp("paid", 3, paidMeta), tp("bio", 0.1, bio)];
    expect(attribute(policy("last_paid_click"), conv, touches).selectedTouchpointId).toBe("paid");
    expect(attribute(policy("last_touch"), conv, touches).selectedTouchpointId).toBe("bio");
    // Janela de 1 dia exclui o clique pago de 3 dias atrás.
    const narrow = attribute(policy("last_paid_click", 1), conv, touches);
    expect(narrow.selectedTouchpointId).toBeNull();
    expect(narrow.category).toBe("organic");
    expect(narrow.path.length).toBe(1);
  });

  it("T32 clique fora da janela não recebe crédito", () => {
    const r = attribute(policy("last_paid_click", 7), conv, [tp("old", 8, paidMeta)]);
    expect(r.category).toBe("unattributed");
    expect(r.unattributedReason).toBe("all_outside_window");
  });

  it("T33 dois cliques elegíveis: primeiro/último reproduzíveis", () => {
    const touches = [tp("b", 2, paidMeta), tp("a", 5, { ...paidMeta, utmCampaign: "c0" })];
    for (let i = 0; i < 5; i++) {
      expect(attribute(policy("first_paid_click"), conv, [...touches].reverse()).selectedTouchpointId).toBe("a");
      expect(attribute(policy("last_paid_click"), conv, touches).selectedTouchpointId).toBe("b");
    }
    // Empate de horário: desempate estável por id.
    const tie = [tp("z", 2, paidMeta), tp("y", 2, paidMeta)];
    expect(attribute(policy("last_paid_click"), conv, tie).selectedTouchpointId).toBe("z");
    expect(attribute(policy("first_paid_click"), conv, tie).selectedTouchpointId).toBe("y");
  });

  it("T41 linear: pesos somam 1 e receita não multiplica", () => {
    const r = attribute(policy("linear"), conv, [tp("a", 3, paidMeta), tp("b", 2, bio), tp("c", 1, {})]);
    expect(r.credits).toHaveLength(3);
    expect(totalWeight(r.credits)).toEqual({ num: 1n, den: 1n });
    const revenue = 10000n;
    const distributed = r.credits.reduce((acc, c) => acc + (revenue * c.weight.num) / c.weight.den, 0n);
    expect(distributed).toBeLessThanOrEqual(revenue);
  });

  it("toque posterior à conversão é ignorado (data real da conversão)", () => {
    const after = { ...tp("late", 0, paidMeta), occurredAt: new Date(conv.getTime() + 60_000) };
    expect(attribute(policy("last_paid_click"), conv, [after]).unattributedReason).toBe("no_touchpoints");
  });

  it("explicit_order usa o vínculo técnico mais forte", () => {
    const r = attribute(policy("explicit_order"), conv, [
      tp("session", 1, paidMeta, { evidence: "session" }),
      tp("checkout", 0, paidMeta, { evidence: "checkout_source", declared: true }),
      tp("token", 0.5, paidMeta, { evidence: "token_link" }),
    ]);
    expect(r.selectedTouchpointId).toBe("token");
  });
});
