import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import pg from "pg";
import { migrate } from "../../../packages/db/src/migrate";
import { E2E } from "./env";

export default async function globalSetup() {
  if (!/_e2e$/.test(new URL(E2E.adminDb).pathname)) throw new Error("E2E só roda em banco *_e2e");
  await migrate(E2E.adminDb, () => undefined);
  const c = new pg.Client({ connectionString: E2E.adminDb });
  await c.connect();
  await c.query("truncate public.organizations, iam.users, iam.auth_attempts cascade");
  await c.end();
  rmSync(E2E.outbox, { recursive: true, force: true });
  // SDK compilado servido pela API em /sdk/v1/tracker.js
  execFileSync("pnpm", ["--filter", "@tracker/tracker", "build"], { cwd: E2E.root, stdio: "inherit" });
}
