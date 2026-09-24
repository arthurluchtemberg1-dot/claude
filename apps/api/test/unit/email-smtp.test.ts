import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmailSender } from "../../src/lib/email";

/** Transporte SMTP real contra um servidor SMTP local (nenhum provedor externo). */

const received: { from: string; to: string[]; raw: string; user?: string }[] = [];
let server: SMTPServer;
let port = 0;

beforeAll(async () => {
  server = new SMTPServer({
    disabledCommands: ["STARTTLS"], // servidor sem TLS: permite validar a recusa em produção
    authOptional: true,
    onAuth(auth, _session, cb) {
      cb(null, { user: auth.username });
    },
    onData(stream, session, cb) {
      let raw = "";
      stream.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      stream.on("end", () => {
        received.push({ from: String(session.envelope.mailFrom && session.envelope.mailFrom.address), to: session.envelope.rcptTo.map((r) => r.address), raw, user: session.user as string | undefined });
        cb();
      });
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("EMAIL_TRANSPORT=smtp", () => {
  it("entrega a mensagem com remetente, destinatário e assunto configurados", async () => {
    const sender = createEmailSender("smtp", () => undefined, false, undefined, { url: `smtp://127.0.0.1:${port}`, from: "Tracker <no-reply@teste.local>", timeoutMs: 3000 });
    await sender.send({ to: "pessoa@teste.local", subject: "Confirme seu e-mail", text: "Link: https://app.teste.local/verificar-email?token=abc", kind: "verify_email" });
    const m = received.at(-1)!;
    expect(m.from).toBe("no-reply@teste.local");
    expect(m.to).toEqual(["pessoa@teste.local"]);
    expect(m.raw).toContain("Subject: Confirme seu e-mail");
    expect(m.raw).toContain("X-Tracker-Kind: verify_email");
  });

  it("em produção recusa SMTP sem TLS (sem STARTTLS disponível não envia)", async () => {
    const before = received.length;
    const sender = createEmailSender("smtp", () => undefined, true, undefined, { url: `smtp://127.0.0.1:${port}`, from: "no-reply@teste.local", timeoutMs: 3000 });
    await expect(sender.send({ to: "pessoa@teste.local", subject: "x", text: "y", kind: "verify_email" })).rejects.toThrow();
    expect(received.length).toBe(before);
  });

  it("configuração: smtp sem URL e transportes de desenvolvimento em produção são recusados", () => {
    expect(() => createEmailSender("smtp", () => undefined, false)).toThrow(/SMTP_URL/);
    expect(() => createEmailSender("log", () => undefined, true)).toThrow(/produção/);
    expect(() => createEmailSender("file", () => undefined, true, "/tmp/x")).toThrow(/produção/);
  });
});
