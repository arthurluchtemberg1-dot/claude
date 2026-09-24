-- 0001 — Fundação: schemas, papéis mínimos e funções de contexto para RLS.
-- Papéis:
--   tracker_app    : API autenticada; sujeito a RLS com contexto de usuário + organização.
--   tracker_system : worker e endpoints públicos de ingestão; sujeito a RLS com contexto de organização.
-- As senhas/LOGIN dos papéis são definidas fora das migrações (scripts/db-setup.mjs ou operador).

create extension if not exists citext;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'tracker_app') then
    create role tracker_app nologin noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'tracker_system') then
    create role tracker_system nologin noinherit nobypassrls;
  end if;
end $$;

create schema if not exists app;
create schema if not exists iam;
create schema if not exists private;

revoke all on schema public from public;
revoke all on schema app, iam, private from public;
grant usage on schema public, app to tracker_app, tracker_system;
grant usage on schema iam, private to tracker_system;

-- Contexto de organização/usuário definido por transação (set_config(..., true)).
create or replace function app.current_org_id() returns uuid
language sql stable parallel safe
as $$ select nullif(current_setting('app.org_id', true), '')::uuid $$;

create or replace function app.current_user_id() returns uuid
language sql stable parallel safe
as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

grant execute on function app.current_org_id(), app.current_user_id() to tracker_app, tracker_system;

-- Atualização automática de updated_at.
create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
