#!/usr/bin/env node
/**
 * Empacota um app Node (API/worker) com esbuild: pacotes do workspace (@tracker/*, TypeScript fonte) são embutidos;
 * dependências de terceiros permanecem externas (instaladas via pnpm no ambiente de execução).
 * Uso: node ../../scripts/bundle.mjs src/server.ts dist/server.js
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const [entry, outfile] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
const external = Object.keys({ ...pkg.dependencies }).filter((d) => !d.startsWith("@tracker/"));
// Dependências de terceiros usadas só pelos pacotes internos (ex.: zod no worker) são embutidas no bundle,
// pois o pnpm não as expõe ao app; apenas dependências diretas do app ficam externas.
await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", target: "node22", outfile, sourcemap: true, external, banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
console.log(`${outfile} (externos: ${external.join(", ")})`);
