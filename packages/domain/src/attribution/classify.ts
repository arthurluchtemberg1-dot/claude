/**
 * Classificação de toques (R16-08) a partir de UTMs, identificadores de clique e referência.
 * Regras conservadoras: `fbclid` sozinho NÃO comprova mídia paga (é anexado também a links orgânicos);
 * identificadores de clique não são decodificados para descobrir anúncios (R16-05).
 */

export type TouchChannel = "paid" | "organic" | "social" | "referral" | "direct" | "recovery" | "unknown";

export type ClickIdKey = "fbclid" | "gclid" | "gbraid" | "wbraid" | "ttclid" | "msclkid";

export const CLICK_ID_KEYS: readonly ClickIdKey[] = ["fbclid", "gclid", "gbraid", "wbraid", "ttclid", "msclkid"];

/** Identificadores que, por definição do produto de anúncios, só aparecem em cliques pagos. */
const PAID_ONLY_CLICK_IDS: ReadonlySet<ClickIdKey> = new Set(["gclid", "gbraid", "wbraid", "msclkid", "ttclid"]);

export const DEFAULT_PAID_MEDIUMS = [
  "cpc",
  "ppc",
  "cpm",
  "cpv",
  "cpa",
  "paid",
  "paid_social",
  "paidsocial",
  "paid-social",
  "social_paid",
  "display",
  "ads",
  "ad",
  "banner",
  "retargeting",
] as const;

export const DEFAULT_RECOVERY_MEDIUMS = ["recovery", "recuperacao", "recuperação", "remarketing_whatsapp"] as const;

const ORGANIC_SOCIAL_MEDIUMS = new Set(["social", "organic_social", "bio", "profile", "story", "stories", "post"]);
const SEARCH_ENGINES = /(^|\.)(google|bing|yahoo|duckduckgo|yandex|baidu|ecosia)\./i;
const SOCIAL_HOSTS = /(^|\.)(facebook|fb|instagram|t\.co|twitter|x|tiktok|youtube|linkedin|pinterest|threads|whatsapp|wa\.me|kwai)\./i;

export interface TouchSignals {
  readonly utmSource?: string | null;
  readonly utmMedium?: string | null;
  readonly utmCampaign?: string | null;
  readonly clickIds?: Partial<Record<ClickIdKey, string>>;
  /** Host de referência externo permitido (sem caminho/consulta). */
  readonly referrerHost?: string | null;
  readonly landingHost?: string | null;
}

export interface ClassifyOptions {
  readonly paidMediums?: readonly string[];
  readonly recoveryMediums?: readonly string[];
}

export interface Classification {
  readonly channel: TouchChannel;
  readonly isPaid: boolean;
  /** Motivo legível da classificação (exibido no diagnóstico/caminho). */
  readonly reason: string;
  readonly network: string | null;
}

function norm(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

export function inferNetwork(signals: TouchSignals): string | null {
  const ids = signals.clickIds ?? {};
  if (ids.gclid || ids.gbraid || ids.wbraid) return "google";
  if (ids.ttclid) return "tiktok";
  if (ids.msclkid) return "microsoft";
  const src = norm(signals.utmSource);
  if (/^(fb|facebook|meta|ig|instagram)$/.test(src) || src.startsWith("facebook") || src.startsWith("instagram")) return "meta";
  if (/^(google|adwords|gads|youtube)$/.test(src)) return "google";
  if (/^(tiktok|tt)$/.test(src)) return "tiktok";
  if (/^(bing|microsoft|msads)$/.test(src)) return "microsoft";
  if (/^(kwai)$/.test(src)) return "kwai";
  if (/^(pinterest)$/.test(src)) return "pinterest";
  if (/^(taboola)$/.test(src)) return "taboola";
  if (/^(outbrain)$/.test(src)) return "outbrain";
  if (ids.fbclid) return "meta";
  return null;
}

export function classifyTouch(signals: TouchSignals, options: ClassifyOptions = {}): Classification {
  const paidMediums = new Set((options.paidMediums ?? DEFAULT_PAID_MEDIUMS).map((m) => m.toLowerCase()));
  const recoveryMediums = new Set((options.recoveryMediums ?? DEFAULT_RECOVERY_MEDIUMS).map((m) => m.toLowerCase()));
  const medium = norm(signals.utmMedium);
  const source = norm(signals.utmSource);
  const network = inferNetwork(signals);
  const ids = signals.clickIds ?? {};

  if (medium && recoveryMediums.has(medium)) {
    return { channel: "recovery", isPaid: false, reason: `utm_medium="${medium}" configurado como recuperação`, network };
  }
  const paidClickId = CLICK_ID_KEYS.find((k) => PAID_ONLY_CLICK_IDS.has(k) && ids[k]);
  if (paidClickId) {
    return { channel: "paid", isPaid: true, reason: `Identificador de clique pago presente (${paidClickId})`, network };
  }
  if (medium && paidMediums.has(medium)) {
    return { channel: "paid", isPaid: true, reason: `utm_medium="${medium}" configurado como mídia paga`, network };
  }
  if (medium && ORGANIC_SOCIAL_MEDIUMS.has(medium)) {
    return { channel: "social", isPaid: false, reason: `utm_medium="${medium}" indica social orgânico`, network };
  }
  if (medium === "organic" || medium === "seo") {
    return { channel: "organic", isPaid: false, reason: `utm_medium="${medium}"`, network };
  }
  if (medium || source) {
    return {
      channel: "unknown",
      isPaid: false,
      reason: `UTMs presentes sem medium reconhecido como pago (source="${source}", medium="${medium}")`,
      network,
    };
  }
  if (ids.fbclid) {
    return {
      channel: "social",
      isPaid: false,
      reason: "Somente fbclid: não comprova mídia paga (também aparece em links orgânicos)",
      network: "meta",
    };
  }
  const ref = norm(signals.referrerHost);
  if (ref && ref !== norm(signals.landingHost)) {
    if (SEARCH_ENGINES.test(ref)) return { channel: "organic", isPaid: false, reason: `Referência de buscador (${ref})`, network: null };
    if (SOCIAL_HOSTS.test(ref)) return { channel: "social", isPaid: false, reason: `Referência de rede social (${ref})`, network: null };
    return { channel: "referral", isPaid: false, reason: `Referência externa (${ref})`, network: null };
  }
  return { channel: "direct", isPaid: false, reason: "Sem UTMs, identificadores de clique ou referência externa", network: null };
}
