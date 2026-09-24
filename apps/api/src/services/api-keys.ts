import { randomToken } from "../lib/crypto";

/**
 * Chaves da API pública (R33-01): `tk_live_<prefixo>_<segredo>` (produção) ou `tk_test_…` (sandbox, somente dados de
 * teste). Guardamos apenas o HMAC da chave e o prefixo para exibição; o valor aparece uma única vez na criação.
 */

export const API_SCOPES = ["metrics:read", "orders:read", "orders:write", "products:read", "campaigns:read", "integrations:read"] as const;
export type ApiScope = (typeof API_SCOPES)[number];
/** Escopos que agregam dados de produção: indisponíveis para chaves sandbox. */
export const PRODUCTION_ONLY_SCOPES: readonly ApiScope[] = ["metrics:read", "campaigns:read"];

export const API_KEY_RE = /^tk_(live|test)_[A-Za-z0-9]{8}_[A-Za-z0-9]{40}$/;

export function generateApiKey(environment: "production" | "sandbox"): { key: string; prefix: string } {
  const kind = environment === "sandbox" ? "test" : "live";
  const prefix = `tk_${kind}_${randomToken(8)}`;
  return { key: `${prefix}_${randomToken(40)}`, prefix };
}

export interface ApiKeyContext {
  id: string;
  organizationId: string;
  scopes: ReadonlySet<ApiScope>;
  /** null = todos os projetos da organização. */
  projectIds: string[] | null;
  environment: "production" | "sandbox";
}
