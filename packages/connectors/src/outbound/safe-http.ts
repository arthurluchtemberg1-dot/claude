import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

/**
 * Cliente HTTP de saída com proteção contra SSRF (R33-06, T67).
 *
 * - Somente http/https (https exigido quando `requireHttps`), sem credenciais na URL.
 * - Endereços privados, loopback, link-local (inclui metadata de nuvem 169.254.169.254), CGNAT, multicast, reservados,
 *   documentação e equivalentes IPv6 (inclusive IPv4 mapeado e NAT64) são bloqueados.
 * - A validação de DNS acontece NO MOMENTO DA CONEXÃO (lookup próprio passado ao socket): o endereço conectado é o
 *   mesmo que foi validado, o que impede DNS rebinding entre validação e uso. Todos os endereços resolvidos precisam
 *   ser permitidos.
 * - Redirecionamentos são revalidados a cada salto (limite configurável); só 307/308 são seguidos (preservam método e
 *   corpo); 301/302/303 contam como falha para não converter POST em GET silenciosamente.
 * - Tempo total e tamanho da resposta limitados.
 */

export type LookupFn = (hostname: string) => Promise<LookupAddress[]>;

export interface SafeHttpPolicy {
  /** Permite destinos em redes privadas/loopback — SOMENTE desenvolvimento e testes. */
  allowPrivateNetworks: boolean;
  /** false quando o envio externo está desabilitado no ambiente (ALLOW_EXTERNAL_DELIVERY=false). */
  allowPublicNetworks: boolean;
  requireHttps: boolean;
  maxRedirects?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Hosts do próprio sistema (entrada de webhooks/painel): proibidos para evitar loops (R33-07). */
  blockedHosts?: readonly string[];
  lookup?: LookupFn;
  /**
   * Exceções exatas "ip:porta" tratadas como permitidas. Uso exclusivo em testes (simular um servidor "público" local
   * sem liberar o restante da rede interna); nunca preenchida a partir de variáveis de ambiente.
   */
  allowEndpoints?: readonly string[];
}

export type AddressVerdict = { allowed: true; kind: "public" | "private_allowed" } | { allowed: false; reason: string };

const RANGES_V4: [string, number, string][] = [
  ["0.0.0.0", 8, "rede 'este host' (0.0.0.0/8)"],
  ["10.0.0.0", 8, "rede privada (10.0.0.0/8)"],
  ["100.64.0.0", 10, "rede compartilhada/CGNAT (100.64.0.0/10)"],
  ["127.0.0.0", 8, "loopback (127.0.0.0/8)"],
  ["169.254.0.0", 16, "link-local/metadata de nuvem (169.254.0.0/16)"],
  ["172.16.0.0", 12, "rede privada (172.16.0.0/12)"],
  ["192.0.0.0", 24, "atribuições de protocolo IETF (192.0.0.0/24)"],
  ["192.0.2.0", 24, "documentação (192.0.2.0/24)"],
  ["192.88.99.0", 24, "relay 6to4 (192.88.99.0/24)"],
  ["192.168.0.0", 16, "rede privada (192.168.0.0/16)"],
  ["198.18.0.0", 15, "benchmark (198.18.0.0/15)"],
  ["198.51.100.0", 24, "documentação (198.51.100.0/24)"],
  ["203.0.113.0", 24, "documentação (203.0.113.0/24)"],
  ["224.0.0.0", 4, "multicast (224.0.0.0/4)"],
  ["240.0.0.0", 4, "reservado (240.0.0.0/4)"],
];
const RANGES_V6: [string, number, string][] = [
  ["::", 128, "endereço não especificado (::)"],
  ["::1", 128, "loopback (::1)"],
  ["100::", 64, "descarte (100::/64)"],
  ["2001:db8::", 32, "documentação (2001:db8::/32)"],
  ["2001::", 23, "atribuições IETF (2001::/23)"],
  ["fc00::", 7, "rede local única (fc00::/7)"],
  ["fe80::", 10, "link-local (fe80::/10)"],
  ["fec0::", 10, "site-local (fec0::/10)"],
  ["ff00::", 8, "multicast (ff00::/8)"],
];

const blockV4 = RANGES_V4.map(([net, prefix, label]) => {
  const b = new BlockList();
  b.addSubnet(net, prefix, "ipv4");
  return { b, label };
});
const blockV6 = RANGES_V6.map(([net, prefix, label]) => {
  const b = new BlockList();
  b.addSubnet(net, prefix, "ipv6");
  return { b, label };
});

/** Expande um IPv6 em 8 grupos de 16 bits (aceita sufixo IPv4). null se inválido. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0]!;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const p = v4[1]!.split(".").map(Number);
    if (p.some((n) => n > 255)) return null;
    s = s.slice(0, -v4[1]!.length) + `${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : null;
  const groups = t === null ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => parseInt(g || "0", 16));
  return nums.some((n) => Number.isNaN(n) || n > 0xffff) ? null : nums;
}

/** IPv4 embutido em IPv6 mapeado (::ffff:a.b.c.d), compatível (::a.b.c.d) ou NAT64 (64:ff9b::/96). */
function embeddedV4(groups: number[]): string | null {
  const zero5 = groups.slice(0, 5).every((g) => g === 0);
  const mapped = zero5 && (groups[5] === 0xffff || groups[5] === 0);
  const nat64 = groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0);
  if (!mapped && !nat64) return null;
  if (mapped && groups[5] === 0 && groups[6] === 0 && groups[7]! <= 1) return null; // :: e ::1 tratados como IPv6
  return `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
}

function endpointVerdict(ip: string, port: number, policy: SafeHttpPolicy): AddressVerdict {
  if (policy.allowEndpoints?.includes(`${ip}:${port}`)) return { allowed: true, kind: "public" };
  return classifyAddress(ip, policy);
}

function defaultPort(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
}

export function classifyAddress(ip: string, policy: Pick<SafeHttpPolicy, "allowPrivateNetworks" | "allowPublicNetworks">): AddressVerdict {
  const family = isIP(ip);
  if (!family) return { allowed: false, reason: `endereço inválido (${ip})` };
  let reason: string | null;
  if (family === 4) {
    reason = blockV4.find((r) => r.b.check(ip, "ipv4"))?.label ?? null;
  } else {
    const groups = ipv6Groups(ip);
    if (!groups) return { allowed: false, reason: `endereço IPv6 inválido (${ip})` };
    const v4 = embeddedV4(groups);
    if (v4) return classifyAddress(v4, policy);
    reason = blockV6.find((r) => r.b.check(ip, "ipv6"))?.label ?? null;
  }
  if (reason) return policy.allowPrivateNetworks ? { allowed: true, kind: "private_allowed" } : { allowed: false, reason: `destino em ${reason}` };
  if (!policy.allowPublicNetworks) return { allowed: false, reason: "envio para endereços externos desabilitado neste ambiente (ALLOW_EXTERNAL_DELIVERY=false)" };
  return { allowed: true, kind: "public" };
}

const RESERVED_NAMES = [/^localhost$/, /\.localhost$/, /\.local$/, /\.internal$/, /\.home\.arpa$/, /^metadata$/, /^metadata\.google\.internal$/];

export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: string };

/** Validação estática (cadastro e cada salto): esquema, credenciais, host reservado/próprio e IP literal. */
export function validateOutboundUrl(raw: string, policy: SafeHttpPolicy): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "URL inválida" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: `esquema não permitido (${url.protocol})` };
  if (policy.requireHttps && url.protocol !== "https:") return { ok: false, reason: "https obrigatório" };
  if (url.username || url.password) return { ok: false, reason: "credenciais na URL não são permitidas" };
  if (raw.length > 2048) return { ok: false, reason: "URL longa demais" };
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, reason: "host ausente" };
  const own = (policy.blockedHosts ?? []).map((h) => h.toLowerCase());
  if (own.includes(host)) return { ok: false, reason: "o destino aponta para o próprio sistema (loop de webhooks)" };
  if (isIP(host)) {
    const v = endpointVerdict(host, defaultPort(url), policy);
    if (!v.allowed) return { ok: false, reason: v.reason };
  } else if (!policy.allowPrivateNetworks && RESERVED_NAMES.some((re) => re.test(host))) {
    return { ok: false, reason: `nome de host reservado/interno (${host})` };
  }
  return { ok: true, url };
}

const defaultLookup: LookupFn = (hostname) =>
  new Promise((resolve, reject) => dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs))));

class SsrfBlockedError extends Error {
  readonly code = "ESSRFBLOCKED";
}

/** lookup para o socket: resolve, valida TODOS os endereços e devolve somente endereços validados. */
function guardedLookup(policy: SafeHttpPolicy, port: number, seen: string[]) {
  const resolver = policy.lookup ?? defaultLookup;
  return (hostname: string, options: { all?: boolean; family?: number } | number, callback: (...args: unknown[]) => void) => {
    const opts = typeof options === "number" ? { family: options } : (options ?? {});
    resolver(hostname)
      .then((addrs) => {
        if (!addrs.length) throw new Error(`DNS sem endereços para ${hostname}`);
        for (const a of addrs) {
          const v = endpointVerdict(a.address, port, policy);
          if (!v.allowed) throw new SsrfBlockedError(`${hostname} resolve para ${a.address}: ${v.reason}`);
        }
        const usable = opts.family ? addrs.filter((a) => a.family === opts.family) : addrs;
        const list = usable.length ? usable : addrs;
        seen.push(list[0]!.address);
        if (opts.all) callback(null, list.map((a) => ({ address: a.address, family: a.family })));
        else callback(null, list[0]!.address, list[0]!.family);
      })
      .catch((err: Error) => callback(err));
  };
}

export interface SafeRequest {
  url: string;
  method?: "POST" | "GET";
  headers?: Record<string, string>;
  body?: string;
}

export type SafeResponse =
  | {
      ok: true;
      status: number;
      body: string;
      truncated: boolean;
      redirects: string[];
      latencyMs: number;
      remoteAddress: string | null;
    }
  | {
      ok: false;
      error: "blocked" | "timeout" | "network" | "redirect";
      message: string;
      status: number | null;
      redirects: string[];
      latencyMs: number;
    };

export async function safeRequest(req: SafeRequest, policy: SafeHttpPolicy): Promise<SafeResponse> {
  const started = Date.now();
  const maxRedirects = policy.maxRedirects ?? 3;
  const timeoutMs = policy.timeoutMs ?? 10_000;
  const maxBytes = policy.maxResponseBytes ?? 64 * 1024;
  const deadline = started + timeoutMs;
  const redirects: string[] = [];
  let current = req.url;
  for (let hop = 0; ; hop++) {
    const v = validateOutboundUrl(current, policy);
    if (!v.ok) return { ok: false, error: "blocked", message: v.reason, status: null, redirects, latencyMs: Date.now() - started };
    const res = await once(v.url, req, policy, Math.max(1, deadline - Date.now()), maxBytes);
    if (!res.ok) return { ...res, redirects, latencyMs: Date.now() - started };
    if (res.status >= 300 && res.status < 400 && res.location) {
      if (res.status !== 307 && res.status !== 308) {
        return { ok: false, error: "redirect", message: `redirecionamento ${res.status} não seguido (mudaria o método)`, status: res.status, redirects, latencyMs: Date.now() - started };
      }
      if (hop >= maxRedirects) return { ok: false, error: "redirect", message: `limite de ${maxRedirects} redirecionamentos excedido`, status: res.status, redirects, latencyMs: Date.now() - started };
      let next: string;
      try {
        next = new URL(res.location, v.url).toString();
      } catch {
        return { ok: false, error: "redirect", message: "Location inválido", status: res.status, redirects, latencyMs: Date.now() - started };
      }
      redirects.push(next);
      current = next;
      continue;
    }
    return { ok: true, status: res.status, body: res.body, truncated: res.truncated, redirects, latencyMs: Date.now() - started, remoteAddress: res.remoteAddress };
  }
}

type OnceResult =
  | { ok: true; status: number; body: string; truncated: boolean; location: string | null; remoteAddress: string | null }
  | { ok: false; error: "blocked" | "timeout" | "network"; message: string; status: number | null };

function once(url: URL, req: SafeRequest, policy: SafeHttpPolicy, timeoutMs: number, maxBytes: number): Promise<OnceResult> {
  return new Promise((resolve) => {
    const seen: string[] = [];
    const lib = url.protocol === "https:" ? https : http;
    const body = req.body !== undefined ? Buffer.from(req.body) : null;
    let settled = false;
    const done = (r: OnceResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const r = lib.request(
      url,
      {
        method: req.method ?? "POST",
        headers: { "user-agent": "Tracker-Webhooks/1.0", ...(req.headers ?? {}), ...(body ? { "content-length": String(body.length) } : {}) },
        lookup: guardedLookup(policy, defaultPort(url), seen) as never,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on("data", (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size > maxBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, Math.max(0, maxBytes - (size - chunk.length))));
            res.destroy();
            finish();
            return;
          }
          chunks.push(chunk);
        });
        const finish = () =>
          done({
            ok: true,
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            truncated,
            location: typeof res.headers.location === "string" ? res.headers.location : null,
            remoteAddress: res.socket?.remoteAddress ?? seen[0] ?? null,
          });
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", (e) => done({ ok: false, error: "network", message: e.message, status: res.statusCode ?? null }));
      },
    );
    const timer = setTimeout(() => {
      r.destroy(new Error("timeout"));
      done({ ok: false, error: "timeout", message: `sem resposta em ${timeoutMs} ms`, status: null });
    }, timeoutMs);
    r.on("error", (e: Error & { code?: string }) => {
      if (e instanceof SsrfBlockedError || e.code === "ESSRFBLOCKED") done({ ok: false, error: "blocked", message: e.message, status: null });
      else done({ ok: false, error: "network", message: e.message, status: null });
    });
    if (body) r.write(body);
    r.end();
  });
}

/**
 * Política de saída a partir do ambiente (API e worker usam a mesma regra). Rede privada só com opt-in explícito e
 * nunca em produção; endereços públicos só com ALLOW_EXTERNAL_DELIVERY=true; https obrigatório em produção.
 */
export function outboundPolicyFromEnv(env: Record<string, string | undefined>): SafeHttpPolicy {
  const production = env.NODE_ENV === "production" || env.APP_ENV === "production";
  const allowPrivate = env.OUTBOUND_ALLOW_PRIVATE_NETWORKS === "true";
  if (production && allowPrivate) throw new Error("OUTBOUND_ALLOW_PRIVATE_NETWORKS não pode ser true em produção");
  const hostOf = (u: string | undefined) => {
    try {
      return u ? new URL(u).hostname.toLowerCase() : null;
    } catch {
      return null;
    }
  };
  const blockedHosts = [hostOf(env.PUBLIC_API_URL), hostOf(env.NEXT_PUBLIC_APP_URL), ...(env.OUTBOUND_BLOCKED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase())].filter(
    (h): h is string => !!h,
  );
  return {
    allowPrivateNetworks: allowPrivate,
    allowPublicNetworks: env.ALLOW_EXTERNAL_DELIVERY === "true",
    requireHttps: production || env.OUTBOUND_REQUIRE_HTTPS === "true",
    maxRedirects: 3,
    timeoutMs: Number(env.OUTBOUND_TIMEOUT_MS ?? 10_000),
    maxResponseBytes: 64 * 1024,
    blockedHosts,
  };
}

/** Validação no cadastro: URL estática + resolução DNS atual (todos os endereços precisam ser permitidos). */
export async function checkOutboundDestination(raw: string, policy: SafeHttpPolicy): Promise<{ ok: true; url: URL } | { ok: false; reason: string }> {
  const v = validateOutboundUrl(raw, policy);
  if (!v.ok) return v;
  const host = v.url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return v;
  try {
    const addrs = await (policy.lookup ?? defaultLookup)(host);
    if (!addrs.length) return { ok: false, reason: "DNS sem endereços" };
    for (const a of addrs) {
      const verdict = endpointVerdict(a.address, defaultPort(v.url), policy);
      if (!verdict.allowed) return { ok: false, reason: `${host} resolve para ${a.address}: ${verdict.reason}` };
    }
  } catch (err) {
    return { ok: false, reason: `DNS não resolvido (${(err as Error).message})` };
  }
  return v;
}
