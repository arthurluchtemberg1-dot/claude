/** Identidade centralizada (R01-05): nome, cores e textos comerciais alteráveis por configuração. */
export const BRAND = {
  name: process.env.NEXT_PUBLIC_BRAND_NAME ?? "Tracker",
  tagline: "Vendas confirmadas, origem com evidência e resultado com custos conhecidos.",
  supportEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "suporte@example.com",
};
