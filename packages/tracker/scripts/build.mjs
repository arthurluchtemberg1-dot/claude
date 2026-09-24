import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
mkdirSync(join(root, "dist"), { recursive: true });
await build({
  entryPoints: [join(root, "src/browser.ts")],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2019"],
  outfile: join(root, "dist/tracker.min.js"),
  legalComments: "none",
  banner: { js: `/* Tracker SDK v${pkg.version} */` },
});
const code = readFileSync(join(root, "dist/tracker.min.js"));
const gz = gzipSync(code).length;
// Orçamento de tamanho (R13-24): falha o build se exceder.
const BUDGET_GZIP = 6 * 1024;
const report = { version: pkg.version, bytes: code.length, gzip_bytes: gz, budget_gzip_bytes: BUDGET_GZIP, built_at: new Date().toISOString() };
writeFileSync(join(root, "dist/size.json"), JSON.stringify(report, null, 2));
console.log(`tracker.min.js: ${code.length} bytes (${gz} gzip) — orçamento ${BUDGET_GZIP} gzip`);
if (gz > BUDGET_GZIP) {
  console.error("Orçamento de tamanho excedido");
  process.exit(1);
}
