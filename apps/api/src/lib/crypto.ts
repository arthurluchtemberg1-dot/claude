import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Primitivas criptográficas: tokens opacos, hash de tokens (HMAC), cifragem de credenciais (AES-256-GCM
 * com versão de chave, R40-05), hash de senha (scrypt) e TOTP (RFC 6238) para MFA.
 */

const ALPHANUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Token aleatório alfanumérico sem viés (rejeição de amostras). */
export function randomToken(length: number): string {
  let out = "";
  while (out.length < length) {
    const bytes = randomBytes(length * 2);
    for (const b of bytes) {
      if (b < 248) out += ALPHANUM[b % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

export function hmacToken(key: Buffer, token: string): Buffer {
  return createHmac("sha256", key).update(token).digest();
}

export function tokenHint(token: string): string {
  return token.slice(-4);
}

// ---------------------------------------------------------------- credenciais

export interface CipherKeys {
  keys: Map<number, Buffer>;
  current: number;
}

/** Formato: v<versão>.<iv b64>.<tag b64>.<ciphertext b64>; AAD vincula o valor à organização e finalidade. */
export function encryptSecret(k: CipherKeys, plaintext: string, aad: string): { ciphertext: string; keyVersion: number } {
  const key = k.keys.get(k.current)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: `v${k.current}.${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`, keyVersion: k.current };
}

export function decryptSecret(k: CipherKeys, ciphertext: string, aad: string): string {
  const [v, ivB64, tagB64, ctB64] = ciphertext.split(".");
  const version = Number(v?.slice(1));
  const key = k.keys.get(version);
  if (!key || !ivB64 || !tagB64 || ctB64 === undefined) throw new Error("Credencial ilegível ou chave indisponível");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------- senhas

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password.normalize("NFKC"), salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, keyB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const key = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Hash fictício para igualar tempo de resposta quando o usuário não existe. */
export const DUMMY_PASSWORD_HASH = "scrypt$32768$8$1$c2FsdHNhbHRzYWx0c2FsdA==$9f3xXw9m2c6cOq5l4b3nZq6o7m8k9j0h1g2f3e4d5cA=";

// ---------------------------------------------------------------- TOTP (RFC 6238, SHA-1, 30 s, 6 dígitos)

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("base32 inválido");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpAt(secretB32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secretB32)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  const code = ((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
  return code;
}

export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 30_000);
}

/** Verifica código com tolerância de ±1 passo e impede reutilização do mesmo passo. */
export function verifyTotp(secretB32: string, code: string, now: Date, lastUsedStep: number | null): { ok: true; step: number } | { ok: false } {
  if (!/^\d{6}$/.test(code)) return { ok: false };
  const current = totpStep(now);
  for (const step of [current - 1, current, current + 1]) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    const expected = totpAt(secretB32, step);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return { ok: true, step };
  }
  return { ok: false };
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}
