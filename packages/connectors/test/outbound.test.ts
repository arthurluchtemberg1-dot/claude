import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyAddress, safeRequest, signOutbound, validateOutboundUrl, verifyOutbound, type SafeHttpPolicy } from "../src";

/** T67 — URL de webhook para endereço interno: bloquear SSRF inclusive via redirect e DNS. */

const prod: SafeHttpPolicy = { allowPrivateNetworks: false, allowPublicNetworks: true, requireHttps: true };
const dev: SafeHttpPolicy = { allowPrivateNetworks: true, allowPublicNetworks: false, requireHttps: false, timeoutMs: 2000 };

describe("classificação de endereços", () => {
  it.each([
    ["127.0.0.1"], ["10.1.2.3"], ["172.16.0.1"], ["172.31.255.255"], ["192.168.0.10"], ["169.254.169.254"], ["100.64.0.1"], ["0.0.0.0"],
    ["224.0.0.1"], ["255.255.255.255"], ["::1"], ["::"], ["fe80::1"], ["fd00::1"], ["::ffff:127.0.0.1"], ["::ffff:a9fe:a9fe"], ["64:ff9b::a00:1"], ["2001:db8::1"],
  ])("bloqueia %s", (ip) => {
    expect(classifyAddress(ip, prod).allowed).toBe(false);
  });
  it.each([["8.8.8.8"], ["1.1.1.1"], ["2606:4700:4700::1111"], ["2001:4860:4860::8888"], ["172.32.0.1"], ["::ffff:8.8.8.8"]])("permite público %s", (ip) => {
    expect(classifyAddress(ip, prod)).toEqual({ allowed: true, kind: "public" });
  });
  it("envio externo desabilitado bloqueia endereços públicos", () => {
    expect(classifyAddress("8.8.8.8", dev)).toMatchObject({ allowed: false, reason: expect.stringMatching(/ALLOW_EXTERNAL_DELIVERY/) });
  });
});

describe("validação estática da URL", () => {
  it.each([
    ["http://exemplo.com/h", /https obrigatório/],
    ["ftp://exemplo.com/h", /esquema/],
    ["file:///etc/passwd", /esquema/],
    ["https://user:pass@exemplo.com/h", /credenciais/],
    ["https://127.0.0.1/h", /loopback/],
    ["https://[::1]/h", /loopback/],
    ["https://169.254.169.254/latest/meta-data", /metadata/],
    ["https://2130706433/h", /loopback/], // 127.0.0.1 em decimal (normalizado pelo parser de URL)
    ["https://0x7f.0.0.1/h", /loopback/],
    ["https://localhost/h", /reservado/],
    ["https://metadata.google.internal/computeMetadata/v1/", /reservado/],
    ["https://api.tracker.local/h", /reservado/],
    ["https://entrada.tracker.test/v1/webhooks/x", /loop/],
  ])("%s → bloqueada", (url, reason) => {
    const v = validateOutboundUrl(url, { ...prod, blockedHosts: ["entrada.tracker.test"] });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(reason);
  });
  it("aceita https público", () => {
    expect(validateOutboundUrl("https://hooks.exemplo.com.br/tracker?x=1", prod).ok).toBe(true);
  });
});

describe("requisição com DNS e redirecionamentos validados na conexão", () => {
  let internal: Server;
  let edge: Server;
  let internalPort = 0;
  let edgePort = 0;
  const hits: string[] = [];
  beforeAll(async () => {
    internal = createServer((req, res) => {
      hits.push(`internal ${req.url}`);
      res.end("segredo interno");
    });
    edge = createServer((req, res) => {
      hits.push(`edge ${req.method} ${req.url}`);
      if (req.url === "/to-internal") {
        res.writeHead(307, { location: `http://127.0.0.1:${internalPort}/admin` });
        return res.end();
      }
      if (req.url === "/to-metadata") {
        res.writeHead(307, { location: "http://169.254.169.254/latest/meta-data/" });
        return res.end();
      }
      if (req.url === "/to-rebind") {
        res.writeHead(308, { location: `http://rebind.exemplo.test:${internalPort}/admin` });
        return res.end();
      }
      if (req.url === "/302") {
        res.writeHead(302, { location: "/ok" });
        return res.end();
      }
      if (req.url === "/loop") {
        res.writeHead(307, { location: "/loop" });
        return res.end();
      }
      if (req.url === "/big") return res.end("x".repeat(200_000));
      if (req.url === "/slow") return setTimeout(() => res.end("tarde"), 3000);
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => res.end(`ok:${body}`));
    });
    await new Promise<void>((r) => internal.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => edge.listen(0, "127.0.0.1", r));
    internalPort = (internal.address() as AddressInfo).port;
    edgePort = (edge.address() as AddressInfo).port;
  });
  afterAll(() => {
    internal.close();
    edge.close();
    edge.closeAllConnections();
  });

  // "Rede pública" simulada: publico.exemplo.test resolve para o servidor de borda local, e SOMENTE esse ip:porta é
  // tratado como público; o servidor interno (mesmo host, outra porta), metadata e redes privadas seguem bloqueados.
  const edgeOnly = (): SafeHttpPolicy => ({
    allowPrivateNetworks: false,
    allowPublicNetworks: true,
    requireHttps: false,
    timeoutMs: 1500,
    maxResponseBytes: 1024,
    allowEndpoints: [`127.0.0.1:${edgePort}`],
    lookup: async (host) => {
      if (host === "publico.exemplo.test") return [{ address: "127.0.0.1", family: 4 }];
      if (host === "rebind.exemplo.test") return [{ address: "10.0.0.5", family: 4 }];
      if (host === "misto.exemplo.test") return [{ address: "127.0.0.1", family: 4 }, { address: "192.168.1.1", family: 4 }];
      throw new Error("NXDOMAIN");
    },
  });

  it("borda \"pública\" é alcançada; DNS para endereço interno é bloqueado na conexão (inclui resolução mista)", async () => {
    const ok = await safeRequest({ url: `http://publico.exemplo.test:${edgePort}/eco`, body: "{}" }, edgeOnly());
    expect(ok).toMatchObject({ ok: true, status: 200, body: "ok:{}" });
    const r1 = await safeRequest({ url: `http://rebind.exemplo.test:${internalPort}/admin`, body: "{}" }, edgeOnly());
    expect(r1).toMatchObject({ ok: false, error: "blocked", message: expect.stringMatching(/10\.0\.0\.5/) });
    const r2 = await safeRequest({ url: `http://misto.exemplo.test:${edgePort}/`, body: "{}" }, edgeOnly());
    expect(r2).toMatchObject({ ok: false, error: "blocked", message: expect.stringMatching(/192\.168\.1\.1/) });
    // Mesmo host da borda, porta do serviço interno: não é exceção.
    const r3 = await safeRequest({ url: `http://publico.exemplo.test:${internalPort}/admin`, body: "{}" }, edgeOnly());
    expect(r3).toMatchObject({ ok: false, error: "blocked" });
    expect(hits.filter((h) => h.startsWith("internal"))).toEqual([]);
  });

  it("redirecionamento para endereço interno, metadata ou nome que resolve para rede privada é bloqueado a cada salto", async () => {
    for (const path of ["/to-internal", "/to-metadata", "/to-rebind"]) {
      const r = await safeRequest({ url: `http://publico.exemplo.test:${edgePort}${path}`, body: "{}" }, edgeOnly());
      expect(r, path).toMatchObject({ ok: false, error: "blocked" });
      expect(r.redirects).toHaveLength(1);
    }
    expect(hits.filter((h) => h.startsWith("edge POST /to-")).length).toBe(3); // a borda foi de fato contatada
    expect(hits.filter((h) => h.startsWith("internal"))).toEqual([]); // o serviço interno nunca foi alcançado
  });

  it("limita redirecionamentos, não converte POST em GET, limita resposta e tempo", async () => {
    const loop = await safeRequest({ url: `http://127.0.0.1:${edgePort}/loop`, body: "{}" }, { ...dev, maxRedirects: 2 });
    expect(loop).toMatchObject({ ok: false, error: "redirect", message: expect.stringMatching(/limite de 2/) });
    const r302 = await safeRequest({ url: `http://127.0.0.1:${edgePort}/302`, body: "{}" }, dev);
    expect(r302).toMatchObject({ ok: false, error: "redirect", status: 302 });
    const big = await safeRequest({ url: `http://127.0.0.1:${edgePort}/big`, method: "GET" }, { ...dev, maxResponseBytes: 1000 });
    expect(big).toMatchObject({ ok: true, status: 200, truncated: true });
    if (big.ok) expect(big.body.length).toBe(1000);
    const slow = await safeRequest({ url: `http://127.0.0.1:${edgePort}/slow`, body: "{}" }, { ...dev, timeoutMs: 300 });
    expect(slow).toMatchObject({ ok: false, error: "timeout" });
    const ok = await safeRequest({ url: `http://127.0.0.1:${edgePort}/eco`, body: '{"a":1}', headers: { "content-type": "application/json" } }, dev);
    expect(ok).toMatchObject({ ok: true, status: 200, body: 'ok:{"a":1}' });
  });

  it("produção bloqueia o próprio loopback mesmo com porta aberta", async () => {
    const r = await safeRequest({ url: `http://127.0.0.1:${edgePort}/eco`, body: "{}" }, { ...prod, requireHttps: false });
    expect(r).toMatchObject({ ok: false, error: "blocked", message: expect.stringMatching(/loopback/) });
  });
});

describe("assinatura de saída", () => {
  it("assina com timestamp e ID; aceita segredo anterior durante rotação; rejeita alteração e replay", () => {
    const now = new Date("2026-09-24T12:00:00Z");
    const t = Math.floor(now.getTime() / 1000);
    const body = '{"type":"order.approved"}';
    const header = signOutbound(["novo", "antigo"], "whd_1", t, body);
    expect(header).toMatch(/^t=\d+,id=whd_1,v1=[0-9a-f]{64},v1=[0-9a-f]{64}$/);
    expect(verifyOutbound(header, body, "novo", now)).toEqual({ ok: true, id: "whd_1" });
    expect(verifyOutbound(header, body, "antigo", now)).toEqual({ ok: true, id: "whd_1" });
    expect(verifyOutbound(header, body + " ", "novo", now).ok).toBe(false);
    expect(verifyOutbound(header.replace("id=whd_1", "id=whd_2"), body, "novo", now).ok).toBe(false);
    expect(verifyOutbound(header, body, "novo", new Date(now.getTime() + 3600_000)).ok).toBe(false);
  });
});

describe("exemplo de verificação documentado em docs/API.md", () => {
  it("o código publicado verifica assinaturas reais, inclusive na rotação, e rejeita adulteração", async () => {
    const md = readFileSync(join(import.meta.dirname, "../../../docs/API.md"), "utf8");
    const block = /Verificação \(Node\.js[\s\S]*?```js\n([\s\S]*?)```/.exec(md)?.[1];
    expect(block).toBeTruthy();
    const dir = mkdtempSync(join(tmpdir(), "api-doc-"));
    const file = join(dir, "verify.mjs");
    writeFileSync(file, block!);
    const { verify } = (await import(pathToFileURL(file).href)) as { verify: (h: string, b: string, s: string) => boolean };
    const body = '{"type":"order.approved"}';
    const header = signOutbound(["novo", "antigo"], "whd_doc", Math.floor(Date.now() / 1000), body);
    expect(verify(header, body, "novo")).toBe(true);
    expect(verify(header, body, "antigo")).toBe(true);
    expect(verify(header, body, "outro")).toBe(false);
    expect(verify(header, body + "x", "novo")).toBe(false);
    expect(verify(signOutbound(["novo"], "whd_doc", Math.floor(Date.now() / 1000) - 3600, body), body, "novo")).toBe(false);
  });
});
