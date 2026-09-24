import { createDecipheriv } from "node:crypto";
import type { PoolClient } from "@tracker/db";

/**
 * Leitura de credenciais no worker (mesmo formato de apps/api/src/lib/crypto.ts: v<ver>.<iv>.<tag>.<ct>, AAD org:conexão:finalidade).
 */
export function parseKeys(env: string): Map<number, Buffer> {
  const keys = new Map<number, Buffer>();
  for (const part of env.split(",")) {
    const [v, k] = part.split(":");
    keys.set(Number(v), Buffer.from(k ?? "", "base64"));
  }
  return keys;
}

export function decrypt(keys: Map<number, Buffer>, ciphertext: string, aad: string): string {
  const [v, iv, tag, ct] = ciphertext.split(".");
  const key = keys.get(Number(v?.slice(1)));
  if (!key || !iv || !tag || ct === undefined) throw new Error("Credencial ilegível");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}

export function createSecretLoader(keysEnv = process.env.CREDENTIALS_KEYS ?? "") {
  const keys = parseKeys(keysEnv);
  return async (c: PoolClient, orgId: string, connectionId: string | null, purpose: string): Promise<string | null> => {
    const r = await c.query(
      `select ciphertext from private.credentials where organization_id = $1 and connection_id is not distinct from $2 and purpose = $3
         and revoked_at is null and rotated_at is null order by created_at desc limit 1`,
      [orgId, connectionId, purpose],
    );
    if (!r.rows[0]) return null;
    return decrypt(keys, r.rows[0].ciphertext, `${orgId}:${connectionId ?? "-"}:${purpose}`);
  };
}
