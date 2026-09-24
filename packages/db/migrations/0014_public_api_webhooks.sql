-- API pública (R33-01..R33-04) e webhooks de saída (R33-05..R33-07).

-- Chaves: ambiente sandbox (somente dados de teste) ou produção; hash HMAC da chave; nunca o valor.
alter table public.api_keys
  add column environment text not null default 'production' check (environment in ('production', 'sandbox')),
  add column expires_at timestamptz,
  add column revoked_by uuid;
alter table public.api_keys add constraint api_keys_org_id_unique unique (organization_id, id);
alter table public.api_keys add constraint api_keys_scopes_check check (
  scopes <@ array['metrics:read', 'orders:read', 'orders:write', 'products:read', 'campaigns:read', 'integrations:read']::text[] and cardinality(scopes) > 0);

drop function app.resolve_api_key(bytea);
create function app.resolve_api_key(p_key_hash bytea)
returns table (id uuid, organization_id uuid, scopes text[], project_ids uuid[], revoked boolean, environment text, expired boolean)
language sql stable security definer set search_path = ''
as $$ select k.id, k.organization_id, k.scopes, k.project_ids, k.revoked_at is not null, k.environment, coalesce(k.expires_at < now(), false)
        from public.api_keys k where k.key_hash = p_key_hash $$;
revoke all on function app.resolve_api_key(bytea) from public;
grant execute on function app.resolve_api_key(bytea) to tracker_system;

-- Registro de uso sem conteúdo sensível: rota (modelo), método, status, latência e request_id. Sem query string/corpo.
create table public.api_key_usage (
  id bigserial primary key,
  organization_id uuid not null,
  api_key_id uuid not null,
  occurred_at timestamptz not null default now(),
  method text not null,
  route text not null,
  status int not null,
  latency_ms int,
  request_id text,
  foreign key (organization_id, api_key_id) references public.api_keys (organization_id, id) on delete cascade
);
create index api_key_usage_key_idx on public.api_key_usage (organization_id, api_key_id, occurred_at desc);
select app.setup_org_table('public.api_key_usage', 'ro');
grant usage on sequence public.api_key_usage_id_seq to tracker_system;

-- Janelas de limite de taxa (compartilhadas entre instâncias da API).
create table public.api_rate_windows (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  subject text not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (organization_id, subject, window_start)
);
select app.setup_org_table('public.api_rate_windows', 'none');

-- Idempotency-Key: a mesma chave com o mesmo corpo devolve a resposta original; com outro corpo, erro.
create table public.api_idempotency (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  api_key_id uuid not null,
  idem_key text not null check (char_length(idem_key) between 1 and 200),
  request_hash text not null,
  status_code int,
  response jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  primary key (organization_id, api_key_id, idem_key)
);
select app.setup_org_table('public.api_idempotency', 'none');

-- Assinaturas de webhooks de saída. O segredo fica cifrado em private.credentials (finalidade outbound_signing_secret).
create table public.webhook_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  url text not null check (char_length(url) between 8 and 2048),
  events text[] not null check (cardinality(events) > 0 and events <@ array['order.approved', 'order.reversed', 'order.status_changed']::text[]),
  project_ids uuid[] not null default '{}',
  include_test boolean not null default false,
  -- Nasce pausada: ativação exige teste assinado respondido com 2xx pelo destino (validação de posse, R33-05).
  status text not null default 'paused' check (status in ('active', 'paused', 'disabled')),
  verified_at timestamptz,
  consecutive_failures int not null default 0,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);
create trigger webhook_subscriptions_touch before update on public.webhook_subscriptions for each row execute function app.touch_updated_at();
select app.setup_org_table('public.webhook_subscriptions', 'rw');

-- Segredos por assinatura: o cofre passa a aceitar a referência a uma assinatura de webhook de saída.
alter table private.credentials add column subscription_id uuid;
alter table private.credentials add constraint credentials_subscription_fk
  foreign key (organization_id, subscription_id) references public.webhook_subscriptions (organization_id, id) on delete cascade;
alter table private.credentials add constraint credentials_single_owner check (connection_id is null or subscription_id is null);

-- Entregas de saída: uma por (assinatura, evento); tentativas com backoff; "dead" = fila de falhas com reenvio manual.
create table public.webhook_out_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  subscription_id uuid not null,
  event_id text not null,
  event_type text not null,
  payload jsonb not null,
  hop int not null default 0,
  status text not null default 'pending' check (status in ('pending', 'retry_scheduled', 'succeeded', 'dead', 'blocked', 'skipped')),
  attempts int not null default 0,
  next_attempt_at timestamptz,
  last_http_status int,
  last_error text,
  last_latency_ms int,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  unique (organization_id, subscription_id, event_id),
  foreign key (organization_id, subscription_id) references public.webhook_subscriptions (organization_id, id) on delete cascade
);
create index webhook_out_deliveries_sub_idx on public.webhook_out_deliveries (organization_id, subscription_id, created_at desc);
select app.setup_org_table('public.webhook_out_deliveries', 'ro');

-- Proveniência/limite de encaminhamento: saltos declarados por outra instância do Tracker na entrada (R33-07).
alter table public.webhook_receipts add column hop int not null default 0 check (hop between 0 and 10);
