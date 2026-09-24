-- 0002 — Identidade, organizações, membros, projetos, convites e auditoria (R06, R07-02, R07-12).

-- ============ IAM (autenticação própria; acessado somente por tracker_system) ============
create table iam.users (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  email_verified_at timestamptz,
  password_hash text not null,
  display_name text not null check (char_length(display_name) between 1 and 120),
  locale text not null default 'pt-BR' check (locale in ('pt-BR', 'en-US', 'es')),
  is_platform_admin boolean not null default false,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger users_touch before update on iam.users for each row execute function app.touch_updated_at();

create table iam.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references iam.users(id) on delete cascade,
  token_hash bytea not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  mfa_verified_at timestamptz,
  user_agent text check (char_length(user_agent) <= 300)
);
create index sessions_user_idx on iam.sessions (user_id) where revoked_at is null;

create table iam.email_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references iam.users(id) on delete cascade,
  purpose text not null check (purpose in ('verify_email', 'reset_password')),
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index email_tokens_user_idx on iam.email_tokens (user_id, purpose);

create table iam.mfa_totp (
  user_id uuid primary key references iam.users(id) on delete cascade,
  secret_ciphertext text not null,
  key_version int not null,
  confirmed_at timestamptz,
  last_used_step bigint,
  created_at timestamptz not null default now()
);

create table iam.auth_attempts (
  id bigserial primary key,
  bucket text not null, -- ex.: 'login:email:<hash>' ou 'login:ip:<hash>' (sem PII em claro)
  success boolean not null,
  created_at timestamptz not null default now()
);
create index auth_attempts_bucket_idx on iam.auth_attempts (bucket, created_at desc);

grant select, insert, update, delete on all tables in schema iam to tracker_system;
grant usage on all sequences in schema iam to tracker_system;

-- ============ Organizações ============
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  timezone text not null default 'America/Sao_Paulo',
  currency char(3) not null default 'BRL',
  locale text not null default 'pt-BR',
  -- Modo interno: sem cobrança de assinatura, mesmas regras de autenticação e isolamento (R02-01).
  internal_mode boolean not null default false,
  -- Organização de demonstração isolada: nunca envia a destinos reais nem entra em métricas de produção (T68).
  is_demo boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger organizations_touch before update on public.organizations for each row execute function app.touch_updated_at();

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references iam.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'manager', 'analyst', 'finance', 'viewer')),
  status text not null default 'active' check (status in ('active', 'suspended', 'removed')),
  invited_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id),
  unique (organization_id, id)
);
create index memberships_user_idx on public.memberships (user_id) where status = 'active';
create trigger memberships_touch before update on public.memberships for each row execute function app.touch_updated_at();

-- Organização efetiva para tracker_app: a do contexto, somente se o usuário do contexto for membro ativo.
-- SECURITY DEFINER para ler memberships sem recursão de RLS; search_path vazio por segurança.
create or replace function app.member_org_id() returns uuid
language sql stable security definer set search_path = ''
as $$
  select m.organization_id
    from public.memberships m
   where m.organization_id = app.current_org_id()
     and m.user_id = app.current_user_id()
     and m.status = 'active'
$$;
revoke all on function app.member_org_id() from public;
grant execute on function app.member_org_id() to tracker_app;

-- Helper de migração: habilita RLS e aplica políticas/grants padrão de tabela de negócio.
-- app_access: 'rw' (API lê e escreve), 'ro' (API só lê; ex.: razão financeira), 'none'.
create or replace function app.setup_org_table(t regclass, app_access text default 'rw') returns void
language plpgsql as $$
begin
  execute format('alter table %s enable row level security', t);
  execute format('create policy org_system on %s for all to tracker_system using (organization_id = (select app.current_org_id())) with check (organization_id = (select app.current_org_id()))', t);
  execute format('grant select, insert, update, delete on %s to tracker_system', t);
  if app_access in ('rw', 'ro') then
    execute format('create policy org_app on %s for all to tracker_app using (organization_id = (select app.member_org_id())) with check (organization_id = (select app.member_org_id()))', t);
    if app_access = 'rw' then
      execute format('grant select, insert, update, delete on %s to tracker_app', t);
    else
      execute format('grant select on %s to tracker_app', t);
    end if;
  end if;
end $$;

-- organizations: política própria (a chave é id, não organization_id).
alter table public.organizations enable row level security;
create policy org_app on public.organizations for all to tracker_app
  using (id = (select app.member_org_id())) with check (id = (select app.member_org_id()));
create policy org_system on public.organizations for all to tracker_system
  using (id = (select app.current_org_id())) with check (id = (select app.current_org_id()));
grant select, update on public.organizations to tracker_app;
grant select, insert, update on public.organizations to tracker_system;

select app.setup_org_table('public.memberships', 'rw');

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  -- Identificador público do SDK: não é segredo e não autentica vendas (R13-01).
  public_key text not null unique check (public_key ~ '^pk_[A-Za-z0-9]{16,40}$'),
  timezone text,
  currency char(3),
  -- Domínios permitidos para coleta (validação de origem no coletor; não é autenticação).
  allowed_origins text[] not null default '{}',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);
create index projects_org_idx on public.projects (organization_id);
create trigger projects_touch before update on public.projects for each row execute function app.touch_updated_at();
select app.setup_org_table('public.projects', 'rw');

-- Restrição por projeto: se existir ao menos uma linha para (org, usuário), o acesso fica limitado a esses projetos.
create table public.project_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  user_id uuid not null references iam.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (organization_id, project_id, user_id),
  foreign key (organization_id, project_id) references public.projects (organization_id, id) on delete cascade
);
select app.setup_org_table('public.project_memberships', 'rw');

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email citext not null,
  role text not null check (role in ('admin', 'manager', 'analyst', 'finance', 'viewer')),
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid,
  revoked_at timestamptz,
  invited_by uuid not null,
  created_at timestamptz not null default now()
);
create index invites_org_idx on public.invites (organization_id, created_at desc);
select app.setup_org_table('public.invites', 'rw');

-- Auditoria append-only (R21-13, R40-13). tracker_app pode inserir e ler da própria organização; ninguém altera.
create table public.audit_logs (
  id bigserial primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_type text not null check (actor_type in ('user', 'system', 'api_key', 'rule', 'ai', 'platform_admin')),
  actor_id text,
  action text not null,
  target_type text,
  target_id text,
  details jsonb not null default '{}',
  request_id text,
  created_at timestamptz not null default now()
);
create index audit_logs_org_idx on public.audit_logs (organization_id, created_at desc);
alter table public.audit_logs enable row level security;
create policy org_app on public.audit_logs for all to tracker_app
  using (organization_id = (select app.member_org_id())) with check (organization_id = (select app.member_org_id()));
create policy org_system on public.audit_logs for all to tracker_system
  using (organization_id = (select app.current_org_id())) with check (organization_id = (select app.current_org_id()));
grant select, insert on public.audit_logs to tracker_app, tracker_system;
grant usage on sequence public.audit_logs_id_seq to tracker_app, tracker_system;
