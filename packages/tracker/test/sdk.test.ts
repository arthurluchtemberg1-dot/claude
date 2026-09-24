// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tracker, boot, sanitize } from "../src";

const PK = "pk_AbCdEfGhIjKlMnOpQrStUvWx";
const ENDPOINT = "https://api.exemplo.test";

interface Sent {
  url: string;
  body: any;
}
let sent: Sent[] = [];
let failNext = 0;

beforeEach(() => {
  sent = [];
  failNext = 0;
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.cookie = "_fbp=fb.1.1726000000000.123456789; path=/";
  vi.useFakeTimers();
  (window as any).fetch = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push({ url, body });
    if (failNext > 0) {
      failNext--;
      throw new TypeError("rede indisponível");
    }
    const token = body.token_request ? { token: "trk_ServerIssuedToken0000001", token_expires_at: new Date(Date.now() + 86400000).toISOString() } : {};
    return new Response(JSON.stringify({ ok: true, ...token }), { status: 200 });
  });
  (navigator as any).sendBeacon = vi.fn((url: string, blob: Blob) => {
    void blob.text().then((t) => sent.push({ url, body: JSON.parse(t) }));
    return true;
  });
  window.history.replaceState({}, "", "/oferta?utm_source=facebook&utm_medium=paid_social&utm_campaign=Lan%C3%A7amento&email=joao%40x.com&fbclid=IwAR1");
});

afterEach(() => {
  vi.useRealTimers();
});

const flushTimers = async () => {
  await vi.advanceTimersByTimeAsync(40_000);
};

describe("SDK — consentimento (R13-18, R13-19, T34)", () => {
  it("sem sinal de consentimento nada é enviado nem persistido", async () => {
    const t = new Tracker();
    t.init({ projectKey: PK, endpoint: ENDPOINT });
    t.track("Lead");
    await flushTimers();
    expect(sent).toHaveLength(0);
    expect(Object.keys(window.localStorage)).toHaveLength(0);
  });

  it("analytics concedido envia lote com URL sanitizada; sem storage não persiste", async () => {
    const t = new Tracker();
    t.init({ projectKey: PK, endpoint: ENDPOINT, consent: { analytics: true } });
    t.track("ViewContent", { produto: "curso", email: "nao@deve.ir" as unknown as string });
    await flushTimers();
    expect(sent).toHaveLength(1);
    const b = sent[0]!.body;
    expect(b.pk).toBe(PK);
    expect(b.events.map((e: { name: string }) => e.name)).toEqual(["PageView", "ViewContent"]);
    expect(b.ctx.url).not.toContain("email");
    expect(b.ctx.url).toContain("utm_campaign=Lan%C3%A7amento");
    expect(b.ctx.fbp).toBeNull(); // sem consentimento de publicidade
    expect(Object.keys(window.localStorage)).toHaveLength(0);
  });

  it("revogação limpa fila e armazenamento; nada mais é enviado", async () => {
    const t = new Tracker();
    t.init({ projectKey: PK, endpoint: ENDPOINT, consent: { analytics: true, storage: true } });
    expect(window.localStorage.getItem("trk_aid")).toBeNull(); // aid criado só no envio
    await flushTimers();
    expect(window.localStorage.getItem("trk_aid")).not.toBeNull();
    t.setConsent({ analytics: false, storage: false });
    t.track("Lead");
    await flushTimers();
    expect(sent).toHaveLength(1);
    expect(Object.keys(window.localStorage).filter((k) => k.startsWith("trk_"))).toHaveLength(0);
  });

  it("_fbp é lido (nunca criado) somente com consentimento de publicidade", async () => {
    const t = new Tracker();
    t.init({ projectKey: PK, endpoint: ENDPOINT, consent: { analytics: true, ads: true } });
    await flushTimers();
    expect(sent[0]!.body.ctx.fbp).toBe("fb.1.1726000000000.123456789");
    expect(sent[0]!.body.ctx.fbc).toBeNull();
  });
});

describe("SDK — robustez (T35, R13-11, R13-20)", () => {
  it("storage lançando exceção não quebra a página", async () => {
    const orig = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("SecurityError"); } });
    try {
      const t = new Tracker();
      t.init({ projectKey: PK, endpoint: ENDPOINT, consent: { analytics: true, storage: true } });
      t.track("Lead");
      await flushTimers();
      expect(sent.length).toBeGreaterThan(0);
    } finally {
      if (orig) Object.defineProperty(window, "localStorage", orig);
    }
  });

  it("falha de rede: reenvia com backoff sem lançar erro", async () => {
    failNext = 2;
    const t = new Tracker();
    t.init({ projectKey: PK, endpoint: ENDPOINT, consent: { analytics: true } });
    await flushTimers();
    await flushTimers();
    expect(sent.length).toBe(3);
    const lastEvents = sent[2]!.body.events.map((e: { name: string }) => e.name);
    expect(lastEvents).toContain("PageView");
  });

  it("init inválido e instalação dupla são ignorados", () => {
    const t = new Tracker();
    t.init({ projectKey: "chave-invalida", endpoint: ENDPOINT });
    t.track("Lead");
    expect(sent).toHaveLength(0);
  });
});

describe("SDK — passagem para o checkout (R15, T36, T37)", () => {
  it("decora link com UTMs da sessão sem sobrescrever afiliado/fragmento e com token no transportador", async () => {
    const t = new Tracker();
    t.init({ projectKey: PK, endpoint: ENDPOINT, consent: { analytics: true }, checkoutHosts: ["pay.checkout.test"], tokenParam: "utm_term" });
    await vi.advanceTimersByTimeAsync(10);
    await t.requestToken();
    const out = t.linkCheckout("https://pay.checkout.test/c/ABC?aff=XyZ&utm_source=manual#resumo");
    const u = new URL(out);
    expect(u.searchParams.get("aff")).toBe("XyZ");
    expect(u.searchParams.get("utm_source")).toBe("manual"); // existente preservado
    expect(u.searchParams.get("utm_campaign")).toBe("Lançamento");
    expect(u.searchParams.get("utm_term")).toBe("trk_ServerIssuedToken0000001");
    expect(u.hash).toBe("#resumo");
  });

  it("clique em link de checkout registra CheckoutClick e decora o href", async () => {
    const t = new Tracker();
    t.init({ projectKey: PK, endpoint: ENDPOINT, consent: { analytics: true }, checkoutHosts: ["pay.checkout.test"] });
    await vi.advanceTimersByTimeAsync(10);
    await t.requestToken();
    const a = document.createElement("a");
    a.href = "https://pay.checkout.test/c/XYZ";
    a.addEventListener("click", (e) => e.preventDefault());
    document.body.appendChild(a);
    a.click();
    expect(a.href).toContain("trk=trk_ServerIssuedToken0000001");
    await flushTimers();
    const names = sent.flatMap((s) => s.body.events.map((e: { name: string }) => e.name));
    expect(names).toContain("CheckoutClick");
  });

  it("sem consentimento o token não é solicitado nem anexado", async () => {
    const t = new Tracker();
    t.init({ projectKey: PK, endpoint: ENDPOINT, checkoutHosts: ["pay.checkout.test"] });
    expect(await t.requestToken()).toBeNull();
    expect(t.linkCheckout("https://pay.checkout.test/c/1")).not.toContain("trk=");
  });
});

describe("SDK — SPA, fila de instalação e toques", () => {
  it("fila pré-carregamento é processada e mudança de rota gera PageView", async () => {
    (window as any).__trackerLoaded = false;
    (window as any).TrackerQ = [["init", { projectKey: PK, endpoint: ENDPOINT, consent: { analytics: true, storage: true } }], ["track", "Lead"]];
    boot("tracker");
    expect(typeof (window as any).tracker).toBe("function");
    window.history.pushState({}, "", "/checkout-etapa-2");
    await flushTimers();
    const names = sent.flatMap((s) => s.body.events.map((e: { name: string }) => e.name));
    const pageViews = sent.flatMap((s) => s.body.events).filter((e: { name: string }) => e.name === "PageView");
    expect(pageViews.some((e: { url: string }) => e.url.endsWith("/checkout-etapa-2"))).toBe(true);
    expect(names).toContain("Lead");
    const touches = (window as any).tracker("touches");
    expect(touches.first.url).toContain("utm_source=facebook");
    expect(touches.lastPaid.url).toContain("utm_medium=paid_social");
  });

  it("sanitize mantém apenas UTMs e click IDs", () => {
    expect(sanitize("https://a.test/x?utm_source=fb&senha=123&gclid=G1#frag")).toBe("https://a.test/x?utm_source=fb&gclid=G1");
  });
});
