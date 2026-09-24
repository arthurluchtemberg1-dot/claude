-- 0009 — Configurações de segurança por organização e vínculos de agência (R06-03, R06-08, R37-01).

alter table public.organizations
  add column mfa_required boolean not null default false,
  add column settings jsonb not null default '{}';

-- Vínculo explícito e revogável agência → cliente. Não é bypass genérico: membros da agência só acessam
-- o cliente se forem adicionados também como membros do cliente (associação explícita); este vínculo
-- registra o contrato de acesso e permite revogação em massa sem apagar dados do cliente (R37-05).
create table public.agency_links (
  id uuid primary key default gen_random_uuid(),
  agency_organization_id uuid not null references public.organizations(id) on delete cascade,
  client_organization_id uuid not null references public.organizations(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_by uuid,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (agency_organization_id, client_organization_id)
);
alter table public.agency_links enable row level security;
create policy org_app on public.agency_links for all to tracker_app
  using (client_organization_id = (select app.member_org_id()) or agency_organization_id = (select app.member_org_id()))
  with check (client_organization_id = (select app.member_org_id()));
create policy org_system on public.agency_links for all to tracker_system
  using (client_organization_id = (select app.current_org_id()) or agency_organization_id = (select app.current_org_id()))
  with check (client_organization_id = (select app.current_org_id()));
grant select, insert, update on public.agency_links to tracker_app, tracker_system;

alter table public.memberships add column via_agency_link uuid references public.agency_links(id) on delete set null;
