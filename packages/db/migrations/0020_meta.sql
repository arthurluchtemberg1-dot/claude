-- Integração Meta (R19, R25): contas sincronizadas, entidades com orçamento/aprendizagem, compras reportadas pela rede
-- (separadas das vendas confirmadas), ativos (pixels, páginas) e histórico de alterações de mídia.

alter table public.ad_accounts
  add column account_status int,
  add column amount_spent_minor bigint,
  add column spend_cap_minor bigint,
  add column balance_minor bigint,
  add column is_prepay boolean,
  add column min_daily_budget_minor bigint,
  add column business_name text,
  add column sync_enabled boolean not null default true,
  add column last_sync_error text,
  add column last_sync_started_at timestamptz;

alter table public.ad_entities
  add column daily_budget_minor bigint,
  add column lifetime_budget_minor bigint,
  add column budget_remaining_minor bigint,
  add column learning_status text,
  add column campaign_external_id text,
  add column adset_external_id text,
  add column created_time timestamptz,
  add column synced_at timestamptz;
create index ad_entities_level_idx on public.ad_entities (organization_id, level, external_id);
-- A API pode marcar uma entidade com o próprio nome/estado: tracker_app só lê (escrita pelo worker).

alter table public.ad_spend_daily
  add column adset_external_id text,
  -- Conversões REPORTADAS pela rede (atribuição da própria Meta): exibidas separadas, nunca somadas às vendas.
  add column reported_purchases numeric,
  add column reported_purchase_value_minor bigint;

-- Ativos da conexão (pixels/datasets e páginas) para escolha no painel.
create table public.meta_assets (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null,
  ad_account_id uuid,
  kind text not null check (kind in ('pixel', 'page')),
  external_id text not null,
  name text,
  details jsonb not null default '{}',
  last_seen_at timestamptz not null default now(),
  primary key (organization_id, connection_id, kind, external_id),
  foreign key (organization_id, connection_id) references public.provider_connections (organization_id, id) on delete cascade
);
select app.setup_org_table('public.meta_assets', 'ro');

-- Histórico de alterações de mídia (R25-06): quem, por que (pessoa, regra, IA), antes/depois e resultado.
-- Escrita sem resposta fica "unknown" até reconciliar com a leitura da entidade (R25-11).
create table public.media_changes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ad_account_id uuid not null,
  network text not null default 'meta',
  level text not null check (level in ('campaign', 'adset', 'ad')),
  entity_id text not null,
  entity_name text,
  action text not null check (action in ('pause', 'activate', 'budget', 'rename', 'duplicate')),
  before jsonb not null default '{}',
  requested jsonb not null default '{}',
  after jsonb,
  actor_type text not null check (actor_type in ('user', 'rule', 'ai')),
  actor_id uuid,
  rule_id uuid,
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed', 'unknown', 'skipped')),
  error text,
  idempotency_key text not null,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (organization_id, idempotency_key),
  unique (organization_id, id),
  foreign key (organization_id, ad_account_id) references public.ad_accounts (organization_id, id) on delete cascade
);
create index media_changes_entity_idx on public.media_changes (organization_id, level, entity_id, created_at desc);
create index media_changes_recent_idx on public.media_changes (organization_id, created_at desc);
select app.setup_org_table('public.media_changes', 'ro');
