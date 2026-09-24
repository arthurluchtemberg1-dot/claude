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
