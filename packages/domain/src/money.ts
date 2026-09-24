/**
 * Dinheiro exato: inteiros (bigint) na menor unidade monetária + código ISO 4217.
 * Nunca usar ponto flutuante binário para valores monetários (R07-04).
 */

/** Casas decimais (minor units) conforme ISO 4217 para as moedas suportadas. */
const CURRENCY_EXPONENT: Record<string, number> = {
  BRL: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  ARS: 2,
  MXN: 2,
  COP: 2,
  PEN: 2,
  UYU: 2,
  PYG: 0,
  CLP: 0,
  JPY: 0,
  CAD: 2,
  AUD: 2,
  CHF: 2,
};

export type CurrencyCode = string;

export interface Money {
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
}

export class MoneyError extends Error {
  constructor(
    message: string,
    readonly code:
      | "unsupported_currency"
      | "invalid_amount"
      | "too_many_decimals"
      | "currency_mismatch"
      | "negative_not_allowed",
  ) {
    super(message);
    this.name = "MoneyError";
  }
}

export function isSupportedCurrency(currency: string): boolean {
  return Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENT, currency);
}

export function currencyExponent(currency: string): number {
  const exp = CURRENCY_EXPONENT[currency];
  if (exp === undefined) {
    throw new MoneyError(`Moeda não suportada: ${currency}`, "unsupported_currency");
  }
  return exp;
}

export function money(amountMinor: bigint | number, currency: CurrencyCode): Money {
  currencyExponent(currency);
  const v = typeof amountMinor === "number" ? BigInt(amountMinor) : amountMinor;
  return { amountMinor: v, currency };
}

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

/**
 * Converte uma representação decimal textual ("199.90", "1799", "0.5") para a menor unidade,
 * sem arredondamento: se houver mais casas decimais significativas que o expoente da moeda,
 * lança `too_many_decimals` em vez de adivinhar.
 */
export function parseDecimalToMinor(input: string, currency: CurrencyCode): bigint {
  const exp = currencyExponent(currency);
  const trimmed = input.trim();
  const m = DECIMAL_RE.exec(trimmed);
  if (!m) throw new MoneyError(`Valor monetário inválido: "${input}"`, "invalid_amount");
  const [, sign, intPart = "0", fracRaw = ""] = m;
  const frac = fracRaw.replace(/0+$/, "");
  if (frac.length > exp) {
    throw new MoneyError(
      `Valor "${input}" tem mais casas decimais que ${currency} permite (${exp})`,
      "too_many_decimals",
    );
  }
  const fracPadded = frac.padEnd(exp, "0");
  const minor = BigInt(intPart + fracPadded);
  return sign ? -minor : minor;
}

/**
 * Converte um número JSON (já desserializado) para a menor unidade.
 * Usa a representação decimal mais curta que reproduz o double (Number#toString),
 * que coincide com o literal JSON original para literais com até 15 dígitos significativos.
 * Rejeita NaN, infinitos, notação científica e excesso de casas decimais.
 */
export function jsonNumberToMinor(value: number, currency: CurrencyCode): bigint {
  if (!Number.isFinite(value)) throw new MoneyError("Valor não finito", "invalid_amount");
  const text = value.toString();
  if (/e/i.test(text)) throw new MoneyError(`Notação científica não aceita: ${text}`, "invalid_amount");
  if (Math.abs(value) > 1e13) throw new MoneyError("Valor fora do intervalo seguro", "invalid_amount");
  return parseDecimalToMinor(text, currency);
}

export function formatMinorAsDecimal(amountMinor: bigint, currency: CurrencyCode): string {
  const exp = currencyExponent(currency);
  const neg = amountMinor < 0n;
  const abs = neg ? -amountMinor : amountMinor;
  const s = abs.toString().padStart(exp + 1, "0");
  const intPart = exp === 0 ? s : s.slice(0, s.length - exp);
  const frac = exp === 0 ? "" : s.slice(s.length - exp);
  return `${neg ? "-" : ""}${intPart}${exp ? "." + frac : ""}`;
}

/** Formatação para exibição (pt-BR por padrão). Arredondamento só na apresentação. */
export function formatMoney(m: Money, locale = "pt-BR"): string {
  const decimal = formatMinorAsDecimal(m.amountMinor, m.currency);
  // Intl aceita string decimal exata em Node 22 (sem perda de precisão).
  return new Intl.NumberFormat(locale, { style: "currency", currency: m.currency }).format(
    decimal as unknown as number,
  );
}

function assertSame(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`Moedas diferentes: ${a.currency} e ${b.currency}`, "currency_mismatch");
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSame(a, b);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function subMoney(a: Money, b: Money): Money {
  assertSame(a, b);
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency };
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * Soma valores agrupando por moeda. Nunca soma moedas diferentes (R22-10, T49).
 */
export function sumByCurrency(values: readonly Money[]): Map<CurrencyCode, bigint> {
  const out = new Map<CurrencyCode, bigint>();
  for (const v of values) out.set(v.currency, (out.get(v.currency) ?? 0n) + v.amountMinor);
  return out;
}

export interface ExchangeRate {
  readonly from: CurrencyCode;
  readonly to: CurrencyCode;
  /** Taxa como decimal textual exato (ex.: "5.4321"). */
  readonly rate: string;
  /** Data de referência da taxa (YYYY-MM-DD). */
  readonly asOfDate: string;
  /** Fonte identificada (ex.: "manual:usuario@x", "bcb-ptax"). */
  readonly source: string;
}

/**
 * Converte usando taxa identificada e datada. Arredondamento half-even na menor unidade de destino.
 * Retorna também a taxa usada para rastreabilidade.
 */
export function convertMoney(m: Money, rate: ExchangeRate): { converted: Money; rate: ExchangeRate } {
  if (rate.from !== m.currency) {
    throw new MoneyError(`Taxa ${rate.from}->${rate.to} não se aplica a ${m.currency}`, "currency_mismatch");
  }
  const rm = DECIMAL_RE.exec(rate.rate.trim());
  if (!rm || rm[1]) throw new MoneyError(`Taxa inválida: ${rate.rate}`, "invalid_amount");
  const rateInt = BigInt((rm[2] ?? "0") + (rm[3] ?? ""));
  const rateScale = BigInt(10) ** BigInt((rm[3] ?? "").length);
  const fromExp = currencyExponent(m.currency);
  const toExp = currencyExponent(rate.to);
  // valor_destino_minor = amountMinor * rate * 10^(toExp - fromExp)
  let num = m.amountMinor * rateInt;
  let den = rateScale;
  const diff = toExp - fromExp;
  if (diff > 0) num *= 10n ** BigInt(diff);
  else if (diff < 0) den *= 10n ** BigInt(-diff);
  return { converted: { amountMinor: divRoundHalfEven(num, den), currency: rate.to }, rate };
}

export function divRoundHalfEven(num: bigint, den: bigint): bigint {
  if (den === 0n) throw new MoneyError("Divisão por zero", "invalid_amount");
  const neg = num < 0n !== den < 0n;
  const n = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  const q = n / d;
  const r = n % d;
  let res = q;
  if (r * 2n > d || (r * 2n === d && q % 2n === 1n)) res = q + 1n;
  return neg ? -res : res;
}
