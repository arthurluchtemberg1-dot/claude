import pg from "pg";

/**
 * Provisiona os papéis mínimos com LOGIN (implantação em contêiner, banco gerenciado ou restauração de backup).
 * Senhas vêm do ambiente do operador; a citação é feita pelo servidor (format %L), nunca por concatenação.
 */
export async function provisionRoles(adminUrl: string, passwords: { app: string; system: string }) {
  for (const [name, pw] of Object.entries(passwords)) {
    if (pw.length < 16) throw new Error(`Senha do papel ${name} deve ter ao menos 16 caracteres`);
  }
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`do $$
      begin
        if not exists (select 1 from pg_roles where rolname = 'tracker_app') then create role tracker_app nologin noinherit nobypassrls; end if;
        if not exists (select 1 from pg_roles where rolname = 'tracker_system') then create role tracker_system nologin noinherit nobypassrls; end if;
      end $$`);
    for (const [role, pw] of [["tracker_app", passwords.app], ["tracker_system", passwords.system]] as const) {
      const sql = (await client.query("select format('alter role %I with login password %L', $1::text, $2::text) as sql", [role, pw])).rows[0].sql as string;
      await client.query(sql);
    }
    const grant = (await client.query("select format('grant connect on database %I to tracker_app, tracker_system', current_database()) as sql")).rows[0].sql as string;
    await client.query(grant);
  } finally {
    await client.end();
  }
}
