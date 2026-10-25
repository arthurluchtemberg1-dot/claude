import { sampleAccount, startFakeMeta } from "./fake-meta";

/**
 * Graph API falsa para demonstração local do painel (nunca em produção): `FAKE_META_PORT=4900 tsx test/fake-meta-server.ts`
 * e API/worker com META_GRAPH_BASE_URL=http://127.0.0.1:4900. Token aceito: o valor de FAKE_META_TOKEN.
 */
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
const days = [-1, 0].map((d) => new Date(Date.parse(`${today}T12:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10));
const meta = await startFakeMeta(process.env.META_GRAPH_API_VERSION ?? "v26.0");
meta.accounts.set("act_111", sampleAccount("act_111", days));
meta.tokens.set(process.env.FAKE_META_TOKEN ?? "EAAdemonstracao1234567890abcdef", { permissions: ["ads_read", "ads_management", "business_management"], accounts: ["act_111"], userName: "Sistema (demonstração)" });
console.log(`Graph API falsa em ${meta.url}`);
