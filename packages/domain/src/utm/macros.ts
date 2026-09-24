/**
 * Catálogo de macros dinâmicas por rede (R14-02).
 *
 * IMPORTANTE: as macros abaixo vêm de conhecimento prévio e DEVEM ser revalidadas na documentação oficial
 * antes de serem marcadas como verificadas (regra R03-01/R03-02). Em 24/09/2026 os domínios oficiais
 * (developers.facebook.com, support.google.com, ads.tiktok.com) estavam bloqueados pelo proxy de rede
 * deste ambiente — ver docs/EXTERNAL_DEPENDENCIES.md (DEP-META-DOCS, DEP-GOOGLE-DOCS, DEP-TIKTOK-DOCS).
 * A interface exibe o selo "a verificar" enquanto `verified` for false.
 */

export interface MacroDefinition {
  readonly token: string;
  readonly description: string;
  /** Tipo de valor produzido: identificador opaco ou nome editável. */
  readonly kind: "id" | "name" | "other";
}

export interface NetworkMacroCatalog {
  readonly network: "meta" | "google" | "tiktok";
  readonly referenceUrl: string;
  readonly verified: boolean;
  readonly verifiedAt: string | null;
  readonly macros: readonly MacroDefinition[];
}

export const MACRO_CATALOGS: readonly NetworkMacroCatalog[] = [
  {
    network: "meta",
    referenceUrl: "https://www.facebook.com/business/help/1016122818401732",
    verified: false,
    verifiedAt: null,
    macros: [
      { token: "{{campaign.id}}", description: "ID da campanha", kind: "id" },
      { token: "{{adset.id}}", description: "ID do conjunto de anúncios", kind: "id" },
      { token: "{{ad.id}}", description: "ID do anúncio", kind: "id" },
      { token: "{{campaign.name}}", description: "Nome da campanha", kind: "name" },
      { token: "{{adset.name}}", description: "Nome do conjunto", kind: "name" },
      { token: "{{ad.name}}", description: "Nome do anúncio", kind: "name" },
      { token: "{{placement}}", description: "Posicionamento", kind: "other" },
      { token: "{{site_source_name}}", description: "Origem do site", kind: "other" },
    ],
  },
  {
    network: "google",
    referenceUrl: "https://support.google.com/google-ads/answer/6305348",
    verified: false,
    verifiedAt: null,
    macros: [
      { token: "{campaignid}", description: "ID da campanha", kind: "id" },
      { token: "{adgroupid}", description: "ID do grupo de anúncios", kind: "id" },
      { token: "{creative}", description: "ID do anúncio", kind: "id" },
      { token: "{keyword}", description: "Palavra-chave", kind: "other" },
      { token: "{network}", description: "Rede", kind: "other" },
      { token: "{device}", description: "Dispositivo", kind: "other" },
    ],
  },
  {
    network: "tiktok",
    referenceUrl: "https://ads.tiktok.com/help/article/track-offsite-web-events-with-url-parameters",
    verified: false,
    verifiedAt: null,
    macros: [
      { token: "__CAMPAIGN_ID__", description: "ID da campanha", kind: "id" },
      { token: "__AID__", description: "ID do grupo de anúncios", kind: "id" },
      { token: "__CID__", description: "ID do anúncio (criativo)", kind: "id" },
      { token: "__CAMPAIGN_NAME__", description: "Nome da campanha", kind: "name" },
      { token: "__AID_NAME__", description: "Nome do grupo", kind: "name" },
      { token: "__CID_NAME__", description: "Nome do anúncio", kind: "name" },
      { token: "__PLACEMENT__", description: "Posicionamento", kind: "other" },
    ],
  },
];

/**
 * Padrões de macro NÃO expandida (T38): `{{...}}`, `{...}` (ValueTrack), `__X__` e `[X]`.
 * Placeholders nunca são aceitos como IDs válidos.
 */
const MACRO_PATTERNS: readonly RegExp[] = [/\{\{[^{}]*\}\}/, /\{[a-z_]+[a-z0-9_:.]*\}/i, /__[A-Z][A-Z0-9_]*__/, /\[[A-Z][A-Z0-9_]*\]/];

export function findUnexpandedMacros(value: string): string[] {
  const found: string[] = [];
  let rest = value;
  for (const re of MACRO_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of rest.matchAll(g)) found.push(m[0]);
    // Remove o que já foi reconhecido para não contar `{{x}}` também como `{x}`.
    rest = rest.replace(g, " ");
  }
  // `%7B%7B` = "{{" codificado: macro não expandida mesmo após codificação.
  if (/%7B%7B|%7Bcampaign|%7Badgroup/i.test(value)) found.push("(macro codificada)");
  return [...new Set(found)];
}

export function hasUnexpandedMacro(value: string | null | undefined): boolean {
  return !!value && findUnexpandedMacros(value).length > 0;
}
