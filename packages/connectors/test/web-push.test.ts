import { createECDH, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
// @ts-expect-error -- http_ece não publica tipos; usado só no teste para decifrar como o navegador faria.
import ece from "http_ece";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPushSender, generateVapidKeys, pushEndpointAllowed, type SafeHttpPolicy } from "../src";

/**
 * Web Push real contra um "serviço de push" local: o corpo chega cifrado (aes128gcm, RFC 8291) e só a chave privada
 * da inscrição (que fica no navegador) decifra; cabeçalho VAPID presente; 404/410 marcam inscrição expirada.
 */

let port = 0;
let nextStatus = 201;
const received: Array<{ headers: IncomingMessage["headers"]; body: Buffer; url: string }> = [];
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    received.push({ headers: req.headers, body: Buffer.concat(chunks), url: req.url ?? "" });
    res.writeHead(nextStatus).end();
  });
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

// Política de teste: só o servidor local; nada de rede pública.
const policy = (): SafeHttpPolicy => ({ allowPrivateNetworks: false, allowPublicNetworks: false, requireHttps: false, allowEndpoints: [`127.0.0.1:${port}`], timeoutMs: 2000 });

function browserSubscription() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, p256dh: ecdh.getPublicKey().toString("base64url"), authB64: auth.toString("base64url") };
}

describe("Web Push", () => {
  it("cifra o conteúdo para a inscrição e identifica o servidor por VAPID", async () => {
    const vapid = { ...generateVapidKeys(), subject: "mailto:ops@example.com" };
    const sub = browserSubscription();
    const send = createPushSender(vapid, policy(), ["127.0.0.1"]);
    const payload = { title: "Venda aprovada · R$ 197,00", body: "Curso · Projeto", link: "/vendas/1", kind: "sale.approved", id: "n1" };
    const r = await send({ endpoint: `http://127.0.0.1:${port}/push/abc`, p256dh: sub.p256dh, auth: sub.authB64 }, payload);
    expect(r).toEqual({ ok: true, status: 201 });
    const got = received.at(-1)!;
    expect(got.headers["content-encoding"]).toBe("aes128gcm");
    expect(got.headers.authorization).toMatch(new RegExp(`^vapid t=[^,]+, k=${vapid.publicKey}$`));
    expect(got.headers.ttl).toBeDefined();
    expect(got.body.toString("utf8")).not.toContain("Venda aprovada"); // nada em texto claro
    const plain = ece.decrypt(got.body, { version: "aes128gcm", privateKey: sub.ecdh, authSecret: sub.authB64 });
    expect(JSON.parse(plain.toString("utf8"))).toEqual(payload);
  });

  it("410/404 = inscrição expirada (sem nova tentativa); 5xx/429 = tentar de novo", async () => {
    const vapid = { ...generateVapidKeys(), subject: "mailto:ops@example.com" };
    const sub = browserSubscription();
    const send = createPushSender(vapid, policy(), ["127.0.0.1"]);
    const target = { endpoint: `http://127.0.0.1:${port}/push/x`, p256dh: sub.p256dh, auth: sub.authB64 };
    const p = { title: "t", body: "b", link: null, kind: "system.test", id: "n2" };
    nextStatus = 410;
    expect(await send(target, p)).toMatchObject({ ok: false, expired: true, retryable: false });
    nextStatus = 503;
    expect(await send(target, p)).toMatchObject({ ok: false, expired: false, retryable: true });
    nextStatus = 201;
  });

  it("endpoint fora dos serviços permitidos ou em rede bloqueada não é contatado", async () => {
    const vapid = { ...generateVapidKeys(), subject: "mailto:ops@example.com" };
    const sub = browserSubscription();
    const before = received.length;
    const send = createPushSender(vapid, policy(), ["fcm.googleapis.com"]);
    expect(await send({ endpoint: `http://127.0.0.1:${port}/push/y`, p256dh: sub.p256dh, auth: sub.authB64 }, { title: "t", body: "b", link: null, kind: "k", id: "i" })).toMatchObject({ ok: false, expired: true });
    // Host permitido pela lista, mas a política anti-SSRF bloqueia o endereço (metadados de nuvem).
    const blocked = createPushSender(vapid, { ...policy(), allowEndpoints: [] }, ["169.254.169.254"]);
    expect(await blocked({ endpoint: "http://169.254.169.254/latest", p256dh: sub.p256dh, auth: sub.authB64 }, { title: "t", body: "b", link: null, kind: "k", id: "i" })).toMatchObject({ ok: false, retryable: false });
    expect(received.length).toBe(before);
    expect(pushEndpointAllowed("https://fcm.googleapis.com/fcm/send/abc", ["fcm.googleapis.com"])).toBe(true);
    expect(pushEndpointAllowed("https://fcm.googleapis.com.evil.test/x", ["fcm.googleapis.com"])).toBe(false);
    expect(pushEndpointAllowed("https://wns2-bl2p.notify.windows.com/w/?token=x", ["notify.windows.com"])).toBe(true);
  });
});
