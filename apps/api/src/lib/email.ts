import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Envio de e-mail transacional. Transportes:
 * - "log": grava no log do servidor (somente desenvolvimento; o link aparece no terminal da API).
 * - "memory": armazena em memória (testes).
 * - "file": grava JSON em EMAIL_OUTBOX_DIR (somente desenvolvimento/E2E; proibido em produção).
 * - "smtp": ainda não implementado — requer provedor transacional (DEP-EMAIL). Falha explicitamente.
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

export function createEmailSender(transport: string, log: (obj: Record<string, unknown>, msg: string) => void, isProduction: boolean, outboxDir?: string): EmailSender {
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
  return {
    async send() {
      throw new Error("Transporte SMTP não configurado/implementado (ver docs/EXTERNAL_DEPENDENCIES.md DEP-EMAIL)");
    },
  };
}
