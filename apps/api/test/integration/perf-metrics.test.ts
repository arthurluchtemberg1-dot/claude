import { appendFileSync } from "node:fs";
import { signCanonicalBody } from "@tracker/connectors";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drainOutbox } from "@tracker/worker";
import { createConnection, createHarness, createOrg, postWebhook, signupVerified, type Client, type Harness } from "../helpers";

/**
 * Desempenho das leituras de métricas (achado do teste de carga: resumo com p50 ~10 s para ~2.000 pedidos).
 * Opcional por ser mais lento: PERF=1 pnpm vitest run --project integration apps/api/test/integration/perf-metrics.test.ts
 */
const N = Number(process.env.PERF_ORDERS ?? 2000);
const report = (line: string) => (process.env.PERF_OUT ? appendFileSync(process.env.PERF_OUT, `${line}\n`) : console.log(line));

describe.skipIf(!process.env.PERF)(`leituras de métricas com ${N} pedidos`, () => {
  let h: Harness;
  let c: Client;
  let day = "";
  beforeAll(async () => {
    h = await createHarness({ WEBHOOK_RATE_LIMIT_PER_MINUTE: "100000" });
    const u = await signupVerified(h, "perf");
    c = u.client;
    const { projectId } = await createOrg(c, "Perf Org");
    const conn = await createConnection(c, projectId, "custom");
    const now = Date.now();
    for (let i = 0; i < N; i++) {
      const raw = JSON.stringify({
        schema_version: "1.0",
        source: { provider: "perf", event_id: `evt-perf-${i}` },
        event_type: "payment.approved",
        occurred_at: new Date(now - (i % 3600) * 1000).toISOString(),
        order: { external_order_id: `perf-${i}`, currency: "BRL", amount_minor: 1000 + (i % 50) * 100 },
        attribution: { utm_source: i % 3 ? "facebook" : "google", utm_medium: i % 3 ? "paid_social" : "cpc", utm_campaign: `C${i % 10}|${120000000000000 + (i % 10)}` },
        customer: { email: `c${i % 700}@perf.test` },
      });
      await postWebhook(h, conn.token, raw, { "x-tracker-signature": signCanonicalBody(conn.signing_secret, raw, Math.floor(h.clock.now.getTime() / 1000)) });
    }
    await drainOutbox(h.worker, { maxRounds: 1000 });
    h.clock.now = new Date(Date.now() + 1000);
    day = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
    const n = (await h.admin.query("select count(*)::int as n from public.orders where external_order_id like 'perf-%' and financial_status = 'approved'")).rows[0].n;
    report(`pedidos processados: ${n}`);
    expect(n).toBe(N);
  }, 600_000);
  afterAll(async () => h?.close());

  it.each(["approval", "financial_movement", "acquisition_cohort"])("resumo (%s) abaixo de 500 ms", async (basis) => {
    const times: number[] = [];
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      const r = await c.req("GET", `/v1/metrics/summary?from=${day}&to=${day}&basis=${basis}`);
      times.push(performance.now() - t0);
      expect(r.statusCode).toBe(200);
    }
    report(`resumo ${basis}: ${times.map((t) => t.toFixed(0)).join(" / ")} ms`);
    expect(Math.min(...times)).toBeLessThan(500);
  });

  it("campanhas e série abaixo de 500 ms", async () => {
    for (const url of [`/v1/reports/breakdown?dimension=campaign&from=${day}&to=${day}`, `/v1/metrics/timeseries?from=${day}&to=${day}`, `/v1/attribution/compare?from=${day}&to=${day}`]) {
      const t0 = performance.now();
      expect((await c.req("GET", url)).statusCode).toBe(200);
      const ms = performance.now() - t0;
      report(`${url.split("?")[0]}: ${ms.toFixed(0)} ms`);
      expect(ms).toBeLessThan(500);
    }
  });
});
