import { CLICK_ID_KEYS, type ClickIdKey } from "../attribution/classify";
import { UTM_KEYS } from "../utm/builder";

/**
 * Sanitização de URLs coletadas (R13-21, R13-22): guarda origem + caminho + parâmetros permitidos.
 * Nunca guarda query string completa (pode conter e-mail, senha, tokens de autenticação).
 */

export const DEFAULT_ALLOWED_QUERY_PARAMS: readonly string[] = [
  ...UTM_KEYS,
  ...CLICK_ID_KEYS,
  "trk", // token opaco do próprio rastreador
  "src",
  "sck",
];

const SENSITIVE_PARAM_RE = /(pass|senha|token|secret|auth|session|email|e-mail|mail|phone|telefone|cpf|cnpj|document|card|cvv|code|key)/i;

export interface SanitizedUrl {
  readonly origin: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  /** Parâmetros descartados (somente nomes, nunca valores). */
  readonly droppedParamNames: readonly string[];
}

export function sanitizeUrl(input: string, allowed: readonly string[] = DEFAULT_ALLOWED_QUERY_PARAMS): SanitizedUrl | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const allowedSet = new Set(allowed.map((a) => a.toLowerCase()));
  const params: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of url.searchParams) {
    const lower = k.toLowerCase();
    if (allowedSet.has(lower) && !(SENSITIVE_PARAM_RE.test(lower) && lower !== "trk")) {
      if (!(lower in params)) params[lower] = v.slice(0, 500);
    } else {
      dropped.push(k.slice(0, 64));
    }
  }
  // Caminho: remove segmentos que parecem e-mail/tokens longos.
  const path = url.pathname
    .split("/")
    .map((seg) => (/@/.test(safeDecode(seg)) || /^[A-Za-z0-9_-]{40,}$/.test(seg) ? ":redacted" : seg))
    .join("/")
    .slice(0, 512);
  return { origin: url.origin, path, params, droppedParamNames: [...new Set(dropped)] };
}

export function sanitizedToString(s: SanitizedUrl): string {
  const q = new URLSearchParams(s.params).toString();
  return `${s.origin}${s.path}${q ? "?" + q : ""}`;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function extractClickIds(params: Readonly<Record<string, string>>): Partial<Record<ClickIdKey, string>> {
  const out: Partial<Record<ClickIdKey, string>> = {};
  for (const k of CLICK_ID_KEYS) {
    const v = params[k];
    if (v && v.length <= 500 && !/\s/.test(v)) out[k] = v;
  }
  return out;
}

/** Host de referência sem caminho/consulta (minimização). */
export function referrerHost(referrer: string | null | undefined): string | null {
  if (!referrer) return null;
  try {
    return new URL(referrer).hostname.toLowerCase();
  } catch {
    return null;
  }
}
