-- 0006 — Destinos de conversão (Meta CAPI, webhook próprio etc.), entregas idempotentes e tentativas (R17, R18, R33-05).

create table public.conversion_destinations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid,
  connection_id uuid,
  provider text not null check (provider in ('meta_capi', 'custom_webhook', 'tiktok_events', 'google_data_manager', 'ga4_mp')),
  name text not null,
  -- Envio externo desligado até conexão, validação e emissor responsável definidos (R02-08).
  status text not null default 'disabled' check (status in ('disabled', 'awaiting_configuration', 'test_mode', 'enabled')),
  environment text not null default 'test' check (environment in ('test', 'production')),
  -- Configuração não secreta (ex.: pixel/dataset id, versão da API, test_event_code, URL de destino).
  config jsonb not null default '{}',
  -- Emissor responsável pelo Purchase para evitar duplicidade (R17-13): server | browser | checkout_native.
  purchase_emitter text check (purchase_emitter in ('server', 'browser', 'checkout_native')),
  enabled_events text[] not null default '{}',
  routing jsonb not null default '{}',
  last_test_at timestamptz,
  last_test_result jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, connection_id) references public.provider_connections (organization_id, id) on delete set null (connection_id)
);
create trigger conversion_destinations_touch before update on public.conversion_destinations for each row execute function app.touch_updated_at();
select app.setup_org_table('public.conversion_destinations', 'rw');

-- Idempotência de efeito externo: destino + evento semântico + ambiente (R09-14, R17-09).
create table public.destination_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  destination_id uuid not null,
  order_id uuid,
  semantic_event_key text not null,
  event_name text not null,
  -- event_id estável: não depende do horário de envio nem muda em retry (R17-11).
  event_id text not null,
  environment text not null,
  origin text not null default 'live' check (origin in ('live', 'manual_resend', 'test')),
  status text not null check (status in (
    'received', 'validated', 'queued', 'sent', 'accepted', 'rejected', 'retry_scheduled', 'expired', 'not_eligible', 'unknown_outcome')),
  not_eligible_reason text,
  event_time timestamptz,
  payload_redacted jsonb not null default '{}',
  attempts int not null default 0,
  next_attempt_at timestamptz,
  last_http_status int,
  last_provider_code text,
  last_trace_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, destination_id, semantic_event_key, environment),
  unique (organization_id, id),
  foreign key (organization_id, destination_id) references public.conversion_destinations (organization_id, id) on delete cascade,
  foreign key (organization_id, order_id) references public.orders (organization_id, id) on delete cascade
);
create index destination_deliveries_status_idx on public.destination_deliveries (organization_id, status, updated_at desc);
create trigger destination_deliveries_touch before update on public.destination_deliveries for each row execute function app.touch_updated_at();
select app.setup_org_table('public.destination_deliveries', 'ro');

create table public.delivery_attempts (
  id bigserial primary key,
  organization_id uuid not null,
  delivery_id uuid not null,
  attempt_no int not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  latency_ms int,
  http_status int,
  provider_code text,
  trace_id text,
  outcome text not null check (outcome in ('accepted', 'rejected', 'retryable_error', 'timeout_unknown', 'network_error', 'blocked')),
  error_message text,
  unique (organization_id, delivery_id, attempt_no),
  foreign key (organization_id, delivery_id) references public.destination_deliveries (organization_id, id) on delete cascade
);
select app.setup_org_table('public.delivery_attempts', 'ro');
grant usage on sequence public.delivery_attempts_id_seq to tracker_system;

-- Circuit breaker por provedor/destino (R09-18).
create table public.circuit_breakers (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  scope text not null,
  state text not null default 'closed' check (state in ('closed', 'open', 'half_open')),
  consecutive_failures int not null default 0,
  opened_at timestamptz,
  retry_after timestamptz,
  updated_at timestamptz not null default now(),
  primary key (organization_id, scope)
);
select app.setup_org_table('public.circuit_breakers', 'ro');
