#!/usr/bin/env node
/**
 * Prepara bancos locais (desenvolvimento e teste) e credenciais de login dos papéis mínimos.
 * Usa DATABASE_URL_SUPERUSER (padrão: socket local como "postgres") somente para criar bancos/papéis.
 * Nunca use as senhas de desenvolvimento em homologação/produção.
 */
import { execFileSync } from "node:child_process";

const env = process.env;
if (env.NODE_ENV === "production") {
  console.error("db-setup é somente para ambiente local. Em produção, crie papéis e senhas pelo operador.");
  process.exit(1);
}

const databases = [env.PGDATABASE_DEV ?? "tracker_dev", env.PGDATABASE_TEST ?? "tracker_test", env.PGDATABASE_E2E ?? "tracker_e2e"];
const appPassword = env.DB_APP_PASSWORD ?? "dev_app_password";
const systemPassword = env.DB_SYSTEM_PASSWORD ?? "dev_system_password";
const adminPassword = env.DB_ADMIN_PASSWORD ?? "postgres";

function psql(sql, db = "postgres") {
  const args = ["-v", "ON_ERROR_STOP=1", "-q", "-d", db, "-c", sql];
  if (env.DATABASE_URL_SUPERUSER) {
    execFileSync("psql", [env.DATABASE_URL_SUPERUSER.replace(/\/[^/]*$/, `/${db}`), ...args.slice(0, 3), ...args.slice(5)], { stdio: "inherit" });
  } else {
    execFileSync("su", ["postgres", "-c", `psql ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`], { stdio: "inherit" });
  }
}

const quote = (s) => `'${s.replace(/'/g, "''")}'`;

psql(`alter role postgres with password ${quote(adminPassword)}`);
psql(`do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'tracker_app') then create role tracker_app nologin noinherit nobypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'tracker_system') then create role tracker_system nologin noinherit nobypassrls; end if;
end $$;`);
psql(`alter role tracker_app with login password ${quote(appPassword)}`);
psql(`alter role tracker_system with login password ${quote(systemPassword)}`);
for (const db of databases) {
  try {
    psql(`create database ${db}`);
    console.log(`banco ${db} criado`);
  } catch {
    console.log(`banco ${db} já existe`);
  }
  psql(`grant connect on database ${db} to tracker_app, tracker_system`);
}
console.log("Pronto. Execute: pnpm db:migrate");
