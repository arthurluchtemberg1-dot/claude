/**
 * Envio de e-mail transacional. Transportes:
 * - "log": grava no log do servidor (somente desenvolvimento; o link aparece no terminal da API).
 * - "memory": armazena em memória (testes).
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

export function createEmailSender(transport: string, log: (obj: Record<string, unknown>, msg: string) => void, isProduction: boolean): EmailSender {
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
