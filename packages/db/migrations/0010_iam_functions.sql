-- 0010 — Funções privilegiadas pequenas e auditáveis para operações que antecedem o contexto de organização (R07-14).

-- Organizações do usuário autenticado (seletor de organização).
create or replace function app.user_organizations(p_user_id uuid)
returns table (organization_id uuid, name text, slug text, role text, is_demo boolean, internal_mode boolean)
language sql stable security definer set search_path = ''
as $$
  select o.id, o.name, o.slug, m.role, o.is_demo, o.internal_mode
    from public.memberships m join public.organizations o on o.id = m.organization_id
   where m.user_id = p_user_id and m.status = 'active'
   order by o.name
$$;

-- Convite por hash do token (uso único e expiração verificados pelo chamador na transação de aceite).
create or replace function app.resolve_invite(p_token_hash bytea)
returns table (invite_id uuid, organization_id uuid, email text, role text, expires_at timestamptz, accepted_at timestamptz, revoked_at timestamptz, organization_name text)
language sql stable security definer set search_path = ''
as $$
  select i.id, i.organization_id, i.email::text, i.role, i.expires_at, i.accepted_at, i.revoked_at, o.name
    from public.invites i join public.organizations o on o.id = i.organization_id
   where i.token_hash = p_token_hash
$$;

-- Projeto pela chave pública do SDK (coletor público). A chave pública não autentica vendas.
create or replace function app.resolve_project_key(p_public_key text)
returns table (project_id uuid, organization_id uuid, allowed_origins text[], archived boolean, is_demo boolean)
language sql stable security definer set search_path = ''
as $$
  select p.id, p.organization_id, p.allowed_origins, p.archived_at is not null, o.is_demo
    from public.projects p join public.organizations o on o.id = p.organization_id
   where p.public_key = p_public_key
$$;

revoke all on function app.user_organizations(uuid), app.resolve_invite(bytea), app.resolve_project_key(text) from public;
grant execute on function app.user_organizations(uuid), app.resolve_invite(bytea), app.resolve_project_key(text) to tracker_system;
