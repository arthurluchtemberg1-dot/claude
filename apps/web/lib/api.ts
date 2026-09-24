"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Cliente da API (mesma origem via /api → rewrite para a API). O cookie de sessão é httpOnly; a organização
 * selecionada vai no cabeçalho x-org-id e é sempre revalidada no servidor (R40-01).
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const ORG_KEY = "trk_org";

export function getOrgId(): string | null {
  try {
    return window.localStorage.getItem(ORG_KEY);
  } catch {
    return null;
  }
}

/** Troca de organização limpa cache e seleções anteriores (R06-13). */
export function setOrgId(id: string | null) {
  try {
    if (id) window.localStorage.setItem(ORG_KEY, id);
    else window.localStorage.removeItem(ORG_KEY);
    for (const k of Object.keys(window.localStorage)) if (k.startsWith("trk_view:")) window.localStorage.removeItem(k);
  } catch {
    /* ignorar */
  }
  cache.clear();
}

const cache = new Map<string, unknown>();

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; raw?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const org = getOrgId();
  if (org) headers["x-org-id"] = org;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (init.raw) return res as unknown as T;
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string; request_id?: string; details?: unknown } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? "http_error", e?.message ?? `Erro HTTP ${res.status}`, e?.request_id, e?.details);
  }
  return json as T;
}

export function useApi<T>(path: string | null) {
  const key = path ? `${getOrgId() ?? "-"}|${path}` : null;
  const [data, setData] = useState<T | null>(() => (key && cache.has(key) ? (cache.get(key) as T) : null));
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState<boolean>(!!path);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!path || !key) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const d = await api<T>(path);
      if (my !== seq.current) return;
      cache.set(key, d);
      setData(d);
      setError(null);
    } catch (e) {
      if (my !== seq.current) return;
      setError(e instanceof ApiError ? e : new ApiError(0, "network", "Falha de rede. Verifique sua conexão."));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [path, key]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, error, loading, reload: load };
}
