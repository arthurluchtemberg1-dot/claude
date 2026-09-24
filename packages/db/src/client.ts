import pg from "pg";

/**
 * Acesso ao PostgreSQL com papéis mínimos:
 * - admin  (DATABASE_URL_ADMIN): somente migrações/setup.
 * - app    (DATABASE_URL_APP): API autenticada; RLS com usuário + organização.
 * - system (DATABASE_URL_SYSTEM): worker e ingestão pública; RLS com organização.
 * Sempre SQL parametrizado (R40-08).
 */

// int8 → bigint (dinheiro e contadores nunca viram float). numeric permanece string.
pg.types.setTypeParser(20, (v: string) => BigInt(v));

export type Queryable = Pick<pg.PoolClient, "query">;
export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export interface DbPools {
  app: pg.Pool;
  system: pg.Pool;
}

export function createPool(connectionString: string, opts: { max?: number; applicationName?: string } = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: opts.applicationName ?? "tracker",
    statement_timeout: 30_000,
  });
  pool.on("error", (err) => {
    // Erros de conexões ociosas não devem derrubar o processo.
    console.error(JSON.stringify({ level: "error", msg: "pg_pool_error", error: err.message }));
  });
  return pool;
}

export interface TxContext {
  organizationId: string;
  userId?: string | null;
}

/**
 * Executa `fn` numa transação com contexto de organização (e usuário) para as políticas RLS.
 * O contexto é local à transação (set_config(..., true)), portanto não vaza entre requisições do pool.
 */
export async function withTx<T>(pool: pg.Pool, ctx: TxContext | null, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (ctx) {
      await client.query("select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [
        ctx.organizationId,
        ctx.userId ?? "",
      ]);
    }
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      // conexão pode estar quebrada; o erro original prevalece
    }
    throw err;
  } finally {
    client.release();
  }
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === "23505" && (!constraint || e.constraint === constraint);
}

export function isSerializationFailure(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "40001" || code === "40P01";
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variável de ambiente obrigatória ausente: ${name} (ver .env.example)`);
  return v;
}
