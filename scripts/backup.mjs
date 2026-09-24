#!/usr/bin/env node
/**
 * Backup lógico verificável (R42-05, T69):
 *   node scripts/backup.mjs --url <DATABASE_URL_ADMIN> --out backups/tracker-AAAAMMDD.dump
 * Gera o dump (pg_dump formato custom) e <out>.manifest.json (contagens, somas do razão, digest das credenciais
 * cifradas, sha256 do arquivo). A senha vai por variável de ambiente para o pg_dump, nunca na linha de comando.
 * O dump contém credenciais apenas CIFRADAS; as chaves (CREDENTIALS_KEYS) ficam fora do banco e do backup.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import pg from "pg";
import { buildManifest, pgEnv } from "./lib/db-manifest.mjs";

const { values } = parseArgs({ options: { url: { type: "string" }, out: { type: "string" } }, args: process.argv.slice(2).filter((a) => a !== "--") });
const url = values.url ?? process.env.DATABASE_URL_ADMIN;
if (!url || !values.out) {
  console.error("Uso: node scripts/backup.mjs --url <DATABASE_URL_ADMIN> --out <arquivo.dump>");
  process.exit(2);
}
mkdirSync(dirname(values.out), { recursive: true });
// Manifesto e dump no MESMO snapshot (banco em uso não gera divergência entre os dois).
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query("begin isolation level repeatable read read only");
const snapshot = (await client.query("select pg_export_snapshot() as s")).rows[0].s;
const before = await buildManifest(client);
try {
  execFileSync("pg_dump", ["--format=custom", "--no-owner", `--snapshot=${snapshot}`, "--file", values.out], { env: { ...process.env, ...pgEnv(url) }, stdio: ["ignore", "inherit", "inherit"] });
} finally {
  await client.query("commit");
  await client.end();
}
const sha256 = createHash("sha256").update(readFileSync(values.out)).digest("hex");
const manifest = { format: "tracker-backup/1", created_at: new Date().toISOString(), pg_dump: execFileSync("pg_dump", ["--version"]).toString().trim(), sha256, ...before };
writeFileSync(`${values.out}.manifest.json`, JSON.stringify(manifest, null, 2));
console.log(`Backup: ${values.out} (sha256 ${sha256.slice(0, 16)}…), ${Object.keys(before.counts).length} tabelas, ${before.credentials.count} credencial(is) cifrada(s).`);
