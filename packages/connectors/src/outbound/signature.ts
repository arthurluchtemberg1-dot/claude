import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Assinatura de webhooks de saída (R33-05):
 *   X-Tracker-Signature: t=<unix>,id=<entrega>,v1=<hex>[,v1=<hex>]
 *   v1 = HMAC-SHA256(segredo, `${t}.${id}.${corpo}`)
 * Durante a rotação de segredo (24 h) o corpo é assinado com o segredo novo e o anterior (dois v1), para o receptor
 * trocar o segredo sem perder entregas. O ID da entrega é estável entre tentativas: use-o para deduplicar.
 */

export const OUTBOUND_SIGNATURE_HEADER = "x-tracker-signature";

export function signOutbound(secrets: readonly string[], deliveryId: string, timestampSeconds: number, body: string): string {
  const macs = secrets.map((s) => createHmac("sha256", s).update(`${timestampSeconds}.${deliveryId}.`).update(body).digest("hex"));
  return [`t=${timestampSeconds}`, `id=${deliveryId}`, ...macs.map((m) => `v1=${m}`)].join(",");
}

/** Verificação para o receptor (exemplo documentado e testado). */
export function verifyOutbound(header: string | undefined, body: string, secret: string, now: Date, toleranceSeconds = 300): { ok: true; id: string } | { ok: false; reason: string } {
  if (!header) return { ok: false, reason: "Assinatura ausente" };
  const parts = header.split(",").map((kv) => {
    const i = kv.indexOf("=");
    return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()] as const;
  });
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const id = parts.find(([k]) => k === "id")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!Number.isInteger(t) || !id || !sigs.length) return { ok: false, reason: "Assinatura malformada" };
  if (Math.abs(now.getTime() / 1000 - t) > toleranceSeconds) return { ok: false, reason: "Fora da janela de tempo" };
  const expected = createHmac("sha256", secret).update(`${t}.${id}.`).update(body).digest();
  for (const s of sigs) {
    if (!/^[0-9a-f]{64}$/.test(s)) continue;
    const got = Buffer.from(s, "hex");
    if (timingSafeEqual(expected, got)) return { ok: true, id };
  }
  return { ok: false, reason: "Assinatura inválida" };
}

/** Proveniência de encaminhamento entre instâncias/entradas do Tracker (R33-07). */
export const HOP_HEADER = "x-tracker-hop";
export const MAX_FORWARD_HOPS = 3;
