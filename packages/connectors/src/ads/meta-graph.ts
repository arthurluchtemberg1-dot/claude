import { createHmac } from "node:crypto";

/**
 * Cliente mínimo da Graph API (Marketing API) da Meta.
 *
 * Formatos verificados nos SDKs oficiais (sem chamadas reais neste ambiente):
 * - facebook-nodejs-business-sdk 24.0.1 (npm): src/api.js (GRAPH = https://graph.facebook.com, access_token na query,
 *   corpo JSON em POST), src/cursor.js (paginação por `paging.next` = URL completa), src/abstract-crud-object.js
 *   (atualização = POST no nó), src/objects/{user,ad-account,campaign,ad-set,ad,ads-insights,ads-pixel}.js (campos e
 *   arestas /me/adaccounts, /me/permissions, /act_{id}/campaigns|adsets|ads|insights|adspixels|promote_pages,
 *   /{id}/copies).
 * - facebook_business 26.0.2 (PyPI, Graph v26.0): param_types de get_insights (level, time_increment, time_range,
 *   fields, limit), create_copy (deep_copy, status_option, rename_options, campaign_id/adset_id), api_update
 *   (status, daily_budget, lifetime_budget, name), session.py (appsecret_proof = HMAC-SHA256(app_secret, token)),
 *   exceptions.py (error.code, error_subcode, type, is_transient).
 * Consultado em 2026-10-25. Versão padrão da API: v26.0 (configurável por META_GRAPH_API_VERSION).
 */

export const META_GRAPH_DEFAULT_VERSION = "v26.0";

export interface MetaGraphOptions {
  accessToken: string;
  version?: string;
  /** Só para testes/servidor falso; produção usa https://graph.facebook.com. */
  baseUrl?: string;
  appSecret?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type MetaErrorKind = "auth" | "permission" | "rate_limit" | "transient" | "invalid" | "not_found" | "network" | "unknown_outcome";

export class MetaGraphError extends Error {
  constructor(
    message: string,
    readonly kind: MetaErrorKind,
    readonly code: number | null,
    readonly subcode: number | null,
    readonly httpStatus: number | null,
    readonly fbtraceId: string | null = null,
  ) {
    super(message);
  }
  get retryable() {
    return this.kind === "rate_limit" || this.kind === "transient" || this.kind === "network";
  }
}

// Códigos documentados na Graph API para limitação de taxa (4, 17, 32, 613) e limites de uso de anúncios (80000–80014).
const RATE_CODES = new Set([4, 17, 32, 613]);

function classify(code: number | null, httpStatus: number, transient: boolean): MetaErrorKind {
  if (code === 190 || code === 102 || httpStatus === 401) return "auth";
  if (code !== null && (RATE_CODES.has(code) || (code >= 80000 && code <= 80014))) return "rate_limit";
  if (code === 10 || code === 200 || (code !== null && code > 200 && code < 300) || httpStatus === 403) return "permission";
  if (code === 803 || httpStatus === 404) return "not_found";
  if (transient || code === 1 || code === 2 || httpStatus >= 500) return "transient";
  return "invalid";
}

function friendly(kind: MetaErrorKind, msg: string): string {
  switch (kind) {
    case "auth":
      return `Token da Meta inválido ou expirado: ${msg}`;
    case "permission":
      return `Permissão insuficiente na Meta: ${msg}`;
    case "rate_limit":
      return `Limite de chamadas da Meta atingido; nova tentativa automática: ${msg}`;
    default:
      return msg;
  }
}

export interface MetaPage<T> {
  data: T[];
  paging?: { next?: string; cursors?: { after?: string } };
}

export interface MetaAdAccount {
  id: string; // "act_123"
  account_id?: string;
  name?: string;
  currency?: string;
  timezone_name?: string;
  account_status?: number;
  amount_spent?: string;
  spend_cap?: string;
  balance?: string;
  is_prepay_account?: boolean;
  min_daily_budget?: number;
  business?: { id: string; name?: string };
  disable_reason?: number;
}

export const META_ACCOUNT_FIELDS = "id,account_id,name,currency,timezone_name,account_status,amount_spent,spend_cap,balance,is_prepay_account,min_daily_budget,business,disable_reason";

export interface MetaEntity {
  id: string;
  name?: string;
  status?: string;
  effective_status?: string;
  configured_status?: string;
  objective?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  budget_remaining?: string;
  campaign_id?: string;
  adset_id?: string;
  created_time?: string;
  updated_time?: string;
  learning_stage_info?: { status?: string; conversions?: number; last_sig_edit_ts?: number };
}

export const META_ENTITY_FIELDS: Record<"campaign" | "adset" | "ad", string> = {
  campaign: "id,name,status,effective_status,configured_status,objective,daily_budget,lifetime_budget,budget_remaining,created_time,updated_time",
  adset: "id,name,status,effective_status,configured_status,campaign_id,daily_budget,lifetime_budget,budget_remaining,created_time,updated_time,learning_stage_info",
  ad: "id,name,status,effective_status,configured_status,campaign_id,adset_id,created_time,updated_time",
};

export const META_INSIGHT_FIELDS = "account_currency,account_id,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,inline_link_clicks,reach,actions,action_values,date_start,date_stop";

export interface MetaInsight {
  account_currency?: string;
  account_id?: string;
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  ad_id?: string;
  ad_name?: string;
  spend?: string;
  impressions?: string;
  inline_link_clicks?: string;
  reach?: string;
  actions?: { action_type: string; value: string }[];
  action_values?: { action_type: string; value: string }[];
  date_start?: string;
  date_stop?: string;
}

export interface MetaGraphClient {
  version: string;
  me(): Promise<{ id: string; name?: string }>;
  permissions(): Promise<{ permission: string; status: string }[]>;
  adAccounts(): Promise<MetaAdAccount[]>;
  adAccount(actId: string): Promise<MetaAdAccount>;
  entities(actId: string, level: "campaign" | "adset" | "ad"): Promise<MetaEntity[]>;
  entity(id: string, level: "campaign" | "adset" | "ad"): Promise<MetaEntity>;
  insights(actId: string, level: "campaign" | "adset" | "ad", since: string, until: string): Promise<MetaInsight[]>;
  pixels(actId: string): Promise<{ id: string; name?: string; last_fired_time?: string; is_unavailable?: boolean }[]>;
  pages(actId: string): Promise<{ id: string; name?: string }[]>;
  update(id: string, params: Record<string, string | number>): Promise<{ success?: boolean }>;
  copy(id: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function createMetaGraphClient(opts: MetaGraphOptions): MetaGraphClient {
  const version = opts.version ?? META_GRAPH_DEFAULT_VERSION;
  const base = (opts.baseUrl ?? "https://graph.facebook.com").replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const proof = opts.appSecret ? createHmac("sha256", opts.appSecret).update(opts.accessToken).digest("hex") : null;
  const auth = (u: URL) => {
    u.searchParams.set("access_token", opts.accessToken);
    if (proof) u.searchParams.set("appsecret_proof", proof);
    return u;
  };
  const url = (path: string, params: Record<string, string | number | undefined> = {}) => {
    const u = new URL(`${base}/${version}/${path.replace(/^\//, "")}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, String(v));
    return auth(u);
  };

  async function request<T>(method: "GET" | "POST", u: URL, body?: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(u, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch (err) {
      // Escrita sem resposta: o efeito pode ter ocorrido — quem chamou reconcilia antes de repetir (R25-11).
      const msg = (err as Error).name === "TimeoutError" ? "Sem resposta da Meta no tempo limite" : `Falha de rede com a Meta: ${(err as Error).message}`;
      throw new MetaGraphError(msg, method === "POST" ? "unknown_outcome" : "network", null, null, null);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const err = (json as { error?: { message?: string; code?: number; error_subcode?: number; is_transient?: boolean; fbtrace_id?: string; error_user_msg?: string } } | null)?.error;
    if (!res.ok || err) {
      const code = typeof err?.code === "number" ? err.code : null;
      const kind = classify(code, res.status, Boolean(err?.is_transient));
      const message = err?.error_user_msg || err?.message || `HTTP ${res.status}`;
      throw new MetaGraphError(friendly(kind, message).slice(0, 500), kind, code, typeof err?.error_subcode === "number" ? err.error_subcode : null, res.status, err?.fbtrace_id ?? null);
    }
    return json as T;
  }

  /** Percorre todas as páginas (paging.next é URL completa), com teto de segurança. */
  async function all<T>(first: URL, maxPages = 200): Promise<T[]> {
    const out: T[] = [];
    let next: URL | null = first;
    for (let i = 0; next && i < maxPages; i++) {
      const page: MetaPage<T> = await request<MetaPage<T>>("GET", next);
      out.push(...(page.data ?? []));
      const n = page.paging?.next;
      // Só segue paginação no mesmo host da API (a URL vem da resposta).
      next = n && new URL(n).origin === new URL(base).origin ? auth(new URL(n)) : null;
    }
    return out;
  }

  const act = (id: string) => (id.startsWith("act_") ? id : `act_${id}`);

  return {
    version,
    me: () => request("GET", url("me", { fields: "id,name" })),
    permissions: async () => (await request<MetaPage<{ permission: string; status: string }>>("GET", url("me/permissions"))).data ?? [],
    adAccounts: () => all<MetaAdAccount>(url("me/adaccounts", { fields: META_ACCOUNT_FIELDS, limit: 100 })),
    adAccount: (id) => request("GET", url(act(id), { fields: META_ACCOUNT_FIELDS })),
    entities: (id, level) => all<MetaEntity>(url(`${act(id)}/${level === "campaign" ? "campaigns" : level === "adset" ? "adsets" : "ads"}`, { fields: META_ENTITY_FIELDS[level], limit: 200 })),
    entity: (id, level) => request("GET", url(id, { fields: META_ENTITY_FIELDS[level] })),
    insights: (id, level, since, until) =>
      all<MetaInsight>(url(`${act(id)}/insights`, { level, time_increment: 1, time_range: JSON.stringify({ since, until }), fields: META_INSIGHT_FIELDS, limit: 500 })),
    pixels: (id) => all(url(`${act(id)}/adspixels`, { fields: "id,name,last_fired_time,is_unavailable", limit: 100 })),
    pages: (id) => all(url(`${act(id)}/promote_pages`, { fields: "id,name", limit: 100 })),
    update: (id, params) => request("POST", url(id), params),
    copy: (id, params) => request("POST", url(`${id}/copies`), params),
  };
}

/** Compras e valor de compras REPORTADOS pela Meta (nunca somados às vendas confirmadas pelo checkout). */
export function reportedPurchases(row: MetaInsight): { count: string | null; value: string | null } {
  const pick = (list: { action_type: string; value: string }[] | undefined) => {
    if (!list) return null;
    // "purchase" agrega as compras do pixel/CAPI; tipos específicos ficam de fora para não contar duas vezes.
    const p = list.find((a) => a.action_type === "purchase") ?? list.find((a) => a.action_type === "offsite_conversion.fb_pixel_purchase");
    return p ? p.value : null;
  };
  return { count: pick(row.actions), value: pick(row.action_values) };
}
