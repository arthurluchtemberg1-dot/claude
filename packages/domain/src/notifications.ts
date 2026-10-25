import { formatMoney } from "./money";
import type { Permission } from "./permissions";
import { toZonedParts } from "./time";

/**
 * Central de notificações (R34-01..R34-04). Regras do domínio:
 * - cada notificação nasce de um fato semântico (chave estável) e é deduplicada por destinatário;
 * - o conteúdo nunca traz dados pessoais do comprador (nome, e-mail, telefone, documento): só valor, produto,
 *   projeto e origem — seguro para tela bloqueada (R34-04);
 * - canais externos (e-mail, push) respeitam preferências e horário silencioso; o painel sempre registra;
 * - falha de entrega nunca interfere no registro da venda (a notificação é efeito derivado, via outbox).
 */

export const NOTIFICATION_CHANNELS = ["in_app", "email", "push"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export type NotificationSeverity = "info" | "success" | "warning" | "critical";

export interface NotificationKindDef {
  label: string;
  description: string;
  severity: NotificationSeverity;
  /** Permissão mínima para receber (quem não vê vendas não recebe venda). */
  permission: Permission;
  defaults: Record<NotificationChannel, boolean>;
  /** "active" = emitido hoje; "planned" = depende de módulo/integração ainda indisponível (estado visível). */
  availability: "active" | "planned";
  unavailableReason?: string;
  /** Tipos de venda tocam o som opcional no painel. */
  sound?: boolean;
}

export const NOTIFICATION_KINDS = {
  "sale.approved": {
    label: "Venda aprovada",
    description: "Pagamento aprovado confirmado pela fonte financeira (inclui upsell e renovação).",
    severity: "success",
    permission: "metrics.read",
    defaults: { in_app: true, email: false, push: true },
    availability: "active",
    sound: true,
  },
  "sale.refunded": {
    label: "Reembolso",
    description: "Reembolso total ou parcial registrado pelo checkout.",
    severity: "warning",
    permission: "metrics.read",
    defaults: { in_app: true, email: false, push: true },
    availability: "active",
  },
  "sale.chargeback": {
    label: "Chargeback",
    description: "Contestação registrada pelo meio de pagamento.",
    severity: "critical",
    permission: "metrics.read",
    defaults: { in_app: true, email: true, push: true },
    availability: "active",
  },
  "connection.stale": {
    label: "Integração sem eventos",
    description: "Conexão que vinha recebendo eventos ficou sem recebimentos pelo período configurado, ou passou a falhar.",
    severity: "critical",
    permission: "provider.connect",
    defaults: { in_app: true, email: true, push: true },
    availability: "active",
  },
  "destination.failed": {
    label: "Falha de envio de conversão",
    description: "Envio a um destino de conversão (ex.: Meta CAPI) rejeitado ou esgotado após as tentativas.",
    severity: "warning",
    permission: "pixel.configure",
    defaults: { in_app: true, email: true, push: false },
    availability: "active",
  },
  "webhook_out.failed": {
    label: "Webhook de saída com falha",
    description: "Entrega de webhook de saída foi para a fila de falhas.",
    severity: "warning",
    permission: "api.manage",
    defaults: { in_app: true, email: true, push: false },
    availability: "active",
  },
  "queue.delayed": {
    label: "Processamento atrasado",
    description: "Itens aguardando processamento além do limite configurado (worker parado ou sobrecarregado).",
    severity: "critical",
    permission: "provider.connect",
    defaults: { in_app: true, email: true, push: true },
    availability: "active",
  },
  "rule.triggered": {
    label: "Regra disparada",
    description: "Uma regra ativa encontrou condições atendidas e executou (ou simulou) sua ação.",
    severity: "info",
    permission: "metrics.read",
    defaults: { in_app: true, email: false, push: true },
    availability: "active",
  },
  "balance.low": {
    label: "Limite de gasto da conta perto do fim",
    description: "Conta de anúncios com limite de gasto (spend cap) definido e pouco valor restante. Saldo pré-pago não é lido: ausência de dado nunca vira saldo zero.",
    severity: "warning",
    permission: "metrics.read",
    defaults: { in_app: true, email: true, push: true },
    availability: "active",
  },
  "ad_account.issue": {
    label: "Conta de anúncios com problema",
    description: "A Meta informou que a conta de anúncios não está ativa (desativada, pagamento pendente, em análise etc.).",
    severity: "critical",
    permission: "metrics.read",
    defaults: { in_app: true, email: true, push: true },
    availability: "active",
  },
  "token.expiring": {
    label: "Acesso a integração perdido",
    description: "Token de integração (ex.: Meta) inválido, expirado ou revogado: a sincronização parou até reconectar.",
    severity: "critical",
    permission: "provider.connect",
    defaults: { in_app: true, email: true, push: true },
    availability: "active",
  },
  "billing.notice": {
    label: "Cobrança do SaaS",
    description: "Avisos de assinatura e pagamento da plataforma.",
    severity: "info",
    permission: "billing.access",
    defaults: { in_app: true, email: true, push: false },
    availability: "planned",
    unavailableReason: "Cobrança do SaaS ainda não implementada (DEP-BILLING); desligada no modo de uso interno.",
  },
  "system.test": {
    label: "Teste de notificação",
    description: "Disparada manualmente para verificar os canais deste dispositivo.",
    severity: "info",
    permission: "metrics.read",
    defaults: { in_app: true, email: true, push: true },
    availability: "active",
  },
} as const satisfies Record<string, NotificationKindDef>;

export type NotificationKind = keyof typeof NOTIFICATION_KINDS;

export function isNotificationKind(v: unknown): v is NotificationKind {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(NOTIFICATION_KINDS, v);
}

export interface NotificationPreferences {
  /** Canais por tipo; ausência = padrão do tipo. */
  kinds: Partial<Record<NotificationKind, Partial<Record<NotificationChannel, boolean>>>>;
  /** Projetos de interesse; vazio = todos os projetos acessíveis. */
  projectIds: string[];
  /** Horário silencioso local "HH:MM" (início/fim; pode atravessar a meia-noite); null = desligado. */
  quietStart: string | null;
  quietEnd: string | null;
  soundEnabled: boolean;
  /** 0–100. */
  soundVolume: number;
  /** Oculta valores no push/e-mail (tela bloqueada); o painel continua mostrando. */
  hideAmounts: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  kinds: {},
  projectIds: [],
  quietStart: null,
  quietEnd: null,
  soundEnabled: false,
  soundVolume: 60,
  hideAmounts: false,
};

export function channelEnabled(prefs: NotificationPreferences, kind: NotificationKind, channel: NotificationChannel): boolean {
  // Testes manuais sempre chegam ao canal escolhido (é o objetivo do teste).
  if (kind === "system.test") return true;
  const own = prefs.kinds[kind]?.[channel];
  return own ?? NOTIFICATION_KINDS[kind].defaults[channel];
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export function isValidHhMm(v: string): boolean {
  return HHMM.test(v);
}

/** Verdadeiro se o instante cai no horário silencioso (no fuso informado). Intervalo [início, fim). */
export function inQuietHours(instant: Date, timeZone: string, start: string | null, end: string | null): boolean {
  if (!start || !end || !HHMM.test(start) || !HHMM.test(end) || start === end) return false;
  const p = toZonedParts(instant, timeZone);
  const now = p.hour * 60 + p.minute;
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const s = toMin(start);
  const e = toMin(end);
  return s < e ? now >= s && now < e : now >= s || now < e;
}

/** Fato que origina a notificação. Somente dados não pessoais. */
export interface SaleFact {
  kind: "sale.approved" | "sale.refunded" | "sale.chargeback";
  amountMinor: bigint;
  currency: string;
  productName: string | null;
  projectName: string | null;
  /** Origem atribuída legível (ex.: "Meta · Campanha X") ou null = sem atribuição ainda. */
  origin: string | null;
  isTest: boolean;
  /** "renewal" | "upsell" | "first" */
  saleType: "first" | "renewal" | "upsell";
  partial?: boolean;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Remove caracteres de controle e limita tamanho (nomes vêm de fontes externas; tratados só como texto). */
export function safeLabel(s: string | null | undefined, n = 80): string | null {
  if (!s) return null;
  // Caracteres de controle viram espaço (sem regex de controle: regra no-control-regex).
  const t = Array.from(s, (ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch)).join("").replace(/\s+/g, " ").trim();
  return t ? clip(t, n) : null;
}

export function saleNotificationText(f: SaleFact, opts: { hideAmounts?: boolean } = {}): { title: string; body: string } {
  const amount = opts.hideAmounts ? null : formatMoney({ amountMinor: f.amountMinor, currency: f.currency });
  const prefix = f.isTest ? "[teste] " : "";
  const title =
    f.kind === "sale.approved"
      ? `${prefix}${f.saleType === "renewal" ? "Renovação aprovada" : f.saleType === "upsell" ? "Upsell aprovado" : "Venda aprovada"}${amount ? ` · ${amount}` : ""}`
      : f.kind === "sale.refunded"
        ? `${prefix}${f.partial ? "Reembolso parcial" : "Reembolso"}${amount ? ` · ${amount}` : ""}`
        : `${prefix}Chargeback${amount ? ` · ${amount}` : ""}`;
  const parts = [safeLabel(f.productName, 60), safeLabel(f.projectName, 40), f.kind === "sale.approved" ? (safeLabel(f.origin, 80) ?? "origem ainda não atribuída") : null].filter(Boolean);
  return { title, body: parts.join(" · ") };
}

export function notificationLabel(kind: string): string {
  return isNotificationKind(kind) ? NOTIFICATION_KINDS[kind].label : kind;
}

/** Tipos que tocam o som opcional de venda no painel. */
export function notificationPlaysSound(kind: string): boolean {
  if (!isNotificationKind(kind)) return false;
  const d: NotificationKindDef = NOTIFICATION_KINDS[kind];
  return d.sound === true;
}
