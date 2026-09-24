import { ratio, type Ratio } from "../metrics/ratio";
import type { TouchChannel } from "./classify";

/**
 * Motor de atribuição (seção 16). Função pura e determinística: mesma entrada → mesmo resultado (T33).
 * Aplica a política pela data do toque e pela data real da conversão (R16-03), nunca pela data de recebimento.
 */

export type AttributionModel =
  | "first_touch"
  | "last_touch"
  | "last_non_direct"
  | "first_paid_click"
  | "last_paid_click"
  | "explicit_order"
  | "linear";

export const ATTRIBUTION_MODELS: readonly AttributionModel[] = [
  "first_touch",
  "last_touch",
  "last_non_direct",
  "first_paid_click",
  "last_paid_click",
  "explicit_order",
  "linear",
];

export const MODEL_LABELS: Record<AttributionModel, string> = {
  first_touch: "Primeiro toque conhecido",
  last_touch: "Último toque conhecido",
  last_non_direct: "Último toque não direto",
  first_paid_click: "Primeiro clique pago elegível",
  last_paid_click: "Último clique pago elegível",
  explicit_order: "Atribuição explícita ao pedido",
  linear: "Linear entre toques observáveis (análise, não causal)",
};

/**
 * Hierarquia de evidência (R16-04), da mais forte para a mais fraca.
 * - token_link: token opaco do SDK devolvido pelo checkout e vinculado ao pedido.
 * - checkout_source: origem (UTMs/IDs) retornada pelo checkout no pedido.
 * - session: sessão/visitante persistido pelo SDK, ligado por vínculo válido.
 * - identity: identidade própria fornecida voluntariamente com vínculo comprovado.
 */
export type EvidenceType = "token_link" | "checkout_source" | "session" | "identity";

export const EVIDENCE_RANK: Record<EvidenceType, number> = {
  token_link: 1,
  checkout_source: 2,
  session: 3,
  identity: 4,
};

export interface AttributionTouchpoint {
  readonly id: string;
  readonly occurredAt: Date;
  readonly channel: TouchChannel;
  readonly isPaid: boolean;
  readonly network: string | null;
  readonly evidence: EvidenceType;
  /** IDs de mídia validados no projeto (strings opacas) ou null. */
  readonly campaignId: string | null;
  readonly adsetId: string | null;
  readonly adId: string | null;
  readonly idsValidated: boolean;
  readonly utm: Readonly<{ source: string | null; medium: string | null; campaign: string | null; content: string | null; term: string | null }>;
  /** true quando o dado é declaratório (URL pública/checkout) sem confirmação independente. */
  readonly declared: boolean;
}

export interface AttributionPolicy {
  readonly id: string;
  readonly version: number;
  readonly model: AttributionModel;
  readonly windowDays: number;
}

export const DEFAULT_POLICY: Omit<AttributionPolicy, "id"> = { version: 1, model: "last_paid_click", windowDays: 7 };

export type AttributionCategory = "paid" | "organic" | "direct" | "recovery" | "unattributed";

export type UnattributedReason =
  | "no_touchpoints"
  | "all_outside_window"
  | "no_eligible_paid_click"
  | "no_explicit_link"
  | "only_direct"
  | "conflicting_evidence";

export const UNATTRIBUTED_REASON_LABELS: Record<UnattributedReason, string> = {
  no_touchpoints: "Nenhum toque observado ou vinculado ao pedido",
  all_outside_window: "Toques existentes estão fora da janela da política",
  no_eligible_paid_click: "Nenhum clique pago elegível dentro da janela",
  no_explicit_link: "Sem vínculo técnico explícito entre pedido e origem",
  only_direct: "Somente acessos diretos na janela",
  conflicting_evidence: "Evidências conflitantes de mesma força",
};

export interface Credit {
  readonly touchpointId: string;
  readonly weight: Ratio;
}

export interface AttributionResult {
  readonly model: AttributionModel;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly windowDays: number;
  readonly conversionAt: Date;
  readonly category: AttributionCategory;
  readonly credits: readonly Credit[];
  /** Toque selecionado (modelos de um toque) ou null. */
  readonly selectedTouchpointId: string | null;
  readonly evidence: EvidenceType | null;
  readonly quality: "high" | "medium" | "low" | "none";
  readonly reason: string;
  readonly unattributedReason: UnattributedReason | null;
  /** Caminho observado na janela, em ordem cronológica (R16-09). */
  readonly path: readonly string[];
}

const DAY_MS = 86_400_000;

function sortTouches(t: readonly AttributionTouchpoint[]): AttributionTouchpoint[] {
  return [...t].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function categoryOf(t: AttributionTouchpoint): AttributionCategory {
  if (t.isPaid) return "paid";
  switch (t.channel) {
    case "recovery":
      return "recovery";
    case "direct":
      return "direct";
    case "organic":
    case "social":
    case "referral":
      return "organic";
    default:
      return "organic";
  }
}

function quality(t: AttributionTouchpoint): AttributionResult["quality"] {
  if (t.evidence === "token_link") return t.idsValidated || !t.isPaid ? "high" : "medium";
  if (t.evidence === "checkout_source") return t.idsValidated ? "medium" : "low";
  return "medium";
}

export function attribute(
  policy: AttributionPolicy,
  conversionAt: Date,
  touchpoints: readonly AttributionTouchpoint[],
): AttributionResult {
  const base = {
    model: policy.model,
    policyId: policy.id,
    policyVersion: policy.version,
    windowDays: policy.windowDays,
    conversionAt,
  };
  const all = sortTouches(touchpoints.filter((t) => t.occurredAt.getTime() <= conversionAt.getTime()));
  const windowStart = conversionAt.getTime() - policy.windowDays * DAY_MS;
  const eligible = all.filter((t) => t.occurredAt.getTime() >= windowStart);
  const path = eligible.map((t) => `${t.occurredAt.toISOString()} ${t.channel}${t.isPaid ? "(pago)" : ""} ${t.utm.source ?? ""}/${t.utm.medium ?? ""}`.trim());

  const none = (reason: UnattributedReason, category: AttributionCategory = "unattributed"): AttributionResult => ({
    ...base,
    category,
    credits: [],
    selectedTouchpointId: null,
    evidence: null,
    quality: "none",
    reason: UNATTRIBUTED_REASON_LABELS[reason],
    unattributedReason: reason,
    path,
  });

  const single = (t: AttributionTouchpoint, reason: string): AttributionResult => ({
    ...base,
    category: categoryOf(t),
    credits: [{ touchpointId: t.id, weight: ratio(1n, 1n) }],
    selectedTouchpointId: t.id,
    evidence: t.evidence,
    quality: quality(t),
    reason,
    unattributedReason: null,
    path,
  });

  if (all.length === 0) return none("no_touchpoints");
  if (eligible.length === 0) return none("all_outside_window");

  switch (policy.model) {
    case "first_touch":
      return single(eligible[0]!, "Primeiro toque conhecido dentro da janela");
    case "last_touch":
      return single(eligible[eligible.length - 1]!, "Último toque conhecido dentro da janela");
    case "last_non_direct": {
      const nd = eligible.filter((t) => t.channel !== "direct");
      if (!nd.length) return none("only_direct", "direct");
      return single(nd[nd.length - 1]!, "Último toque não direto dentro da janela");
    }
    case "first_paid_click":
    case "last_paid_click": {
      const paid = eligible.filter((t) => t.isPaid);
      if (!paid.length) {
        // Sem clique pago elegível: classificar pelo caminho observado, sem crédito pago (R16-08).
        const last = eligible[eligible.length - 1]!;
        const cat = categoryOf(last);
        return none(cat === "direct" ? "only_direct" : "no_eligible_paid_click", cat === "paid" ? "unattributed" : cat);
      }
      const t = policy.model === "first_paid_click" ? paid[0]! : paid[paid.length - 1]!;
      return single(
        t,
        policy.model === "first_paid_click" ? "Primeiro clique pago dentro da janela" : "Último clique pago dentro da janela",
      );
    }
    case "explicit_order": {
      const strongest = eligible.filter((t) => t.evidence === "token_link" || t.evidence === "checkout_source");
      if (!strongest.length) return none("no_explicit_link");
      const bestRank = Math.min(...strongest.map((t) => EVIDENCE_RANK[t.evidence]));
      const best = strongest.filter((t) => EVIDENCE_RANK[t.evidence] === bestRank);
      const last = best[best.length - 1]!;
      const conflicting = best.some(
        (t) => t !== last && t.isPaid && last.isPaid && t.campaignId && last.campaignId && t.campaignId !== last.campaignId && t.evidence === "checkout_source",
      );
      if (conflicting) return none("conflicting_evidence");
      return single(last, `Vínculo explícito (${last.evidence}) entre pedido e origem`);
    }
    case "linear": {
      const n = BigInt(eligible.length);
      // Pesos iguais somam exatamente 1 (T41): cada toque recebe 1/n.
      const credits = eligible.map((t) => ({ touchpointId: t.id, weight: ratio(1n, n) }));
      const anyPaid = eligible.some((t) => t.isPaid);
      return {
        ...base,
        category: anyPaid ? "paid" : categoryOf(eligible[eligible.length - 1]!),
        credits,
        selectedTouchpointId: null,
        evidence: eligible.reduce<EvidenceType>(
          (acc, t) => (EVIDENCE_RANK[t.evidence] < EVIDENCE_RANK[acc] ? t.evidence : acc),
          eligible[0]!.evidence,
        ),
        quality: "low",
        reason: `Crédito linear entre ${eligible.length} toque(s) observável(is) — análise adicional, não causal`,
        unattributedReason: null,
        path,
      };
    }
  }
}

/** Soma dos pesos (para verificar invariante de modelos fracionados). */
export function totalWeight(credits: readonly Credit[]): Ratio {
  let num = 0n;
  let den = 1n;
  for (const c of credits) {
    num = num * c.weight.den + c.weight.num * den;
    den = den * c.weight.den;
  }
  const g = gcd(num < 0n ? -num : num, den);
  return g === 0n ? { num: 0n, den: 1n } : { num: num / g, den: den / g };
}

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}
