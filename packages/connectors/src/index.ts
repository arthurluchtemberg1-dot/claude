export * from "./types";
export * from "./checkout/lowify";
export * from "./checkout/canonical";
export * from "./destinations/meta-capi";
export * from "./ads/meta-ads";
export * from "./catalog";

import { canonicalConnector } from "./checkout/canonical";
import { lowifyConnector } from "./checkout/lowify";
import type { CheckoutConnector } from "./types";

/** Conectores de checkout com implementação (os demais do catálogo não recebem webhooks). */
export const CHECKOUT_CONNECTORS: Readonly<Record<string, CheckoutConnector>> = {
  lowify: lowifyConnector,
  custom: canonicalConnector,
};
