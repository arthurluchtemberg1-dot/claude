import type { PoolClient } from "@tracker/db";
import type { AppConfig } from "../lib/config";
import { decryptSecret, encryptSecret } from "../lib/crypto";

/**
 * Cofre de credenciais por conexão (R41-03, R40-05). Somente o papel tracker_system acessa private.credentials.
 * AAD vincula cada valor à organização, conexão e finalidade: um ciphertext copiado para outra linha não decifra.
 */

export type CredentialPurpose = "webhook_secret" | "oauth_access_token" | "oauth_refresh_token" | "api_key" | "capi_access_token" | "outbound_signing_secret";

const aad = (orgId: string, connectionId: string | null, purpose: string) => `${orgId}:${connectionId ?? "-"}:${purpose}`;

export async function storeCredential(
  c: PoolClient,
  config: AppConfig,
  input: { organizationId: string; connectionId: string | null; purpose: CredentialPurpose; value: string; expiresAt?: Date | null },
): Promise<string> {
  const enc = encryptSecret({ keys: config.credentialKeys, current: config.CREDENTIALS_KEY_CURRENT }, input.value, aad(input.organizationId, input.connectionId, input.purpose));
  // A credencial anterior fica marcada como rotacionada (aceita durante a janela de transição, quando aplicável).
  await c.query(
    "update private.credentials set rotated_at = now() where organization_id = $1 and connection_id is not distinct from $2 and purpose = $3 and revoked_at is null and rotated_at is null",
    [input.organizationId, input.connectionId, input.purpose],
  );
  const r = await c.query(
    "insert into private.credentials (organization_id, connection_id, purpose, ciphertext, key_version, expires_at) values ($1, $2, $3, $4, $5, $6) returning id",
    [input.organizationId, input.connectionId, input.purpose, enc.ciphertext, enc.keyVersion, input.expiresAt ?? null],
  );
  return r.rows[0].id as string;
}

/**
 * Retorna a credencial atual e, se existir, a anterior ainda dentro da janela de transição.
 */
export async function loadCredential(
  c: PoolClient,
  config: AppConfig,
  input: { organizationId: string; connectionId: string | null; purpose: CredentialPurpose; transitionHours?: number },
): Promise<{ current: string | null; previous: string | null }> {
  const r = await c.query(
    `select ciphertext, rotated_at from private.credentials
      where organization_id = $1 and connection_id is not distinct from $2 and purpose = $3 and revoked_at is null
        and (rotated_at is null or rotated_at > now() - make_interval(hours => $4))
      order by created_at desc limit 2`,
    [input.organizationId, input.connectionId, input.purpose, input.transitionHours ?? 24],
  );
  const keys = { keys: config.credentialKeys, current: config.CREDENTIALS_KEY_CURRENT };
  const dec = (ct: string) => decryptSecret(keys, ct, aad(input.organizationId, input.connectionId, input.purpose));
  const current = r.rows.find((x) => !x.rotated_at);
  const previous = r.rows.find((x) => x.rotated_at);
  return { current: current ? dec(current.ciphertext) : null, previous: previous ? dec(previous.ciphertext) : null };
}

export async function revokeCredentials(c: PoolClient, organizationId: string, connectionId: string) {
  await c.query("update private.credentials set revoked_at = now() where organization_id = $1 and connection_id = $2 and revoked_at is null", [organizationId, connectionId]);
}

// ---------------------------------------------------------------- segredos de webhooks de saída

const subAad = (orgId: string, subscriptionId: string) => `${orgId}:sub:${subscriptionId}:outbound_signing_secret`;

/** Grava novo segredo de assinatura; o anterior fica válido por 24 h (dupla assinatura na transição). */
export async function storeSubscriptionSecret(c: PoolClient, config: AppConfig, orgId: string, subscriptionId: string, value: string) {
  const enc = encryptSecret({ keys: config.credentialKeys, current: config.CREDENTIALS_KEY_CURRENT }, value, subAad(orgId, subscriptionId));
  await c.query(
    "update private.credentials set rotated_at = now() where organization_id = $1 and subscription_id = $2 and purpose = 'outbound_signing_secret' and revoked_at is null and rotated_at is null",
    [orgId, subscriptionId],
  );
  await c.query(
    "insert into private.credentials (organization_id, subscription_id, purpose, ciphertext, key_version) values ($1, $2, 'outbound_signing_secret', $3, $4)",
    [orgId, subscriptionId, enc.ciphertext, enc.keyVersion],
  );
}

/** Segredos válidos para assinar: atual primeiro e, durante a transição, o anterior. */
export async function loadSubscriptionSecrets(c: PoolClient, config: AppConfig, orgId: string, subscriptionId: string, transitionHours = 24): Promise<string[]> {
  const r = await c.query(
    `select ciphertext, rotated_at from private.credentials
      where organization_id = $1 and subscription_id = $2 and purpose = 'outbound_signing_secret' and revoked_at is null
        and (rotated_at is null or rotated_at > now() - make_interval(hours => $3))
      order by (rotated_at is null) desc, created_at desc limit 2`,
    [orgId, subscriptionId, transitionHours],
  );
  const keys = { keys: config.credentialKeys, current: config.CREDENTIALS_KEY_CURRENT };
  return r.rows.map((x) => decryptSecret(keys, x.ciphertext, subAad(orgId, subscriptionId)));
}
