-- 0004 — Produtos, pedidos, itens, transações, reversões, razão financeira, contatos e eventos normalizados (R10, R24).

create table public.products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null,
  name text not null check (char_length(name) between 1 and 200),
  product_group text,
  reference_price_minor bigint,
  currency char(3),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, project_id) references public.projects (organization_id, id) on delete cascade
);
create trigger products_touch before update on public.products for each row execute function app.touch_updated_at();
select app.setup_org_table('public.products', 'rw');

-- Mapeamento de IDs externos por conta de provedor. Produtos com mesmo nome em checkouts diferentes
-- NÃO são unificados automaticamente (R24-03).
create table public.product_external_ids (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null,
  provider_account_id uuid not null,
  external_product_id text not null,
  external_name text,
  created_at timestamptz not null default now(),
  unique (organization_id, provider_account_id, external_product_id),
  foreign key (organization_id, product_id) references public.products (organization_id, id) on delete cascade,
  foreign key (organization_id, provider_account_id) references public.provider_accounts (organization_id, id) on delete cascade
);
select app.setup_org_table('public.product_external_ids', 'rw');

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null,
  provider text not null,
  provider_account_id uuid not null,
  external_order_id text not null check (char_length(external_order_id) between 1 and 200),
  -- Vínculo com pedido original (upsell/downsell) somente quando comprovado pela origem (R10-06, R10-07).
  parent_order_id uuid,
  currency char(3),
  financial_status text not null default 'pending' check (financial_status in (
    'pending', 'failed', 'approved', 'partially_reversed', 'fully_reversed', 'reversal_pending_reconciliation')),
  approved_minor bigint not null default 0,
  reversed_minor bigint not null default 0,
  first_approved_at timestamptz,
  payment_method text,
  -- Origem declarada pelo checkout (dado não confiável, preservado como evidência declaratória) (R15-07).
  declared_tracking jsonb not null default '{}',
  -- Estado agregado serializado (transações/reversões/itens) usado pelo domínio; tabelas abaixo são a projeção consultável.
  source_first_occurred_at timestamptz,
  source_updated_at timestamptz,
  first_received_at timestamptz not null default now(),
  processed_at timestamptz,
  is_test boolean not null default false,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider_account_id, external_order_id),
  unique (organization_id, id),
  foreign key (organization_id, project_id) references public.projects (organization_id, id) on delete cascade,
  foreign key (organization_id, provider_account_id) references public.provider_accounts (organization_id, id) on delete cascade,
  foreign key (organization_id, parent_order_id) references public.orders (organization_id, id)
);
create index orders_org_approved_idx on public.orders (organization_id, first_approved_at desc);
create index orders_project_approved_idx on public.orders (organization_id, project_id, first_approved_at desc);
create index orders_status_idx on public.orders (organization_id, financial_status);
create trigger orders_touch before update on public.orders for each row execute function app.touch_updated_at();
select app.setup_org_table('public.orders', 'ro');

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  order_id uuid not null,
  item_key text not null,
  external_product_id text not null,
  product_id uuid,
  name text,
  item_type text,
  unit_amount_minor bigint,
  quantity int not null default 1 check (quantity > 0),
  currency char(3) not null,
  updated_at timestamptz not null default now(),
  unique (organization_id, order_id, item_key),
  foreign key (organization_id, order_id) references public.orders (organization_id, id) on delete cascade,
  foreign key (organization_id, product_id) references public.products (organization_id, id)
);
select app.setup_org_table('public.order_items', 'ro');

create table public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  order_id uuid not null,
  provider_account_id uuid not null,
  transaction_key text not null,
  kind text not null check (kind in ('initial', 'upsell', 'downsell', 'renewal', 'manual')),
  status text not null check (status in ('pending', 'failed', 'canceled', 'expired', 'approved')),
  amount_minor bigint,
  currency char(3) not null,
  method text not null,
  approved_at timestamptz,
  status_occurred_at timestamptz not null,
  reversed_net_minor bigint not null default 0,
  refund_reported_total_minor bigint not null default 0,
  org_share_minor bigint,
  fee_minor bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Identidade da cobrança por conta lógica: um mesmo ID de cobrança não pertence a dois pedidos (R09-14).
  unique (organization_id, provider_account_id, transaction_key),
  unique (organization_id, order_id, transaction_key),
  foreign key (organization_id, order_id) references public.orders (organization_id, id) on delete cascade
);
create index payment_transactions_order_idx on public.payment_transactions (organization_id, order_id);
select app.setup_org_table('public.payment_transactions', 'ro');

create table public.reversals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  order_id uuid not null,
  reversal_key text not null,
  kind text not null check (kind in ('refund', 'chargeback', 'dispute_win')),
  transaction_key text,
  semantics text not null check (semantics in ('incremental', 'cumulative', 'full')),
  reported_amount_minor bigint,
  occurred_at timestamptz not null,
  related_key text,
  status text not null check (status in ('applied', 'pending_reconciliation')),
  effective_minor bigint not null default 0,
  restored_minor bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, order_id, reversal_key),
  foreign key (organization_id, order_id) references public.orders (organization_id, id) on delete cascade
);
select app.setup_org_table('public.reversals', 'ro');

-- Razão financeira append-only: idempotência por chave semântica (R09-14); nunca atualizada/apagada pela API.
create table public.financial_entries (
  id bigserial primary key,
  organization_id uuid not null,
  project_id uuid not null,
  order_id uuid not null,
  semantic_key text not null,
  entry_type text not null check (entry_type in ('approval', 'refund', 'chargeback', 'chargeback_reversal', 'fee', 'org_share', 'org_share_reversal')),
  transaction_key text not null,
  amount_minor bigint not null,
  currency char(3) not null,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  revenue_kind text not null,
  reversal_key text,
  estimated boolean not null default false,
  source_receipt_id uuid,
  is_test boolean not null default false,
  is_demo boolean not null default false,
  unique (organization_id, order_id, semantic_key),
  foreign key (organization_id, order_id) references public.orders (organization_id, id) on delete cascade
);
create index financial_entries_org_time_idx on public.financial_entries (organization_id, occurred_at);
create index financial_entries_order_idx on public.financial_entries (organization_id, order_id);
select app.setup_org_table('public.financial_entries', 'ro');
grant usage on sequence public.financial_entries_id_seq to tracker_system;

create table public.order_conflicts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  order_id uuid not null,
  code text not null,
  message text not null,
  transaction_key text,
  reversal_key text,
  receipt_id uuid,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  foreign key (organization_id, order_id) references public.orders (organization_id, id) on delete cascade
);
create index order_conflicts_open_idx on public.order_conflicts (organization_id, created_at desc) where resolved_at is null;
select app.setup_org_table('public.order_conflicts', 'ro');

-- Dados pessoais em estrutura restrita (R08-04): leitura exige permissão pii.read na API; retenção explícita.
create table public.order_contacts (
  organization_id uuid not null,
  order_id uuid not null,
  email citext,
  email_sha256 text,
  phone text,
  name text,
  source text not null,
  purpose text not null default 'order_processing',
  retention_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, order_id),
  foreign key (organization_id, order_id) references public.orders (organization_id, id) on delete cascade
);
select app.setup_org_table('public.order_contacts', 'ro');

-- Eventos canônicos versionados derivados de cada recebimento (R08-01).
create table public.normalized_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  receipt_id uuid not null,
  seq int not null,
  schema_version text not null,
  event_type text not null,
  occurred_at timestamptz,
  order_id uuid,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (organization_id, receipt_id, seq),
  foreign key (organization_id, receipt_id) references public.webhook_receipts (organization_id, id) on delete cascade
);
create index normalized_events_order_idx on public.normalized_events (organization_id, order_id);
select app.setup_org_table('public.normalized_events', 'ro');
