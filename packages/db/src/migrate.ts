import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => {
      const sql = readFileSync(join(dir, f), "utf8");
      return { version: f.slice(0, 4), name: f, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    });
}

/**
 * Aplica migrações pendentes em ordem, cada uma em transação própria, com lock consultivo para evitar
 * execução concorrente. Migração já aplicada com checksum diferente interrompe (reprodutibilidade, R07-11).
 */
export async function migrate(connectionString: string, log: (m: string) => void = console.log): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("select pg_advisory_lock(727274001)");
    await client.query(`create table if not exists public.schema_migrations (
      version text primary key, name text not null, checksum text not null, applied_at timestamptz not null default now())`);
    await client.query("revoke all on public.schema_migrations from public");
    const { rows } = await client.query<{ version: string; checksum: string; name: string }>("select version, checksum, name from public.schema_migrations");
    const done = new Map(rows.map((r) => [r.version, r]));
    for (const m of loadMigrations()) {
      const prev = done.get(m.version);
      if (prev) {
        if (prev.checksum !== m.checksum) {
          throw new Error(`Migração ${m.name} já aplicada com checksum diferente (${prev.checksum.slice(0, 12)} ≠ ${m.checksum.slice(0, 12)}). Crie uma nova migração corretiva.`);
        }
        continue;
      }
      log(`aplicando ${m.name}`);
      await client.query("begin");
      try {
        await client.query(m.sql);
        await client.query("insert into public.schema_migrations (version, name, checksum) values ($1, $2, $3)", [m.version, m.name, m.checksum]);
        await client.query("commit");
        applied.push(m.name);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`Falha ao aplicar ${m.name}: ${(err as Error).message}`, { cause: err });
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(727274001)").catch(() => undefined);
    await client.end();
  }
  return applied;
}

export async function migrationStatus(connectionString: string): Promise<{ name: string; applied: boolean }[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const exists = await client.query("select to_regclass('public.schema_migrations') as t");
    const appliedSet = new Set<string>();
    if (exists.rows[0].t) {
      const { rows } = await client.query<{ version: string }>("select version from public.schema_migrations");
      rows.forEach((r) => appliedSet.add(r.version));
    }
    return loadMigrations().map((m) => ({ name: m.name, applied: appliedSet.has(m.version) }));
  } finally {
    await client.end();
  }
}
