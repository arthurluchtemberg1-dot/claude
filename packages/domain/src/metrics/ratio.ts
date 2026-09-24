/**
 * Números exatos para métricas: razões como fração de bigints, arredondadas somente na apresentação.
 */
export interface Ratio {
  readonly num: bigint;
  readonly den: bigint;
}

export function ratio(num: bigint, den: bigint): Ratio {
  if (den === 0n) throw new Error("Denominador zero: use MetricResult indefinido");
  if (den < 0n) return { num: -num, den: -den };
  return { num, den };
}

/** Representação decimal com `places` casas (half-even), para API e testes. */
export function ratioToDecimalString(r: Ratio, places = 10): string {
  const scale = 10n ** BigInt(places);
  const neg = r.num < 0n;
  const n = (neg ? -r.num : r.num) * scale;
  const q = n / r.den;
  const rem = n % r.den;
  let rounded = q;
  if (rem * 2n > r.den || (rem * 2n === r.den && q % 2n === 1n)) rounded += 1n;
  const s = rounded.toString().padStart(places + 1, "0");
  const intPart = s.slice(0, s.length - places);
  const frac = places ? s.slice(s.length - places).replace(/0+$/, "") : "";
  return `${neg && rounded !== 0n ? "-" : ""}${intPart}${frac ? "." + frac : ""}`;
}

export function ratioToNumber(r: Ratio): number {
  return Number(ratioToDecimalString(r, 12));
}

export function addRatio(a: Ratio, b: Ratio): Ratio {
  return a.den === b.den ? ratio(a.num + b.num, a.den) : ratio(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function mulRatioBy(r: Ratio, k: bigint): Ratio {
  return ratio(r.num * k, r.den);
}

export function parseRatio(s: string): Ratio {
  const [n, d] = s.split("/");
  return ratio(BigInt(n ?? "0"), BigInt(d ?? "1"));
}

/** Arredonda para inteiro (half-even) — usado apenas na apresentação de valores monetários rateados. */
export function roundRatioHalfEven(r: Ratio): bigint {
  const neg = r.num < 0n;
  const n = neg ? -r.num : r.num;
  const q = n / r.den;
  const rem = n % r.den;
  const out = rem * 2n > r.den || (rem * 2n === r.den && q % 2n === 1n) ? q + 1n : q;
  return neg ? -out : out;
}
