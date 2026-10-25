import webpush from "web-push";
import { safeRequest, type SafeHttpPolicy } from "./safe-http";

/**
 * Web Push (R34-01, R34-04): mensagem cifrada para o navegador do usuário (RFC 8291, aes128gcm) com identificação
 * do servidor por VAPID (RFC 8292). A biblioteca `web-push` só monta o pedido (cifragem + cabeçalhos); o envio passa
 * por `safeRequest` (anti-SSRF, timeout, limite de resposta) — o endpoint vem do navegador e é dado não confiável.
 * Defesa adicional: só hosts de serviços de push conhecidos (ajustável por WEB_PUSH_ALLOWED_HOSTS).
 */

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** "mailto:..." ou URL https do operador (exigido pelos serviços de push para contato). */
  subject: string;
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Sufixos de host dos serviços de push dos navegadores (Chrome/Edge via FCM ou WNS, Firefox, Safari). */
export const DEFAULT_PUSH_HOST_SUFFIXES = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "push.apple.com", "notify.windows.com"] as const;

export function pushEndpointAllowed(endpoint: string, suffixes: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  return suffixes.some((s) => host === s || host.endsWith(`.${s}`));
}

export function vapidFromEnv(env: Record<string, string | undefined>): VapidConfig | null {
  const publicKey = env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.WEB_PUSH_VAPID_PRIVATE_KEY?.trim();
  const subject = env.WEB_PUSH_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  if (!/^(mailto:|https:\/\/)/.test(subject)) throw new Error("WEB_PUSH_SUBJECT deve ser mailto:... ou https://...");
  return { publicKey, privateKey, subject };
}

export function pushHostsFromEnv(env: Record<string, string | undefined>): string[] {
  const extra = (env.WEB_PUSH_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return extra.length ? extra : [...DEFAULT_PUSH_HOST_SUFFIXES];
}

export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}

export interface PushPayload {
  title: string;
  body: string;
  link: string | null;
  kind: string;
  id: string;
  /** Agrupa notificações do mesmo tipo no dispositivo. */
  tag?: string;
}

export type PushResult =
  | { ok: true; status: number }
  /** expired = o serviço informou que a inscrição não existe mais (404/410): desativar sem novas tentativas. */
  | { ok: false; status: number | null; error: string; expired: boolean; retryable: boolean };

export type PushSender = (target: PushTarget, payload: PushPayload) => Promise<PushResult>;

/** Remetente real: cifra, assina (VAPID) e envia com a política anti-SSRF. */
export function createPushSender(vapid: VapidConfig, policy: SafeHttpPolicy, allowedHosts: readonly string[], opts: { ttlSeconds?: number } = {}): PushSender {
  return async (target, payload) => {
    if (!pushEndpointAllowed(target.endpoint, allowedHosts)) {
      return { ok: false, status: null, error: "Endpoint fora dos serviços de push permitidos", expired: true, retryable: false };
    }
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 3000) return { ok: false, status: null, error: "Conteúdo acima do limite de push", expired: false, retryable: false };
    let details: ReturnType<typeof webpush.generateRequestDetails>;
    try {
      details = webpush.generateRequestDetails({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, body, {
        vapidDetails: vapid,
        TTL: opts.ttlSeconds ?? 6 * 3600,
        urgency: "normal",
        contentEncoding: "aes128gcm",
      });
    } catch (err) {
      // Chaves da inscrição inválidas: não adianta repetir.
      return { ok: false, status: null, error: `Inscrição inválida: ${(err as Error).message}`, expired: true, retryable: false };
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(details.headers)) if (k.toLowerCase() !== "content-length") headers[k] = String(v);
    const res = await safeRequest({ url: details.endpoint, method: "POST", headers, body: details.body ?? new Uint8Array() }, policy);
    if (!res.ok) return { ok: false, status: res.status, error: `${res.error}: ${res.message}`, expired: false, retryable: res.error !== "blocked" };
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
    const expired = res.status === 404 || res.status === 410;
    return { ok: false, status: res.status, error: `HTTP ${res.status}`, expired, retryable: !expired && (res.status === 429 || res.status >= 500) };
  };
}
