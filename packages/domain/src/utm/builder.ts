import { findUnexpandedMacros } from "./macros";

/**
 * Gerador de URLs com UTMs (seção 14). Garante:
 * - preservação de fragmento, parâmetros existentes, case, acentos e Unicode (R14-04, R14-05);
 * - sem dupla codificação nem dupla interrogação;
 * - nunca sobrescreve parâmetros protegidos de checkout/afiliação/cupom/token (R14-06, R14-07).
 */

export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "utm_id"] as const;
export type UtmKey = (typeof UTM_KEYS)[number];

/** Parâmetros que pertencem ao checkout/afiliação e nunca são sobrescritos pelo gerador. */
export const DEFAULT_PROTECTED_PARAMS = [
  "aff",
  "affiliate",
  "afiliado",
  "ref",
  "coupon",
  "cupom",
  "offer",
  "oferta",
  "src",
  "sck",
  "xcod",
  "token",
  "access_token",
  "signature",
  "sig",
  "hash",
  "checkout",
  "plan",
] as const;

export interface BuildUrlInput {
  readonly baseUrl: string;
  readonly params: Readonly<Record<string, string | null | undefined>>;
  readonly protectedParams?: readonly string[];
  /** Se true, valores de UTMs já presentes na URL são mantidos (padrão: true). */
  readonly keepExistingUtms?: boolean;
}

export interface UrlIssue {
  readonly severity: "error" | "warning";
  readonly code:
    | "invalid_url"
    | "unsupported_scheme"
    | "protected_param_kept"
    | "existing_param_kept"
    | "unexpanded_macro"
    | "double_encoded"
    | "empty_value"
    | "too_long"
    | "control_chars";
  readonly param?: string;
  readonly message: string;
}

export interface BuildUrlResult {
  readonly url: string | null;
  readonly issues: readonly UrlIssue[];
}

const MAX_URL_LENGTH = 2000;
const MAX_VALUE_LENGTH = 500;

export function validateParamValue(key: string, value: string, opts: { allowMacros?: boolean } = {}): UrlIssue[] {
  const issues: UrlIssue[] = [];
  if (value.trim() === "") issues.push({ severity: "warning", code: "empty_value", param: key, message: `${key} vazio` });
  // Caracteres de controle são rejeitados de propósito (regex intencional).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) issues.push({ severity: "error", code: "control_chars", param: key, message: `${key} contém caracteres de controle` });
  if (value.length > MAX_VALUE_LENGTH) issues.push({ severity: "error", code: "too_long", param: key, message: `${key} excede ${MAX_VALUE_LENGTH} caracteres` });
  if (/%25[0-9a-f]{2}/i.test(value) || /%[0-9a-f]{2}/i.test(value)) {
    issues.push({ severity: "warning", code: "double_encoded", param: key, message: `${key} parece já estar codificado; informe o valor sem codificação` });
  }
  if (!opts.allowMacros) {
    const macros = findUnexpandedMacros(value);
    if (macros.length) {
      issues.push({ severity: "error", code: "unexpanded_macro", param: key, message: `${key} contém macro não expandida: ${macros.join(", ")}` });
    }
  }
  return issues;
}

/**
 * Codifica um componente de query preservando macros `{{x}}`, `{x}` e `__X__` legíveis (as redes substituem
 * o texto literal; codificar as chaves impediria a expansão).
 */
function encodeTemplateValue(value: string): string {
  const parts = value.split(/(\{\{[^{}]*\}\}|\{[a-z_][a-z0-9_:.]*\}|__[A-Z][A-Z0-9_]*__)/i);
  return parts
    .map((p, i) => (i % 2 === 1 ? p : encodeURIComponent(p)))
    .join("");
}

/**
 * Monta a URL final. `params` com valor null/undefined são ignorados. Macros são permitidas (template de anúncio),
 * mas geram aviso para uso em links de teste.
 */
export function buildTrackedUrl(input: BuildUrlInput): BuildUrlResult {
  const issues: UrlIssue[] = [];
  let url: URL;
  try {
    url = new URL(input.baseUrl.trim());
  } catch {
    return { url: null, issues: [{ severity: "error", code: "invalid_url", message: "URL de destino inválida" }] };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { url: null, issues: [{ severity: "error", code: "unsupported_scheme", message: "Somente http(s) é aceito" }] };
  }
  const protectedSet = new Set((input.protectedParams ?? DEFAULT_PROTECTED_PARAMS).map((p) => p.toLowerCase()));
  const keepExisting = input.keepExistingUtms ?? true;

  // Parâmetros existentes: preservados exatamente como estão (sem recodificar).
  const rawQuery = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  const existing = rawQuery ? rawQuery.split("&").filter(Boolean) : [];
  const existingKeys = new Set(existing.map((kv) => safeDecode(kv.split("=")[0] ?? "").toLowerCase()));
  const additions: string[] = [];

  for (const [rawKey, value] of Object.entries(input.params)) {
    if (value === null || value === undefined) continue;
    const key = rawKey.trim();
    if (!key) continue;
    const lower = key.toLowerCase();
    if (protectedSet.has(lower) && existingKeys.has(lower)) {
      issues.push({ severity: "warning", code: "protected_param_kept", param: key, message: `Parâmetro protegido "${key}" já existe no destino e foi preservado` });
      continue;
    }
    if (existingKeys.has(lower)) {
      if (keepExisting || protectedSet.has(lower)) {
        issues.push({ severity: "warning", code: "existing_param_kept", param: key, message: `"${key}" já existe no destino; valor original preservado` });
        continue;
      }
      // Remove o existente para substituir.
      for (let i = existing.length - 1; i >= 0; i--) {
        if (safeDecode(existing[i]!.split("=")[0] ?? "").toLowerCase() === lower) existing.splice(i, 1);
      }
    }
    issues.push(...validateParamValue(key, value, { allowMacros: true }).filter((i) => i.code !== "unexpanded_macro"));
    if (findUnexpandedMacros(value).length) {
      issues.push({ severity: "warning", code: "unexpanded_macro", param: key, message: `"${key}" usa macro dinâmica; só será expandida pela rede de anúncios` });
    }
    additions.push(`${encodeURIComponent(key)}=${encodeTemplateValue(value)}`);
  }

  const query = [...existing, ...additions].join("&");
  const base = `${url.protocol}//${url.host}${url.pathname}`;
  const result = `${base}${query ? "?" + query : ""}${url.hash}`;
  if (result.length > MAX_URL_LENGTH) {
    issues.push({ severity: "error", code: "too_long", message: `URL final com ${result.length} caracteres excede ${MAX_URL_LENGTH}` });
  }
  return { url: result, issues };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

/**
 * Lê UTMs de uma URL recebida (landing/checkout), validando macros não expandidas (T38).
 */
export function readUtms(urlString: string): { utms: Partial<Record<UtmKey, string>>; issues: UrlIssue[] } {
  const issues: UrlIssue[] = [];
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { utms: {}, issues: [{ severity: "error", code: "invalid_url", message: "URL inválida" }] };
  }
  const utms: Partial<Record<UtmKey, string>> = {};
  for (const k of UTM_KEYS) {
    const v = url.searchParams.get(k);
    if (v === null) continue;
    utms[k] = v;
    issues.push(...validateParamValue(k, v).filter((i) => i.code !== "double_encoded"));
  }
  return { utms, issues };
}

/**
 * Convenção "nome|id" usada em templates (ex.: utm_campaign={{campaign.name}}|{{campaign.id}}).
 * Retorna o ID somente se for um identificador opaco plausível (sem macro, sem espaços).
 */
export function parseNameIdPair(value: string | null | undefined, separator = "|"): { name: string | null; id: string | null } {
  if (!value) return { name: null, id: null };
  const idx = value.lastIndexOf(separator);
  if (idx < 0) return { name: value, id: null };
  const name = value.slice(0, idx).trim() || null;
  const id = value.slice(idx + separator.length).trim();
  if (!id || findUnexpandedMacros(id).length || /\s/.test(id) || id.length > 64) return { name, id: null };
  return { name, id };
}

const DECLARED_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * IDs de mídia declarados em UTMs no formato "nome|id" (templates do gerador de URLs): campanha em utm_campaign,
 * anúncio em utm_content e conjunto em utm_medium (convenção comum de ferramentas de rastreamento) ou utm_term
 * (preset do gerador). São DECLARATÓRIOS: só comprovam mídia paga após validação contra entidades da própria
 * organização. Tokens do rastreador (trk_…) e macros não expandidas nunca viram ID.
 */
export function declaredIdsFromUtm(utm: { campaign?: string | null; medium?: string | null; content?: string | null; term?: string | null }): {
  campaignId: string | null;
  adsetId: string | null;
  adId: string | null;
  /** utm_medium carrega "nome|id" (não é um canal). */
  mediumIsPair: boolean;
} {
  const idOf = (v: string | null | undefined) => {
    const id = parseNameIdPair(v).id;
    return id && DECLARED_ID_RE.test(id) && !id.startsWith("trk_") ? id : null;
  };
  const mediumId = idOf(utm.medium);
  return { campaignId: idOf(utm.campaign), adsetId: mediumId ?? idOf(utm.term), adId: idOf(utm.content), mediumIsPair: !!mediumId };
}
