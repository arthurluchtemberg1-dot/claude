/**
 * Manifesto de verificação de backup (T69, R42-05): o que precisa ser idêntico após restaurar.
 * Não contém dados pessoais nem segredos: contagens, somas do razão por organização e um digest das credenciais
 * CIFRADAS (prova que o material cifrado foi preservado sem revelá-lo; as chaves ficam fora do banco).
 */
import { createHash } from "node:crypto";
import pg from "pg";

export function pgEnv(url) {
  const u = new URL(url);
  return {
    PGHOST: decodeURIComponent(u.hostname),
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")),
    ...(u.searchParams.get("sslmode") ? { PGSSLMODE: u.searchParams.get("sslmode") } : {}),
  };
}

/** Manifesto de um banco (URL) ou de um cliente já em transação (snapshot compartilhado com o pg_dump). */
export async function buildManifest(urlOrClient) {
  const own = typeof urlOrClient === "string";
  const client = own ? new pg.Client({ connectionString: urlOrClient }) : urlOrClient;
  if (own) await client.connect();
  try {
    const migrations = (await client.query("select version, checksum from public.schema_migrations order by version")).rows;
    const tables = (
      await client.query(
        `select n.nspname as schema, c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind = 'r' and n.nspname in ('public', 'iam', 'private', 'app') order by 1, 2`,
      )
    ).rows;
    const counts = {};
    for (const t of tables) {
      const r = await client.query(`select count(*)::bigint as n from ${client.escapeIdentifier(t.schema)}.${client.escapeIdentifier(t.name)}`);
      counts[`${t.schema}.${t.name}`] = String(r.rows[0].n);
    }
    const ledger = (
      await client.query(
        `select organization_id, trim(currency) as currency, entry_type, sum(amount_minor)::text as sum, count(*)::int as n
           from public.financial_entries group by 1, 2, 3 order by 1, 2, 3`,
      )
    ).rows;
    const orders = (await client.query("select organization_id, financial_status, count(*)::int as n, sum(approved_minor)::text as approved from public.orders group by 1, 2 order by 1, 2")).rows;
    const creds = (await client.query("select id, ciphertext from private.credentials order by id")).rows;
    const credentialsDigest = createHash("sha256").update(creds.map((c) => `${c.id}:${c.ciphertext}`).join("\n")).digest("hex");
    return { migrations, counts, ledger, orders, credentials: { count: creds.length, digest: credentialsDigest } };
  } finally {
    if (own) await client.end();
  }
}

/** Diferenças entre dois manifestos (vazio = restauração fiel). */
export function diffManifests(a, b) {
  const diffs = [];
  const cmp = (label, x, y) => {
    if (JSON.stringify(x) !== JSON.stringify(y)) diffs.push(label);
  };
  cmp("migrações", a.migrations, b.migrations);
  for (const k of new Set([...Object.keys(a.counts), ...Object.keys(b.counts)])) if (a.counts[k] !== b.counts[k]) diffs.push(`linhas em ${k}: ${a.counts[k]} ≠ ${b.counts[k]}`);
  cmp("somas do razão por organização", a.ledger, b.ledger);
  cmp("pedidos por status", a.orders, b.orders);
  cmp("credenciais cifradas", a.credentials, b.credentials);
  return diffs;
}
