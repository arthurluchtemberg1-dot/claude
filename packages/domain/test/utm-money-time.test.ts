import { describe, expect, it } from "vitest";
import {
  buildTrackedUrl,
  convertMoney,
  findUnexpandedMacros,
  formatMinorAsDecimal,
  jsonNumberToMinor,
  localDateRangeToUtc,
  parseDecimalToMinor,
  parseNameIdPair,
  parseWallTimeInZone,
  previousLocalPeriod,
  readUtms,
  sanitizeUrl,
  sumByCurrency,
  maskEmail,
  roleHas,
} from "../src";

describe("dinheiro exato", () => {
  it("converte decimais sem ponto flutuante", () => {
    expect(parseDecimalToMinor("199.90", "BRL")).toBe(19990n);
    expect(parseDecimalToMinor("17.99", "BRL")).toBe(1799n);
    expect(jsonNumberToMinor(199.9, "BRL")).toBe(19990n);
    // Resultado de aritmética binária não é aceito como dinheiro (sem arredondamento silencioso).
    expect(() => jsonNumberToMinor(0.1 + 0.2, "BRL")).toThrow(/casas decimais/);
    expect(jsonNumberToMinor(1234.56, "BRL")).toBe(123456n);
    expect(formatMinorAsDecimal(-505n, "BRL")).toBe("-5.05");
    expect(parseDecimalToMinor("1500", "CLP")).toBe(1500n);
  });
  it("rejeita casas decimais excedentes em vez de arredondar", () => {
    expect(() => parseDecimalToMinor("10.001", "BRL")).toThrow(/casas decimais/);
    expect(() => jsonNumberToMinor(Number.NaN, "BRL")).toThrow();
    expect(() => jsonNumberToMinor(1e21, "BRL")).toThrow();
  });
  it("T49 soma separada por moeda e conversão com taxa identificada", () => {
    const sums = sumByCurrency([
      { amountMinor: 1000n, currency: "BRL" },
      { amountMinor: 500n, currency: "USD" },
      { amountMinor: 250n, currency: "BRL" },
    ]);
    expect(Object.fromEntries(sums)).toEqual({ BRL: 1250n, USD: 500n });
    const { converted, rate } = convertMoney({ amountMinor: 1000n, currency: "USD" }, { from: "USD", to: "BRL", rate: "5.4321", asOfDate: "2026-09-20", source: "manual:teste" });
    expect(converted).toEqual({ amountMinor: 5432n, currency: "BRL" });
    expect(rate.source).toBe("manual:teste");
  });
});

describe("tempo e fuso", () => {
  it("T47 período local America/Sao_Paulo vira intervalo UTC [início, fim)", () => {
    const r = localDateRangeToUtc("2026-09-01", "2026-09-30", "America/Sao_Paulo");
    expect(r.start.toISOString()).toBe("2026-09-01T03:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-10-01T03:00:00.000Z");
    expect(previousLocalPeriod("2026-09-01", "2026-09-30")).toEqual({ from: "2026-08-02", to: "2026-08-31" });
  });
  it("T48 conta em outro fuso: mesmo dia local cobre outro intervalo UTC", () => {
    const sp = localDateRangeToUtc("2026-09-20", "2026-09-20", "America/Sao_Paulo");
    const ny = localDateRangeToUtc("2026-09-20", "2026-09-20", "America/New_York");
    expect(ny.start.getTime() - sp.start.getTime()).toBe(3_600_000);
  });
  it("interpreta horário sem fuso com o fuso configurado", () => {
    expect(parseWallTimeInZone("2026-03-10 14:30:00", "America/Sao_Paulo").toISOString()).toBe("2026-03-10T17:30:00.000Z");
    expect(() => parseWallTimeInZone("2026-02-30 10:00:00", "America/Sao_Paulo")).toThrow();
  });
});

describe("UTMs e links", () => {
  it("preserva fragmento, parâmetros existentes, Unicode e protege afiliação", () => {
    const r = buildTrackedUrl({
      baseUrl: "https://pay.exemplo.com/checkout/ABC123?aff=XyZ9&cupom=PROMO#resumo",
      params: { utm_source: "facebook", utm_campaign: "Lançamento Ágil", aff: "outro" },
    });
    expect(r.url).toBe("https://pay.exemplo.com/checkout/ABC123?aff=XyZ9&cupom=PROMO&utm_source=facebook&utm_campaign=Lan%C3%A7amento%20%C3%81gil#resumo");
    expect(r.issues.some((i) => i.code === "protected_param_kept" && i.param === "aff")).toBe(true);
    expect(r.url!.split("?")).toHaveLength(2);
  });
  it("mantém macros legíveis para expansão pela rede", () => {
    const r = buildTrackedUrl({ baseUrl: "https://lp.exemplo.com/", params: { utm_campaign: "{{campaign.name}}|{{campaign.id}}" } });
    expect(r.url).toBe("https://lp.exemplo.com/?utm_campaign={{campaign.name}}%7C{{campaign.id}}");
    expect(r.issues.some((i) => i.code === "unexpanded_macro" && i.severity === "warning")).toBe(true);
  });
  it("T38 macros não expandidas e encoding são detectados; placeholder não é ID", () => {
    expect(findUnexpandedMacros("camp|{{campaign.id}}")).toEqual(["{{campaign.id}}"]);
    expect(findUnexpandedMacros("__CAMPAIGN_ID__")).toEqual(["__CAMPAIGN_ID__"]);
    expect(findUnexpandedMacros("x%7B%7Bad.id%7D%7D")).toContain("(macro codificada)");
    const { issues } = readUtms("https://lp.exemplo.com/?utm_campaign=%7B%7Bcampaign.name%7D%7D&utm_source=fb");
    expect(issues.some((i) => i.code === "unexpanded_macro")).toBe(true);
    expect(parseNameIdPair("Campanha|{{campaign.id}}").id).toBeNull();
    expect(parseNameIdPair("Black Friday|120210000000001")).toEqual({ name: "Black Friday", id: "120210000000001" });
  });
  it("sanitiza URL coletada sem guardar parâmetros sensíveis", () => {
    const s = sanitizeUrl("https://lp.exemplo.com/obrigado/joao@x.com?utm_source=fb&email=joao%40x.com&token=abc&fbclid=IwAR1#x");
    expect(s).not.toBeNull();
    expect(s!.params).toEqual({ utm_source: "fb", fbclid: "IwAR1" });
    expect(s!.path).toBe("/obrigado/:redacted");
    expect(s!.droppedParamNames).toEqual(["email", "token"]);
  });
});

describe("permissões e mascaramento", () => {
  it("analista não executa mídia; proprietário acessa cobrança; admin não", () => {
    expect(roleHas("analyst", "media.execute")).toBe(false);
    expect(roleHas("owner", "billing.access")).toBe(true);
    expect(roleHas("admin", "billing.access")).toBe(false);
    expect(maskEmail("maria@exemplo.com")).toBe("m***@e***.com");
  });
});
