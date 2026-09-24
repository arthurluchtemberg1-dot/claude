import { defineConfig } from "@playwright/test";
import { E2E } from "./e2e/env";

/**
 * E2E real: API, worker (BullMQ/Redis) e painel em portas próprias, banco dedicado tracker_e2e.
 * Nenhuma chamada externa: o checkout Lowify é simulado com o payload documentado (não é homologação da Lowify).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: E2E.webUrl,
    trace: "retain-on-failure",
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" },
  },
  webServer: [
    {
      command: "pnpm --filter @tracker/api exec tsx src/server.ts",
      url: `${E2E.apiUrl}/health`,
      env: E2E.apiEnv,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "pnpm --filter @tracker/worker exec tsx src/main.ts",
      url: `http://127.0.0.1:${E2E.workerHealthPort}/health`,
      env: E2E.workerEnv,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `pnpm exec next build && pnpm exec next start -p ${E2E.webPort}`,
      url: `${E2E.webUrl}/entrar`,
      // NODE_ENV do .env (development) quebra o build de produção; força production para o painel.
      env: { API_INTERNAL_URL: E2E.apiUrl, NEXT_TELEMETRY_DISABLED: "1", NODE_ENV: "production" },
      reuseExistingServer: false,
      timeout: 300_000,
    },
  ],
});
