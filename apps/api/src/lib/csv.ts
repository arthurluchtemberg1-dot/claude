/**
 * CSV: parser RFC 4180 (aspas, vírgula/ponto e vírgula, quebras em campos) e escrita com neutralização de
 * fórmulas (CSV injection, R32-10, T66).
 */

export function detectDelimiter(firstLine: string): "," | ";" | "\t" {
  const counts = { ",": 0, ";": 0, "\t": 0 } as Record<string, number>;
  let inQ = false;
  for (const ch of firstLine) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch]!++;
  }
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]![0] as "," | ";" | "\t") ?? ",";
}

export function parseCsv(text: string, maxRows = 50_000): { header: string[]; rows: string[][] } {
  const src = text.replace(/^﻿/, "");
  const firstLineEnd = src.search(/\r?\n/);
  const delim = detectDelimiter(firstLineEnd >= 0 ? src.slice(0, firstLineEnd) : src);
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === delim) {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      record.push(field);
      field = "";
      if (record.some((f) => f !== "")) records.push(record);
      record = [];
      if (records.length > maxRows + 1) throw new Error(`Arquivo excede ${maxRows} linhas`);
    } else field += ch;
  }
  if (field !== "" || record.length) {
    record.push(field);
    if (record.some((f) => f !== "")) records.push(record);
  }
  const [header = [], ...rows] = records;
  return { header: header.map((h) => h.trim()), rows };
}

/** Neutraliza células iniciadas por =, +, -, @, tab ou CR (sem alterar números legítimos). */
export function neutralizeCell(value: string): string {
  if (/^[=+\-@\t\r]/.test(value) && !/^-?\d+([.,]\d+)?$/.test(value)) return `'${value}`;
  return value;
}

export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    if (v === null || v === undefined) return "";
    const s = neutralizeCell(String(v));
    return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\r\n") + "\r\n";
}
