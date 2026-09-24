/**
 * Tempo: armazenamento em UTC, apresentação/agrupamento no fuso da organização (R02-03, R07-10).
 * Intervalos sempre fechados no início e abertos no fim: [start, end).
 */

export const DEFAULT_TIMEZONE = "America/Sao_Paulo";

export interface UtcRange {
  /** Inclusivo. */
  readonly start: Date;
  /** Exclusivo. */
  readonly end: Date;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function toZonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset (ms) do fuso no instante informado: local = utc + offset. */
export function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const p = toZonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = Math.floor(instant.getTime() / 1000) * 1000;
  return asUtc - truncated;
}

/**
 * Converte um horário de parede (sem fuso) em um instante UTC, dado o fuso.
 * Em lacunas/sobreposições de horário de verão escolhe a interpretação mais próxima do offset anterior.
 */
export function zonedWallTimeToUtc(parts: ZonedParts, timeZone: string): Date {
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let offset = timeZoneOffsetMs(new Date(guess), timeZone);
  let result = guess - offset;
  const offset2 = timeZoneOffsetMs(new Date(result), timeZone);
  if (offset2 !== offset) {
    offset = offset2;
    result = guess - offset;
  }
  return new Date(result);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseLocalDate(date: string): { year: number; month: number; day: number } {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Data inválida (esperado YYYY-MM-DD): ${date}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new Error(`Data inexistente: ${date}`);
  }
  return { year, month, day };
}

function addDaysToLocal(date: { year: number; month: number; day: number }, days: number) {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Intervalo UTC [início do dia `from`, início do dia seguinte a `toInclusive`) no fuso informado.
 */
export function localDateRangeToUtc(fromDate: string, toDateInclusive: string, timeZone: string): UtcRange {
  const from = parseLocalDate(fromDate);
  const to = parseLocalDate(toDateInclusive);
  const endDay = addDaysToLocal(to, 1);
  const start = zonedWallTimeToUtc({ ...from, hour: 0, minute: 0, second: 0 }, timeZone);
  const end = zonedWallTimeToUtc({ ...endDay, hour: 0, minute: 0, second: 0 }, timeZone);
  if (end.getTime() <= start.getTime()) throw new Error("Intervalo vazio ou invertido");
  return { start, end };
}

/** Período anterior de mesma duração em dias locais (para comparação). */
export function previousLocalPeriod(fromDate: string, toDateInclusive: string): { from: string; to: string } {
  const from = parseLocalDate(fromDate);
  const to = parseLocalDate(toDateInclusive);
  const days =
    Math.round(
      (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) / 86_400_000,
    ) + 1;
  const prevTo = addDaysToLocal(from, -1);
  const prevFrom = addDaysToLocal(from, -days);
  const fmt = (d: { year: number; month: number; day: number }) =>
    `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
  return { from: fmt(prevFrom), to: fmt(prevTo) };
}

export function localDateOf(instant: Date, timeZone: string): string {
  const p = toZonedParts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function inRange(instant: Date, range: UtcRange): boolean {
  const t = instant.getTime();
  return t >= range.start.getTime() && t < range.end.getTime();
}

const WALL_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;

/**
 * Interpreta um horário sem fuso ("Y-m-d H:i:s") usando um fuso declarado pela configuração da conexão.
 * O fuso usado deve ser registrado como hipótese quando o provedor não o documenta.
 */
export function parseWallTimeInZone(text: string, timeZone: string): Date {
  const m = WALL_TIME_RE.exec(text.trim());
  if (!m) throw new Error(`Horário inválido (esperado Y-m-d H:i:s): ${text}`);
  const parts: ZonedParts = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6]),
  };
  parseLocalDate(`${m[1]}-${m[2]}-${m[3]}`);
  if (parts.hour > 23 || parts.minute > 59 || parts.second > 59) throw new Error(`Horário inválido: ${text}`);
  return zonedWallTimeToUtc(parts, timeZone);
}
