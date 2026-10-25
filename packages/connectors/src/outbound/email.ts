import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import nodemailer from "nodemailer";

/**
 * Envio de e-mail transacional. Transportes:
 * - "log": grava no log do servidor (somente desenvolvimento; o link aparece no terminal da API).
 * - "memory": armazena em memória (testes).
 * - "file": grava JSON em EMAIL_OUTBOX_DIR (somente desenvolvimento/E2E; proibido em produção).
 * - "smtp": qualquer provedor SMTP (SMTP_URL). Em produção exige TLS (smtps:// ou STARTTLS obrigatório).
 * "Produção" aqui é o ambiente de implantação (APP_ENV=production), não o modo de build (NODE_ENV).
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Categoria para testes/diagnóstico (ex.: "verify_email"). */
  kind: string;
  /** Link de ação (não é logado em produção). */
  actionUrl?: string;
}

export interface EmailSender {
  send(msg: EmailMessage): Promise<void>;
  readonly sent?: EmailMessage[];
}

export interface SmtpOptions {
  url: string;
  from: string;
  timeoutMs?: number;
}

export function createEmailSender(
  transport: string,
  log: (obj: Record<string, unknown>, msg: string) => void,
  isProduction: boolean,
  outboxDir?: string,
  smtp?: SmtpOptions,
): EmailSender {
  if (transport === "file") {
    if (isProduction || !outboxDir) throw new Error("EMAIL_TRANSPORT=file exige EMAIL_OUTBOX_DIR e não é permitido em produção");
    mkdirSync(outboxDir, { recursive: true });
    return {
      async send(msg) {
        mkdirSync(outboxDir, { recursive: true });
        writeFileSync(join(outboxDir, `${Date.now()}-${randomUUID()}.json`), JSON.stringify(msg));
      },
    };
  }
  if (transport === "memory") {
    const sent: EmailMessage[] = [];
    return { sent, async send(msg) { sent.push(msg); } };
  }
  if (transport === "log") {
    if (isProduction) throw new Error("EMAIL_TRANSPORT=log não é permitido em produção");
    return {
      async send(msg) {
        log({ kind: msg.kind, subject: msg.subject, actionUrl: msg.actionUrl }, "email (transporte de desenvolvimento)");
      },
    };
  }
  if (transport === "smtp") {
    if (!smtp?.url) throw new Error("EMAIL_TRANSPORT=smtp exige SMTP_URL (ex.: smtps://usuario:senha@smtp.provedor.com:465)");
    const secure = smtp.url.startsWith("smtps://");
    // Um único objeto de opções: com a URL como 1º argumento o nodemailer trataria o 2º como padrões da MENSAGEM
    // (requireTLS e timeouts seriam ignorados — detectado em teste).
    const transporter = nodemailer.createTransport({
      url: smtp.url,
      // Sem TLS implícito, STARTTLS é obrigatório em produção (credenciais e links nunca em texto claro).
      ...(isProduction && !secure ? { requireTLS: true } : {}),
      connectionTimeout: smtp.timeoutMs ?? 10_000,
      greetingTimeout: smtp.timeoutMs ?? 10_000,
      socketTimeout: smtp.timeoutMs ?? 20_000,
    });
    return {
      async send(msg) {
        await transporter.sendMail({ from: smtp.from, to: msg.to, subject: msg.subject, text: msg.text, headers: { "X-Tracker-Kind": msg.kind } });
        log({ kind: msg.kind }, "email_sent");
      },
    };
  }
  throw new Error(`EMAIL_TRANSPORT desconhecido: ${transport}`);
}
