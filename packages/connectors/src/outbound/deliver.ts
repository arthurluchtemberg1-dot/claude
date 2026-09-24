import { safeRequest, type SafeHttpPolicy, type SafeResponse } from "./safe-http";
import { HOP_HEADER, signOutbound } from "./signature";

/** Uma tentativa HTTP assinada (usada pelo worker e pelo teste explícito da API). */
export async function postSignedWebhook(
  policy: SafeHttpPolicy,
  target: { url: string; deliveryId: string; eventType: string; hop: number; payload: unknown; secrets: readonly string[] },
  now: Date,
): Promise<SafeResponse> {
  const body = JSON.stringify(target.payload);
  const t = Math.floor(now.getTime() / 1000);
  return safeRequest(
    {
      url: target.url,
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-tracker-signature": signOutbound(target.secrets, target.deliveryId, t, body),
        "x-tracker-webhook-id": target.deliveryId,
        "x-tracker-event": target.eventType,
        [HOP_HEADER]: String(target.hop),
      },
    },
    policy,
  );
}
