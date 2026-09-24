-- 0008 — Chaves de API (hash), feature flags e requisições de privacidade (R33-01, R38-03, R40-18).

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  prefix text not null unique,
  key_hash bytea not null unique,
  scopes text[] not null,
  project_ids uuid[] not null default '{}',
  created_by uuid not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
select app.setup_org_table('public.api_keys', 'rw');

create or replace function app.resolve_api_key(p_key_hash bytea)
returns table (id uuid, organization_id uuid, scopes text[], project_ids uuid[], revoked boolean)
language sql stable security definer set search_path = ''
as $$ select k.id, k.organization_id, k.scopes, k.project_ids, k.revoked_at is not null from public.api_keys k where k.key_hash = p_key_hash $$;
revoke all on function app.resolve_api_key(bytea) from public;
grant execute on function app.resolve_api_key(bytea) to tracker_system;

create table public.feature_flags (
  key text not null,
  organization_id uuid references public.organizations(id) on delete cascade,
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create unique index feature_flags_key_org_idx on public.feature_flags (key, coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid));
grant select on public.feature_flags to tracker_system;

create table public.privacy_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in ('export', 'correct', 'delete')),
  subject_email_sha256 text not null,
  status text not null default 'received' check (status in ('received', 'in_progress', 'completed', 'rejected')),
  requested_by uuid,
  notes text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
select app.setup_org_table('public.privacy_requests', 'rw');
