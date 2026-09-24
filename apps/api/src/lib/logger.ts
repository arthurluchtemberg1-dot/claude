import pino from "pino";

/**
 * Logs estruturados com remoção de dados sensíveis (R05-09, R40-13). Tokens de URL de webhook são
 * mascarados no próprio serializer de requisição (R09-21).
 */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers[\"x-tracker-signature\"]",
  "res.headers[\"set-cookie\"]",
  "password",
  "*.password",
  "token",
  "*.token",
  "secret",
  "*.secret",
  "access_token",
  "*.access_token",
  "email",
  "*.email",
  "phone",
  "*.phone",
];

export function maskUrl(url: string): string {
  return url
    .replace(/\/(webhooks|w)\/[A-Za-z0-9_]+/g, "/$1/[redigido]")
    .replace(/([?&](token|access_token|code|state|invite|key)=)[^&]+/gi, "$1[redigido]");
}

export function createLogger(level: string) {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: "[redigido]" },
    base: { service: "tracker-api" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
