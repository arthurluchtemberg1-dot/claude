/**
 * SDK de rastreamento do Tracker (seção 13). Pequeno, sem dependências, sem eval, compatível com CSP que
 * permita o domínio de coleta. Instalação em uma linha (fila `tracker(...)` antes do carregamento).
 *
 * Princípios: consentimento por finalidade (analytics/publicidade/armazenamento); sem fingerprinting; sem leitura
 * de formulários; URLs sanitizadas; nunca fabrica click IDs ou cookies de plataforma; falhas de rede ou de storage
 * não quebram a página.
 */

export const SDK_VERSION = "1.0.0";

type Consent = { analytics: boolean | null; ads: boolean | null; storage: boolean | null };
type Props = Record<string, string | number | boolean | null>;

export interface InitOptions {
  projectKey: string;
  endpoint: string;
  consent?: Partial<Consent>;
  /** Hosts de checkout cujos links serão decorados com UTMs e token (ex.: ["pay.lowify.com.br"]). */
  checkoutHosts?: string[];
  /** Parâmetro que transporta o token (padrão "trk"). Para Lowify use um campo UTM configurado na conexão. */
  tokenParam?: string;
  /** "set" substitui/cria o parâmetro; "append" acrescenta "|token" ao valor existente (útil para campos UTM). */
  tokenParamMode?: "set" | "append";
  autoPageView?: boolean;
  spa?: boolean;
  /** Origens de iframes cooperativos que podem enviar eventos via postMessage. */
  frameOrigins?: string[];
  test?: boolean;
}

interface QueuedEvent {
  id: string;
  name: string;
  ts: number;
  url: string;
  props?: Props;
}

// Acesso dinâmico ao escopo global do navegador (fila de instalação e APIs opcionais).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const W: Record<string, any> = typeof window !== "undefined" ? (window as unknown as Record<string, unknown>) : {};
const UTM = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "utm_id"];
const CLICK_IDS = ["fbclid", "gclid", "gbraid", "wbraid", "ttclid", "msclkid"];
const PAID_CLICK_IDS = ["gclid", "gbraid", "wbraid", "ttclid", "msclkid"];
const PAID_MEDIUMS = ["cpc", "ppc", "cpm", "paid", "paid_social", "paidsocial", "display", "ads", "retargeting"];
const SESSION_MS = 30 * 60_000;
const MAX_QUEUE = 100;
const BATCH = 10;
const FLUSH_MS = 2000;
const TOKEN_RE = /^trk_[A-Za-z0-9]{16,40}$/;

function rid(len = 22): string {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(len);
  const c = W.crypto as Crypto | undefined;
  if (c && c.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  let s = "";
  for (let i = 0; i < len; i++) s += a[bytes[i]! % 62];
  return s;
}

/** Storage tolerante a falhas (modo privado, bloqueio de cookies — T35). */
class SafeStore {
  private mem = new Map<string, string>();
  constructor(private enabled: () => boolean, private kind: "localStorage" | "sessionStorage") {}
  private backend(): Storage | null {
    if (!this.enabled()) return null;
    try {
      const s = W[this.kind] as Storage | undefined;
      if (!s) return null;
      const k = "__trk_probe";
      s.setItem(k, "1");
      s.removeItem(k);
      return s;
    } catch {
      return null;
    }
  }
  get(k: string): string | null {
    const b = this.backend();
    try {
      return (b ? b.getItem(k) : null) ?? this.mem.get(k) ?? null;
    } catch {
      return this.mem.get(k) ?? null;
    }
  }
  set(k: string, v: string) {
    this.mem.set(k, v);
    const b = this.backend();
    try {
      b?.setItem(k, v);
    } catch {
      /* armazenamento indisponível: permanece em memória */
    }
  }
  clear(prefix: string) {
    for (const k of [...this.mem.keys()]) if (k.startsWith(prefix)) this.mem.delete(k);
    const b = this.backend();
    try {
      if (b) for (const k of Object.keys(b)) if (k.startsWith(prefix)) b.removeItem(k);
    } catch {
      /* ignorar */
    }
  }
  /** Descarta dados persistidos quando o consentimento de armazenamento é negado/revogado. */
  purgePersistent(prefix: string) {
    try {
      const s = W[this.kind] as Storage | undefined;
      if (s) for (const k of Object.keys(s)) if (k.startsWith(prefix)) s.removeItem(k);
    } catch {
      /* ignorar */
    }
  }
}

function readCookie(name: string): string | null {
  try {
    const m = ("; " + (W.document?.cookie ?? "")).split(`; ${name}=`);
    return m.length === 2 ? decodeURIComponent(m.pop()!.split(";")[0]!) : null;
  } catch {
    return null;
  }
}

/** URL sanitizada: origem + caminho + parâmetros permitidos (R13-22). */
export function sanitize(href: string): string {
  try {
    const u = new URL(href);
    const out = new URL(u.origin + u.pathname);
    for (const k of [...UTM, ...CLICK_IDS]) {
      const v = u.searchParams.get(k);
      if (v !== null) out.searchParams.set(k, v.slice(0, 500));
    }
    return out.toString();
  } catch {
    return "";
  }
}

export function classify(params: URLSearchParams, referrer: string, host: string): { paid: boolean; channel: string } {
  const medium = (params.get("utm_medium") || "").toLowerCase();
  if (PAID_CLICK_IDS.some((k) => params.get(k))) return { paid: true, channel: "paid" };
  if (medium && PAID_MEDIUMS.includes(medium)) return { paid: true, channel: "paid" };
  if (medium || params.get("utm_source")) return { paid: false, channel: "campaign" };
  if (referrer) {
    try {
      if (new URL(referrer).hostname !== host) return { paid: false, channel: "referral" };
    } catch {
      /* ignorar */
    }
  }
  return { paid: false, channel: "direct" };
}

export class Tracker {
  private opts!: Required<Omit<InitOptions, "consent">> & { consent: Consent };
  private consent: Consent = { analytics: null, ads: null, storage: null };
  private queue: QueuedEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private local = new SafeStore(() => this.consent.storage === true, "localStorage");
  private session = new SafeStore(() => this.consent.storage === true, "sessionStorage");
  private token: string | null = null;
  private tokenPending = false;
  private initialized = false;
  private lastPath = "";

  init(o: InitOptions) {
    if (this.initialized) return; // instalação única (R13-02)
    if (!o || !/^pk_[A-Za-z0-9]{16,40}$/.test(o.projectKey) || !/^https?:\/\//.test(o.endpoint)) {
      console.warn("[tracker] init inválido: projectKey/endpoint");
      return;
    }
    this.initialized = true;
    this.consent = { analytics: o.consent?.analytics ?? null, ads: o.consent?.ads ?? null, storage: o.consent?.storage ?? null };
    this.opts = {
      projectKey: o.projectKey,
      endpoint: o.endpoint.replace(/\/$/, ""),
      consent: this.consent,
      checkoutHosts: o.checkoutHosts ?? [],
      tokenParam: o.tokenParam ?? "trk",
      tokenParamMode: o.tokenParamMode ?? (o.tokenParam?.startsWith("utm_") ? "append" : "set"),
      autoPageView: o.autoPageView ?? true,
      spa: o.spa ?? true,
      frameOrigins: o.frameOrigins ?? [],
      test: o.test ?? false,
    };
    this.captureLanding();
    if (this.opts.autoPageView) this.track("PageView");
    if (this.opts.spa) this.watchRoutes();
    this.watchCheckoutClicks();
    this.watchFrames();
    W.addEventListener?.("pagehide", () => this.flush(true));
    W.document?.addEventListener?.("visibilitychange", () => {
      if (W.document.visibilityState === "hidden") this.flush(true);
    });
  }

  // ------------------------------------------------------------------ consentimento
  setConsent(c: Partial<Consent>) {
    const before = this.consent;
    this.consent = {
      analytics: c.analytics ?? before.analytics,
      ads: c.ads ?? before.ads,
      storage: c.storage ?? before.storage,
    };
    if (this.consent.storage === false) {
      this.local.purgePersistent("trk_");
      this.session.purgePersistent("trk_");
    }
    if (this.consent.analytics === false) {
      this.queue = []; // T34: nada coletado após negar/revogar
      this.token = null;
    }
    if (this.consent.analytics === true && before.analytics !== true && this.initialized) this.captureLanding();
  }

  getConsent(): Consent {
    return { ...this.consent };
  }

  // ------------------------------------------------------------------ identificadores
  private anonId(): string {
    let id = this.local.get("trk_aid");
    if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
      id = rid(22);
      this.local.set("trk_aid", id);
    }
    return id;
  }

  private sessionKey(): string {
    const now = Date.now();
    let key = this.session.get("trk_sid");
    const last = Number(this.session.get("trk_sid_ts") || 0);
    if (!key || now - last > SESSION_MS) {
      key = rid(16);
      this.session.set("trk_sid", key);
    }
    this.session.set("trk_sid_ts", String(now));
    return key;
  }

  /** Primeiro toque, último toque e último toque pago mantidos separadamente (R13-08). */
  private captureLanding() {
    try {
      const loc = W.location as Location;
      const params = new URL(loc.href).searchParams;
      const hasCampaign = [...UTM, ...CLICK_IDS].some((k) => params.get(k));
      const touch = JSON.stringify({ url: sanitize(loc.href), ts: Date.now() });
      if (!this.local.get("trk_first")) this.local.set("trk_first", touch);
      if (hasCampaign || W.document?.referrer) this.local.set("trk_last", touch);
      if (classify(params, W.document?.referrer ?? "", loc.hostname).paid) this.local.set("trk_last_paid", touch);
      const utms: Record<string, string> = {};
      for (const k of UTM) {
        const v = params.get(k);
        if (v) utms[k] = v;
      }
      if (Object.keys(utms).length) this.session.set("trk_utm", JSON.stringify(utms));
    } catch {
      /* ignorar */
    }
  }

  touches(): { first: unknown; last: unknown; lastPaid: unknown } {
    const p = (k: string) => {
      try {
        return JSON.parse(this.local.get(k) || "null");
      } catch {
        return null;
      }
    };
    return { first: p("trk_first"), last: p("trk_last"), lastPaid: p("trk_last_paid") };
  }

  // ------------------------------------------------------------------ eventos
  track(name: string, props?: Props) {
    if (!this.initialized) return;
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(name)) return;
    if (this.consent.analytics === false) return;
    const clean: Props = {};
    if (props) {
      let n = 0;
      for (const [k, v] of Object.entries(props)) {
        if (n++ >= 20) break;
        if (typeof k !== "string" || k.length > 40) continue;
        if (v === null || typeof v === "number" || typeof v === "boolean") clean[k] = v;
        else if (typeof v === "string") clean[k] = v.slice(0, 200);
      }
    }
    this.queue.push({ id: rid(20), name, ts: Date.now(), url: sanitize(W.location?.href ?? ""), props: clean });
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    if (this.queue.length >= BATCH) this.flush(false);
    else this.schedule();
  }

  /** identify somente com identidade fornecida voluntariamente; envia apenas hash SHA-256 do e-mail (R13-13). */
  async identify(email: string) {
    if (this.consent.analytics !== true || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return;
    const subtle = (W.crypto as Crypto | undefined)?.subtle;
    if (!subtle) return;
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase()));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    this.track("Identify", { id_hash: hex });
  }

  reset() {
    this.local.clear("trk_");
    this.session.clear("trk_");
    this.token = null;
    this.queue = [];
  }

  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush(false);
    }, FLUSH_MS * Math.min(2 ** this.failures, 16));
  }

  private payload(events: QueuedEvent[], tokenRequest: boolean) {
    const ads = this.consent.ads === true;
    return {
      v: 1,
      pk: this.opts.projectKey,
      aid: this.anonId(),
      sid: this.sessionKey(),
      consent: this.consent,
      ctx: {
        url: W.location?.href ? sanitize(W.location.href) : "",
        ref: W.document?.referrer ? sanitize(W.document.referrer) || null : null,
        // _fbp/_fbc somente lidos (nunca criados) e somente com consentimento de publicidade (R13-06, R13-07).
        fbp: ads ? readCookie("_fbp") : null,
        fbc: ads ? readCookie("_fbc") : null,
      },
      events: events.map((e) => ({ id: e.id, name: e.name, ts: e.ts, url: e.url, props: e.props })),
      token_request: tokenRequest,
      test: this.opts.test || undefined,
    };
  }

  flush(unloading: boolean) {
    if (!this.initialized || this.consent.analytics !== true) return; // sem consentimento, nada sai do navegador
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, 50);
    const body = JSON.stringify(this.payload(batch, false));
    const url = `${this.opts.endpoint}/v1/collect`;
    const nav = W.navigator as Navigator | undefined;
    if (unloading && nav?.sendBeacon) {
      try {
        if (nav.sendBeacon(url, new Blob([body], { type: "text/plain" }))) return;
      } catch {
        /* cai para fetch */
      }
    }
    this.send(url, body)
      .then((ok) => {
        if (ok) this.failures = 0;
        else throw new Error("falha");
      })
      .catch(() => {
        this.failures = Math.min(this.failures + 1, 5);
        if (this.failures < 5) {
          this.queue.unshift(...batch);
          if (this.queue.length > MAX_QUEUE) this.queue.length = MAX_QUEUE;
          this.schedule();
        }
      });
  }

  private async send(url: string, body: string): Promise<boolean> {
    const f = W.fetch as typeof fetch | undefined;
    if (!f) return false;
    try {
      const r = await f(url, { method: "POST", body, headers: { "content-type": "text/plain" }, keepalive: body.length < 60_000, credentials: "omit", mode: "cors" });
      return r.ok || r.status === 202;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------ token e checkout
  /** Solicita token opaco ao servidor (somente com consentimento de analytics). */
  async requestToken(): Promise<string | null> {
    if (this.token && TOKEN_RE.test(this.token)) return this.token;
    const cached = this.session.get("trk_tok");
    const exp = Number(this.session.get("trk_tok_exp") || 0);
    if (cached && TOKEN_RE.test(cached) && exp > Date.now()) return (this.token = cached);
    if (!this.initialized || this.consent.analytics !== true || this.tokenPending) return null;
    this.tokenPending = true;
    try {
      const f = W.fetch as typeof fetch;
      const res = await f(`${this.opts.endpoint}/v1/collect`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(this.payload([], true)), credentials: "omit", mode: "cors" });
      if (!res.ok) return null;
      const j = (await res.json()) as { token?: string; token_expires_at?: string };
      if (j.token && TOKEN_RE.test(j.token)) {
        this.token = j.token;
        this.session.set("trk_tok", j.token);
        this.session.set("trk_tok_exp", String(Math.min(Date.parse(j.token_expires_at ?? "") || 0, Date.now() + 7 * 86_400_000)));
        return j.token;
      }
      return null;
    } catch {
      return null;
    } finally {
      this.tokenPending = false;
    }
  }

  /**
   * Decora a URL do checkout: preserva parâmetros existentes (afiliado, cupom, oferta) e fragmento, acrescenta
   * UTMs da sessão ausentes e o token no parâmetro configurado. Nunca sobrescreve parâmetros existentes, exceto
   * no modo "append" do transportador de token.
   */
  linkCheckout(href: string): string {
    try {
      const u = new URL(href, W.location?.href);
      if (u.protocol !== "https:" && u.protocol !== "http:") return href;
      let utms: Record<string, string> = {};
      try {
        utms = JSON.parse(this.session.get("trk_utm") || "{}");
      } catch {
        utms = {};
      }
      for (const [k, v] of Object.entries(utms)) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
      const tok = this.token;
      if (tok && this.consent.analytics === true) {
        const p = this.opts.tokenParam;
        const current = u.searchParams.get(p);
        if (!current) u.searchParams.set(p, tok);
        else if (this.opts.tokenParamMode === "append" && !current.includes(tok)) u.searchParams.set(p, `${current}|${tok}`.slice(-500));
      }
      return u.toString();
    } catch {
      return href;
    }
  }

  private isCheckout(a: HTMLAnchorElement): boolean {
    try {
      const host = new URL(a.href).hostname;
      return this.opts.checkoutHosts.some((h) => host === h || host.endsWith("." + h)) || a.hasAttribute("data-tracker-checkout");
    } catch {
      return false;
    }
  }

  private watchCheckoutClicks() {
    const doc = W.document as Document | undefined;
    if (!doc) return;
    // Token pré-carregado para que o clique não aguarde rede.
    if (this.opts.checkoutHosts.length || doc.querySelector?.("[data-tracker-checkout]")) void this.requestToken();
    doc.addEventListener(
      "click",
      (ev) => {
        const target = ev.target as Element | null;
        const a = target?.closest?.("a[href]") as HTMLAnchorElement | null;
        if (!a || !this.isCheckout(a)) return;
        // Clique no botão ≠ checkout iniciado (R13-05).
        this.track("CheckoutClick", { host: new URL(a.href).hostname });
        a.href = this.linkCheckout(a.href);
        this.flush(true);
      },
      true,
    );
  }

  private watchRoutes() {
    const hist = W.history as History | undefined;
    if (!hist) return;
    this.lastPath = W.location.pathname + W.location.search;
    const onChange = () => {
      const p = W.location.pathname + W.location.search;
      if (p === this.lastPath) return;
      this.lastPath = p;
      this.captureLanding();
      this.track("PageView");
    };
    // Envolve history uma única vez e notifica por evento, para não depender da instância que envolveu.
    for (const m of ["pushState", "replaceState"] as const) {
      const orig = hist[m];
      if (typeof orig !== "function" || (orig as { __trk?: boolean }).__trk) continue;
      const wrapped = function (this: History, ...args: Parameters<History["pushState"]>) {
        const r = orig.apply(this, args);
        setTimeout(() => W.dispatchEvent?.(new Event("trk:locationchange")), 0);
        return r;
      };
      (wrapped as { __trk?: boolean }).__trk = true;
      hist[m] = wrapped;
    }
    W.addEventListener("trk:locationchange", onChange);
    W.addEventListener("popstate", onChange);
  }

  /** Adaptador de iframe cooperativo: aceita eventos só de origens explicitamente permitidas (R13-10). */
  private watchFrames() {
    if (!this.opts.frameOrigins.length) return;
    W.addEventListener("message", (ev: MessageEvent) => {
      if (!this.opts.frameOrigins.includes(ev.origin)) return;
      const d = ev.data as { type?: string; name?: string; props?: Props } | null;
      if (!d || d.type !== "tracker:event" || typeof d.name !== "string") return;
      this.track(d.name, d.props);
    });
  }
}

/** Fila de instalação: `tracker("init", {...})`, `tracker("track", "Lead")`, etc. */
export function boot(globalName = "tracker") {
  if (W.__trackerLoaded) return W.__trackerInstance as Tracker;
  W.__trackerLoaded = true;
  const t = new Tracker();
  W.__trackerInstance = t;
  const call = (method: string, ...args: unknown[]) => {
    try {
      switch (method) {
        case "init":
          return t.init(args[0] as InitOptions);
        case "track":
          return t.track(args[0] as string, args[1] as Props);
        case "setConsent":
          return t.setConsent(args[0] as Partial<Consent>);
        case "linkCheckout":
          return t.linkCheckout(args[0] as string);
        case "identify":
          return void t.identify(args[0] as string);
        case "reset":
          return t.reset();
        case "requestToken":
          return t.requestToken();
        case "touches":
          return t.touches();
        default:
          console.warn(`[tracker] método desconhecido: ${method}`);
      }
    } catch (err) {
      console.warn("[tracker] erro interno", err);
    }
  };
  const pending = (W.TrackerQ as unknown[][] | undefined) ?? [];
  W[globalName] = (...args: unknown[]) => call(String(args[0]), ...args.slice(1));
  W[globalName].version = SDK_VERSION;
  for (const args of pending) call(String(args[0]), ...args.slice(1));
  W.TrackerQ = [];
  return t;
}
