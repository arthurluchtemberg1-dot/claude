#!/usr/bin/env node
/**
 * Restauração verificada (R42-05, T69):
 *   node scripts/restore.mjs --url <URL admin do banco DESTINO vazio> --in backups/x.dump
 * Pré-requisitos no cluster de destino: banco criado e vazio; papéis provisionados (`node packages/db/dist/cli.js
 * provision-roles` com DB_APP_PASSWORD/DB_SYSTEM_PASSWORD), pois os GRANTs do dump os referenciam.
 * Confere o sha256 do arquivo, restaura em transação única e compara o manifesto (contagens, somas do razão por
 * organização, migrações e digest das credenciais cifradas). Sai com código 1 em qualquer divergência.
 * Depois: `pnpm db:status` no destino e, se o backup foi exposto, rotacione as credenciais dos provedores.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import pg from "pg";
import { buildManifest, diffManifests, pgEnv } from "./lib/db-manifest.mjs";

const { values } = parseArgs({ options: { url: { type: "string" }, in: { type: "string" } }, args: process.argv.slice(2).filter((a) => a !== "--") });
if (!values.url || !values.in) {
  console.error("Uso: node scripts/restore.mjs --url <URL admin do destino> --in <arquivo.dump>");
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(`${values.in}.manifest.json`, "utf8"));
const sha = createHash("sha256").update(readFileSync(values.in)).digest("hex");
if (sha !== manifest.sha256) {
  console.error("Arquivo de backup não corresponde ao manifesto (sha256 diferente). Restauração abortada.");
  process.exit(1);
}
const probe = new pg.Client({ connectionString: values.url });
await probe.connect();
const used = (await probe.query("select to_regclass('public.schema_migrations') is not null as used")).rows[0].used;
const roles = (await probe.query("select count(*)::int as n from pg_roles where rolname in ('tracker_app', 'tracker_system')")).rows[0].n;
await probe.end();
if (used) {
  console.error("O banco de destino não está vazio. Restaure em um banco novo.");
  process.exit(1);
}
if (roles !== 2) {
  console.error("Papéis tracker_app/tracker_system ausentes no destino: execute provision-roles antes.");
  process.exit(1);
}
execFileSync("pg_restore", ["--exit-on-error", "--single-transaction", "--no-owner", "--dbname", pgEnv(values.url).PGDATABASE, values.in], {
  env: { ...process.env, ...pgEnv(values.url) },
  stdio: ["ignore", "inherit", "inherit"],
});
const after = await buildManifest(values.url);
const diffs = diffManifests(manifest, after);
if (diffs.length) {
  console.error(`Restauração DIVERGENTE:\n- ${diffs.join("\n- ")}`);
  process.exit(1);
}
console.log(`Restauração verificada: ${Object.keys(after.counts).length} tabelas, ${after.ledger.length} grupo(s) do razão, ${after.credentials.count} credencial(is) cifrada(s) idênticos ao backup.`);
