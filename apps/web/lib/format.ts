import { formatMinorAsDecimal } from "@tracker/domain";

/** Formatação para apresentação; arredondamento apenas aqui (R22-01). */
export function money(amountMinor: string | number | bigint | null | undefined, currency: string | null | undefined): string {
  if (amountMinor === null || amountMinor === undefined || !currency) return "—";
  try {
    const dec = formatMinorAsDecimal(BigInt(amountMinor), currency.trim());
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: currency.trim() }).format(dec as unknown as number);
  } catch {
    return `${amountMinor} ${currency}`;
  }
}

export function ratio(value: string | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "—";
}

export function dateTime(v: string | Date | null | undefined, timeZone = "America/Sao_Paulo"): string {
  if (!v) return "—";
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", { timeZone, dateStyle: "short", timeStyle: "medium" }).format(d);
}

export function todayIn(timeZone = "America/Sao_Paulo"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const STATUS_LABELS: Record<string, string> = {
  pending: "Pendente",
  failed: "Falhou",
  approved: "Aprovada",
  partially_reversed: "Estorno parcial",
  fully_reversed: "Estornada",
  reversal_pending_reconciliation: "Estorno a conciliar",
};

export const ATTRIBUTION_LABELS: Record<string, string> = {
  paid: "Mídia paga",
  organic: "Orgânico",
  direct: "Direto",
  recovery: "Recuperação",
  unattributed: "Sem atribuição",
};

/** Conversão para número apenas para eixos de gráficos (nunca para cálculos financeiros). */
export function minorToChartNumber(amountMinor: string | number | null | undefined, currency: string): number {
  if (amountMinor === null || amountMinor === undefined) return 0;
  try {
    return Number(formatMinorAsDecimal(BigInt(amountMinor), currency.trim()));
  } catch {
    return 0;
  }
}
