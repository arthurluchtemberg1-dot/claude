-- 0007 — Mídia (contas, entidades, gastos diários por snapshot) e custos/câmbio (R19, R20, R22-06, R22-10).

create table public.ad_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid,
  connection_id uuid,
  network text not null check (network in ('meta', 'google', 'tiktok', 'microsoft', 'pinterest', 'linkedin', 'snapchat', 'kwai', 'taboola', 'outbrain', 'manual')),
  external_account_id text not null,
  name text not null,
  currency char(3) not null,
  timezone text,
  status text,
  last_synced_at timestamptz,
  synced_from date,
  synced_to date,
  created_at timestamptz not null default now(),
  unique (organization_id, network, external_account_id),
  unique (organization_id, id)
);
select app.setup_org_table('public.ad_accounts', 'rw');

-- Entidades de mídia por ID estável (strings opacas); nomes com histórico (R19-10, T39).
create table public.ad_entities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  ad_account_id uuid not null,
  level text not null check (level in ('campaign', 'adset', 'ad')),
  external_id text not null,
  parent_external_id text,
  name text,
  status text,
  effective_status text,
  objective text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (organization_id, ad_account_id, level, external_id),
  foreign key (organization_id, ad_account_id) references public.ad_accounts (organization_id, id) on delete cascade
);
select app.setup_org_table('public.ad_entities', 'ro');

create table public.ad_entity_names (
  id bigserial primary key,
  organization_id uuid not null,
  ad_account_id uuid not null,
  level text not null,
  external_id text not null,
  name text not null,
  seen_at timestamptz not null default now(),
  unique (organization_id, ad_account_id, level, external_id, name)
);
select app.setup_org_table('public.ad_entity_names', 'ro');
grant usage on sequence public.ad_entity_names_id_seq to tracker_system;

-- Gasto diário por entidade e nível. Reimportação substitui o snapshot (T45); consultas usam um único nível (T46).
create table public.ad_spend_daily (
  id bigserial primary key,
  organization_id uuid not null,
  project_id uuid,
  ad_account_id uuid not null,
  level text not null check (level in ('account', 'campaign', 'adset', 'ad')),
  entity_external_id text not null,
  campaign_external_id text,
  spend_date date not null,
  currency char(3) not null,
  spend_minor bigint not null check (spend_minor >= 0),
  impressions bigint,
  link_clicks bigint,
  reach bigint,
  source text not null check (source in ('api', 'csv', 'manual')),
  import_id uuid,
  snapshot_at timestamptz not null default now(),
  unique (organization_id, ad_account_id, level, entity_external_id, spend_date, source),
  foreign key (organization_id, ad_account_id) references public.ad_accounts (organization_id, id) on delete cascade
);
create index ad_spend_daily_date_idx on public.ad_spend_daily (organization_id, spend_date);
select app.setup_org_table('public.ad_spend_daily', 'rw');
grant usage on sequence public.ad_spend_daily_id_seq to tracker_app, tracker_system;

create table public.cost_imports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in ('ad_spend', 'cost_entries')),
  filename text,
  file_sha256 text not null,
  status text not null check (status in ('previewed', 'committed', 'failed')),
  row_count int not null default 0,
  error_count int not null default 0,
  mapping jsonb not null default '{}',
  timezone text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  unique (organization_id, id)
);
select app.setup_org_table('public.cost_imports', 'rw');

-- Custos sem API e despesas (influenciadores, afiliados, offline, despesas fixas...) com origem identificada (R20-04, R20-06).
create table public.cost_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid,
  category text not null check (category in ('media_offline', 'influencer', 'affiliate', 'boost', 'product_cost', 'shipping', 'tax_estimate', 'operating_expense', 'tool', 'other')),
  counts_as_media boolean not null default false,
  description text not null check (char_length(description) between 1 and 300),
  amount_minor bigint not null check (amount_minor >= 0),
  currency char(3) not null,
  period_start date not null,
  period_end date not null,
  source text not null check (source in ('manual', 'csv')),
  import_id uuid,
  dedup_key text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  check (period_end >= period_start),
  unique (organization_id, dedup_key)
);
create index cost_entries_period_idx on public.cost_entries (organization_id, period_start, period_end);
select app.setup_org_table('public.cost_entries', 'rw');

-- Tabela de taxas versionada por vigência (R22-06).
create table public.fee_schedules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider_account_id uuid,
  name text not null,
  percent_bp int not null default 0 check (percent_bp between 0 and 10000),
  fixed_minor bigint not null default 0 check (fixed_minor >= 0),
  currency char(3) not null,
  valid_from date not null,
  valid_to date,
  created_by uuid,
  created_at timestamptz not null default now()
);
select app.setup_org_table('public.fee_schedules', 'rw');

-- Câmbio identificado e datado; sem taxa válida as moedas ficam separadas (R22-10).
create table public.exchange_rates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  from_currency char(3) not null,
  to_currency char(3) not null,
  rate numeric(24, 10) not null check (rate > 0),
  as_of_date date not null,
  source text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, from_currency, to_currency, as_of_date, source)
);
select app.setup_org_table('public.exchange_rates', 'rw');
