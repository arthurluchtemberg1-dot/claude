"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, getOrgId } from "./api";

/**
 * Feed de notificações do painel (R34-01, R34-03):
 * - consulta periódica só com a aba visível (sem carregar a lista inteira a cada vez: `since`);
 * - som de venda opcional, apenas para notificações criadas DEPOIS da abertura do painel e uma única vez entre abas
 *   (marca compartilhada no navegador) — recarregar a página nunca toca vendas antigas;
 * - o som é sintetizado no navegador (sem arquivos de terceiros) e respeita volume/mudo das preferências.
 */

export interface NotificationItem {
  id: string;
  kind: string;
  label: string;
  severity: "info" | "success" | "warning" | "critical";
  title: string;
  body: string;
  link: string | null;
  is_test: boolean;
  created_at: string;
  read_at: string | null;
  sound: boolean;
}

interface FeedResponse {
  server_time: string;
  unread_count: number;
  notifications: NotificationItem[];
}

const POLL_MS = 15_000;
const playedKey = () => `trk_ntf_played:${getOrgId() ?? "-"}`;

function readPlayed(): string {
  try {
    return localStorage.getItem(playedKey()) ?? "";
  } catch {
    return "";
  }
}
function writePlayed(v: string) {
  try {
    localStorage.setItem(playedKey(), v);
  } catch {
    /* ignorar */
  }
}

let audioCtx: AudioContext | null = null;
/** Navegadores só liberam áudio após interação: chamado em cliques (ex.: botão de teste, sino). */
export function unlockAudio() {
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === "suspended") void audioCtx.resume();
  } catch {
    /* sem áudio */
  }
}

/** Toque curto de duas notas (original). Retorna false se o navegador bloqueou o áudio. */
export function playSaleSound(volume: number): boolean {
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === "suspended") return false;
    const v = Math.max(0, Math.min(1, volume / 100)) * 0.35;
    const t0 = audioCtx.currentTime;
    for (const [freq, at] of [
      [880, 0],
      [1318.5, 0.11],
    ] as const) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, v), t0 + at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.45);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.5);
    }
    return true;
  } catch {
    return false;
  }
}

const CHANGED = "trk:notifications-changed";
/** Avisa o sino (e outras partes da página) que o estado das notificações mudou fora dele. */
export function notifyNotificationsChanged() {
  window.dispatchEvent(new Event(CHANGED));
}

export function useNotificationFeed(opts: { soundEnabled: boolean; soundVolume: number }) {
  const [unread, setUnread] = useState(0);
  const [latest, setLatest] = useState<NotificationItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const cursor = useRef<string | null>(null);
  const seen = useRef(new Set<string>());
  const soundRef = useRef(opts);
  soundRef.current = opts;

  const poll = useCallback(async () => {
    try {
      const first = cursor.current === null;
      // Janela sobreposta de 2 min (commits podem chegar fora de ordem); repetidos são descartados por ID.
      const since = first ? null : new Date(new Date(cursor.current!).getTime() - 120_000).toISOString();
      const r = await api<FeedResponse>(first ? "/v1/notifications?limit=10" : `/v1/notifications?limit=50&since=${encodeURIComponent(since!)}`);
      setUnread(r.unread_count);
      setError(null);
      if (first) {
        setLatest(r.notifications);
        for (const n of r.notifications) seen.current.add(n.id);
        // Linha de base: nada que já existia ao abrir o painel toca som.
        cursor.current = r.server_time;
        if (readPlayed() < r.server_time) writePlayed(r.server_time);
        return;
      }
      cursor.current = r.server_time;
      const fresh = r.notifications.filter((n) => !seen.current.has(n.id));
      if (!fresh.length) return;
      for (const n of fresh) seen.current.add(n.id);
      setLatest((prev) => [...fresh, ...prev].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 10));
      const s = soundRef.current;
      const audible = fresh.filter((n) => n.sound && !n.read_at && n.created_at > readPlayed());
      if (audible.length && s.soundEnabled) {
        // Marca antes de tocar: outra aba que consultar em seguida não repete o som.
        writePlayed(audible.map((n) => n.created_at).sort().at(-1)!);
        playSaleSound(s.soundVolume);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void poll();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void poll();
    }, POLL_MS);
    const onVis = () => document.visibilityState === "visible" && void poll();
    const onChanged = () => void poll();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener(CHANGED, onChanged);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener(CHANGED, onChanged);
    };
  }, [poll]);

  const markRead = useCallback(async (ids: string[] | "all") => {
    await api("/v1/notifications/read", { method: "POST", body: ids === "all" ? { all: true } : { ids } });
    setLatest((prev) => prev.map((n) => (ids === "all" || ids.includes(n.id) ? { ...n, read_at: n.read_at ?? new Date().toISOString() } : n)));
    setUnread((u) => (ids === "all" ? 0 : Math.max(0, u - ids.length)));
  }, []);

  return { unread, latest, error, refresh: poll, markRead };
}

// ------------------------------------------------------------------ Web Push neste dispositivo

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && window.isSecureContext;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator) || !window.isSecureContext) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    return null;
  }
}

function keyToBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const subKey = () => `trk_push_sub:${getOrgId() ?? "-"}`;

export async function currentPushState(): Promise<"unsupported" | "denied" | "subscribed" | "not_subscribed"> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager.getSubscription();
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(subKey());
  } catch {
    /* ignorar */
  }
  return sub && stored ? "subscribed" : "not_subscribed";
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Navegador";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return `${browser}${os ? ` · ${os}` : ""}`;
}

/** Pede permissão (só após clique do usuário), inscreve no serviço de push do navegador e registra na API. */
export async function enablePush(publicKey: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!pushSupported()) return { ok: false, reason: "Este navegador não oferece Web Push (ou a página não está em HTTPS)." };
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return { ok: false, reason: "Permissão de notificações negada no navegador." };
  const reg = (await registerServiceWorker()) ?? (await navigator.serviceWorker.ready);
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) }));
  const json = sub.toJSON();
  try {
    const r = await api<{ id: string }>("/v1/notifications/push/subscriptions", { method: "POST", body: { endpoint: json.endpoint, keys: json.keys, label: deviceLabel() } });
    try {
      localStorage.setItem(subKey(), r.id);
    } catch {
      /* ignorar */
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

export async function disablePush(): Promise<void> {
  let id: string | null = null;
  try {
    id = localStorage.getItem(subKey());
    localStorage.removeItem(subKey());
  } catch {
    /* ignorar */
  }
  if (id) await api(`/v1/notifications/push/subscriptions/${id}`, { method: "DELETE" }).catch(() => undefined);
  const reg = await navigator.serviceWorker?.getRegistration("/");
  const sub = await reg?.pushManager.getSubscription();
  await sub?.unsubscribe().catch(() => undefined);
}
