-- 0003 — Integrações, credenciais, endpoints de webhook, recebimentos e outbox (R09, R11, R41-03).

create table public.provider_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null,
  provider text not null check (provider ~ '^[a-z0-9_]{2,40}$'),
  -- Conta lógica no provedor (string opaca). Pedidos são únicos por (organização, conta lógica, pedido externo):
  -- reconexões ou dois endpoints da mesma conta não criam venda duplicada (R09-15, T05).
  external_account_id text not null check (char_length(external_account_id) between 1 and 200),
  display_name text not null check (char_length(display_name) between 1 and 120),
  -- Papel da organização nas vendas desta conta: define a base de receita (R10-15, T51).
  revenue_role text not null default 'producer' check (revenue_role in ('producer', 'affiliate', 'coproducer')),
  created_at timestamptz not null default now(),
  unique (organization_id, provider, external_account_id),
  unique (organization_id, id),
  foreign key (organization_id, project_id) references public.projects (organization_id, id) on delete cascade
);
select app.setup_org_table('public.provider_accounts', 'rw');

create table public.provider_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null,
  provider_account_id uuid,
  provider text not null,
  kind text not null check (kind in ('checkout', 'ad_network', 'destination', 'crm', 'messaging', 'export', 'custom')),
  name text not null check (char_length(name) between 1 and 120),
  -- Estado da conexão (R11-04), distinto do estado de implementação do conector.
  status text not null default 'awaiting_configuration' check (status in (
    'disconnected', 'awaiting_configuration', 'awaiting_permission', 'connected',
    'token_expired', 'revoked', 'temporary_failure', 'sync_delayed')),
  environment text not null default 'production' check (environment in ('test', 'production')),
  -- Configuração não secreta (ex.: fuso assumido do provedor, eventos selecionados).
  config jsonb not null default '{}',
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  disabled_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, project_id) references public.projects (organization_id, id) on delete cascade,
  foreign key (organization_id, provider_account_id) references public.provider_accounts (organization_id, id) on delete restrict
);
create index provider_connections_org_idx on public.provider_connections (organization_id, project_id);
create trigger provider_connections_touch before update on public.provider_connections for each row execute function app.touch_updated_at();
select app.setup_org_table('public.provider_connections', 'rw');

-- Cofre de credenciais: fora do schema exposto; somente tracker_system; valores cifrados (AES-256-GCM)
-- com chave fora do banco e versão para rotação (R07-13, R40-05).
create table private.credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid,
  purpose text not null check (purpose in ('webhook_secret', 'oauth_access_token', 'oauth_refresh_token', 'api_key', 'capi_access_token', 'outbound_signing_secret', 'totp_secret')),
  ciphertext text not null,
  key_version int not null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  revoked_at timestamptz,
  foreign key (organization_id, connection_id) references public.provider_connections (organization_id, id) on delete cascade
);
create index credentials_conn_idx on private.credentials (organization_id, connection_id, purpose) where revoked_at is null;
alter table private.credentials enable row level security;
create policy org_system on private.credentials for all to tracker_system
  using (organization_id = (select app.current_org_id())) with check (organization_id = (select app.current_org_id()));
grant select, insert, update, delete on private.credentials to tracker_system;

-- Endpoints de recebimento: token opaco na URL (armazenado como hash), múltiplos por conexão para rotação.
create table public.webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null,
  connection_id uuid not null,
  token_hash bytea not null unique,
  token_hint text not null check (char_length(token_hint) <= 8),
  status text not null default 'active' check (status in ('active', 'revoked')),
  last_received_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, connection_id) references public.provider_connections (organization_id, id) on delete cascade
);
select app.setup_org_table('public.webhook_endpoints', 'rw');

-- Resolução do endpoint público a partir do hash do token (antes de existir contexto de organização).
create or replace function app.resolve_webhook_endpoint(p_token_hash bytea)
returns table (
  endpoint_id uuid, organization_id uuid, project_id uuid, connection_id uuid, provider text,
  provider_account_id uuid, connection_status text, endpoint_status text, environment text,
  connection_disabled boolean, is_demo boolean, config jsonb
)
language sql stable security definer set search_path = ''
as $$
  select e.id, e.organization_id, e.project_id, e.connection_id, c.provider, c.provider_account_id,
         c.status, e.status, c.environment, c.disabled_at is not null, o.is_demo, c.config
    from public.webhook_endpoints e
    join public.provider_connections c on c.organization_id = e.organization_id and c.id = e.connection_id
    join public.organizations o on o.id = e.organization_id
   where e.token_hash = p_token_hash
$$;
revoke all on function app.resolve_webhook_endpoint(bytea) from public;
grant execute on function app.resolve_webhook_endpoint(bytea) to tracker_system;

-- Recebimentos: corpo bruto preservado, idempotência por (organização, conta lógica, chave do evento) (R09-05, R09-14).
create table public.webhook_receipts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null,
  connection_id uuid not null,
  endpoint_id uuid,
  provider text not null,
  provider_account_id uuid not null,
  dedup_key text not null,
  dedup_method text not null check (dedup_method in ('provider_event_id', 'provider_idempotency_header', 'fingerprint')),
  source_event_type text,
  received_at timestamptz not null default now(),
  body bytea not null,
  body_sha256 bytea not null,
  content_type text,
  headers jsonb not null default '{}',
  auth_method text not null,
  delivery_count int not null default 1,
  last_delivery_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'processed', 'quarantined', 'ignored', 'failed', 'dead')),
  status_reason text,
  attempts int not null default 0,
  processed_at timestamptz,
  is_test boolean not null default false,
  is_demo boolean not null default false,
  unique (organization_id, provider_account_id, dedup_key),
  unique (organization_id, id),
  foreign key (organization_id, connection_id) references public.provider_connections (organization_id, id) on delete cascade,
  foreign key (organization_id, provider_account_id) references public.provider_accounts (organization_id, id) on delete cascade
);
create index webhook_receipts_org_time_idx on public.webhook_receipts (organization_id, received_at desc);
create index webhook_receipts_status_idx on public.webhook_receipts (organization_id, status) where status in ('pending', 'failed', 'quarantined');
select app.setup_org_table('public.webhook_receipts', 'ro');

-- Rejeições (assinatura/token inválidos) para diagnóstico, sem corpo (T19).
create table public.webhook_rejections (
  id bigserial primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  endpoint_id uuid,
  reason text not null,
  received_at timestamptz not null default now()
);
create index webhook_rejections_org_idx on public.webhook_rejections (organization_id, received_at desc);
select app.setup_org_table('public.webhook_rejections', 'ro');
grant usage on sequence public.webhook_rejections_id_seq to tracker_system;

-- Outbox transacional: registro durável de todo trabalho assíncrono (R05-04, R42-03, T22, T23).
create table public.outbox (
  id bigserial primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  topic text not null,
  payload jsonb not null default '{}',
  dedup_key text not null,
  priority int not null default 5,
  status text not null default 'pending' check (status in ('pending', 'enqueued', 'done', 'failed', 'dead')),
  attempts int not null default 0,
  max_attempts int not null default 8,
  available_at timestamptz not null default now(),
  enqueued_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (organization_id, topic, dedup_key)
);
create index outbox_pending_idx on public.outbox (available_at, priority) where status = 'pending';
create index outbox_enqueued_idx on public.outbox (enqueued_at) where status = 'enqueued';
create index outbox_org_status_idx on public.outbox (organization_id, status);
select app.setup_org_table('public.outbox', 'ro');
grant usage on sequence public.outbox_id_seq to tracker_system;

-- Relay: reivindica trabalho de todas as organizações (única operação entre organizações), com lock
-- SKIP LOCKED mantido até o fim da transação do chamador. Reenfileira também itens "enqueued" antigos,
-- cobrindo perda de jobs no Redis (T23).
create or replace function app.outbox_claim(p_limit int, p_stale_seconds int)
returns table (id bigint, organization_id uuid, topic text, priority int, attempts int)
language sql volatile security definer set search_path = ''
as $$
  select o.id, o.organization_id, o.topic, o.priority, o.attempts
    from public.outbox o
   where (o.status = 'pending' and o.available_at <= now())
      or (o.status = 'enqueued' and o.enqueued_at < now() - make_interval(secs => p_stale_seconds))
   order by o.priority, o.available_at
   limit p_limit
   for update skip locked
$$;

create or replace function app.outbox_mark_enqueued(p_ids bigint[])
returns void
language sql volatile security definer set search_path = ''
as $$
  update public.outbox set status = 'enqueued', enqueued_at = now() where id = any(p_ids) and status in ('pending', 'enqueued')
$$;

create or replace function app.outbox_stats()
returns table (status text, total bigint, oldest timestamptz)
language sql stable security definer set search_path = ''
as $$
  select o.status, count(*), min(o.created_at) from public.outbox o where o.status in ('pending', 'enqueued', 'failed', 'dead') group by o.status
$$;

revoke all on function app.outbox_claim(int, int), app.outbox_mark_enqueued(bigint[]), app.outbox_stats() from public;
grant execute on function app.outbox_claim(int, int), app.outbox_mark_enqueued(bigint[]), app.outbox_stats() to tracker_system;
