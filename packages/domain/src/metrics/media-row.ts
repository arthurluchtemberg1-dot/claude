import { divRoundHalfEven } from "../money";
import { ratio, ratioToDecimalString, roundRatioHalfEven, type Ratio } from "./ratio";

/**
 * Métricas de uma linha do gerenciador de campanhas (campanha/conjunto/anúncio). Fórmulas só aqui (R05-11):
 * a API apenas soma os agregados brutos e a interface apenas formata.
 * Vendas/faturamento vêm do checkout (atribuídas pela política); compras "reportadas" vêm da Meta e ficam separadas.
 */

export type RowMetric = { status: "ok"; value: string } | { status: "undefined" | "unavailable"; reason: string };

export interface MediaRowInput {
  spendMinor: bigint | null;
  impressions: bigint | null;
  linkClicks: bigint | null;
  ordersCredit: Ratio;
  grossMinor: bigint;
  netMinor: bigint;
  reportedPurchases: Ratio | null;
  reportedValueMinor: bigint | null;
}

const NO_SPEND = "Sem gasto sincronizado no período";
const ok = (value: string): RowMetric => ({ status: "ok", value });
const na = (reason: string): RowMetric => ({ status: "unavailable", reason });
const undef = (reason: string): RowMetric => ({ status: "undefined", reason });

export function mediaRowMetrics(r: MediaRowInput): Record<"profit" | "roas" | "cpa" | "ctr" | "cpc" | "cpm" | "meta_roas" | "meta_cpa", RowMetric> {
  const s = r.spendMinor;
  return {
    // Lucro após mídia = receita atribuída após estornos − gasto (taxas e custos não alocados por campanha).
    profit: s === null ? na(NO_SPEND) : ok((r.netMinor - s).toString()),
    roas: s === null ? na(NO_SPEND) : s === 0n ? undef("Gasto zero") : ok(ratioToDecimalString(ratio(r.grossMinor, s), 2)),
    cpa: s === null ? na(NO_SPEND) : r.ordersCredit.num === 0n ? undef("Sem vendas atribuídas") : ok(roundRatioHalfEven(ratio(s * r.ordersCredit.den, r.ordersCredit.num)).toString()),
    ctr:
      r.impressions === null || r.linkClicks === null ? na("Impressões/cliques não sincronizados") : r.impressions === 0n ? undef("Sem impressões") : ok(ratioToDecimalString(ratio(r.linkClicks * 100n, r.impressions), 2)),
    cpc: s === null || r.linkClicks === null ? na("Gasto/cliques não sincronizados") : r.linkClicks === 0n ? undef("Sem cliques") : ok(divRoundHalfEven(s, r.linkClicks).toString()),
    cpm: s === null || r.impressions === null ? na("Gasto/impressões não sincronizados") : r.impressions === 0n ? undef("Sem impressões") : ok(divRoundHalfEven(s * 1000n, r.impressions).toString()),
    meta_roas:
      s === null || r.reportedValueMinor === null ? na("A Meta não reportou valor de compras") : s === 0n ? undef("Gasto zero") : ok(ratioToDecimalString(ratio(r.reportedValueMinor, s), 2)),
    meta_cpa:
      s === null || r.reportedPurchases === null
        ? na("A Meta não reportou compras")
        : r.reportedPurchases.num === 0n
          ? undef("Sem compras reportadas")
          : ok(roundRatioHalfEven(ratio(s * r.reportedPurchases.den, r.reportedPurchases.num)).toString()),
  };
}
