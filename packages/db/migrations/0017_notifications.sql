-- Central de notificações e alertas (R34-01..R34-04) e agendador do worker.

-- Notificações por destinatário. Conteúdo sem dados pessoais do comprador (seguro para tela bloqueada).
-- semantic_key = fato de origem (ex.: "sale.approved:<pedido>:<transação>"): uma notificação por fato e usuário.
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references iam.users(id) on delete cascade,
  project_id uuid,
  kind text not null check (kind ~ '^[a-z_]+\.[a-z_]+$'),
  severity text not null check (severity in ('info', 'success', 'warning', 'critical')),
  title text not null check (char_length(title) between 1 and 200),
  body text not null default '' check (char_length(body) <= 500),
  link text check (link is null or link ~ '^/[A-Za-z0-9/_?=&.%-]*$'),
  semantic_key text not null check (char_length(semantic_key) between 1 and 300),
  data jsonb not null default '{}',
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (organization_id, user_id, semantic_key),
  unique (organization_id, id)
);
create index notifications_user_idx on public.notifications (organization_id, user_id, created_at desc);
create index notifications_unread_idx on public.notifications (organization_id, user_id) where read_at is null;
select app.setup_org_table('public.notifications', 'none');
-- Cada usuário vê e marca como lidas apenas as próprias notificações da organização ativa.
create policy own_app on public.notifications for all to tracker_app
  using (organization_id = (select app.member_org_id()) and user_id = (select app.current_user_id()))
  with check (organization_id = (select app.member_org_id()) and user_id = (select app.current_user_id()));
grant select on public.notifications to tracker_app;
grant update (read_at) on public.notifications to tracker_app;

-- Preferências por usuário e organização (canais por tipo, projetos, horário silencioso, som, valores ocultos).
create table public.notification_preferences (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references iam.users(id) on delete cascade,
  kinds jsonb not null default '{}',
  project_ids uuid[] not null default '{}',
  quiet_start text check (quiet_start is null or quiet_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  quiet_end text check (quiet_end is null or quiet_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  sound_enabled boolean not null default false,
  sound_volume int not null default 60 check (sound_volume between 0 and 100),
  hide_amounts boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
select app.setup_org_table('public.notification_preferences', 'none');
create policy own_app on public.notification_preferences for all to tracker_app
  using (organization_id = (select app.member_org_id()) and user_id = (select app.current_user_id()))
  with check (organization_id = (select app.member_org_id()) and user_id = (select app.current_user_id()));
grant select, insert, update on public.notification_preferences to tracker_app;

-- Inscrições de Web Push (por dispositivo/navegador). As chaves p256dh/auth só servem para cifrar mensagens
-- àquele navegador; não são expostas de volta pela API.
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references iam.users(id) on delete cascade,
  endpoint text not null check (char_length(endpoint) between 12 and 2048 and endpoint like 'https://%'),
  p256dh text not null check (char_length(p256dh) between 20 and 200),
  auth text not null check (char_length(auth) between 8 and 100),
  label text check (label is null or char_length(label) <= 120),
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text,
  consecutive_failures int not null default 0,
  disabled_at timestamptz,
  disabled_reason text,
  unique (organization_id, endpoint),
  unique (organization_id, id)
);
create index push_subscriptions_user_idx on public.push_subscriptions (organization_id, user_id) where disabled_at is null;
select app.setup_org_table('public.push_subscriptions', 'none');
create policy own_app on public.push_subscriptions for all to tracker_app
  using (organization_id = (select app.member_org_id()) and user_id = (select app.current_user_id()))
  with check (organization_id = (select app.member_org_id()) and user_id = (select app.current_user_id()));
grant select (id, organization_id, user_id, label, created_at, last_success_at, last_failure_at, last_error, consecutive_failures, disabled_at, disabled_reason) on public.push_subscriptions to tracker_app;
grant insert, delete on public.push_subscriptions to tracker_app;

-- Entregas externas (e-mail, push): uma por notificação, canal e alvo; tentativas registradas.
create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  notification_id uuid not null,
  channel text not null check (channel in ('email', 'push')),
  push_subscription_id uuid,
  status text not null default 'pending' check (status in ('pending', 'retry_scheduled', 'sent', 'failed', 'skipped')),
  attempts int not null default 0,
  last_error text,
  last_http_status int,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (organization_id, notification_id, channel, push_subscription_id),
  foreign key (organization_id, notification_id) references public.notifications (organization_id, id) on delete cascade,
  foreign key (organization_id, push_subscription_id) references public.push_subscriptions (organization_id, id) on delete cascade
);
create unique index notification_deliveries_email_uq on public.notification_deliveries (organization_id, notification_id) where channel = 'email';
select app.setup_org_table('public.notification_deliveries', 'none');

-- Estado dos monitores periódicos por organização (último alerta por assunto, para não repetir).
create table public.monitor_state (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  subject text not null,
  state text not null,
  since timestamptz not null default now(),
  last_notified_at timestamptz,
  details jsonb not null default '{}',
  primary key (organization_id, subject)
);
select app.setup_org_table('public.monitor_state', 'ro');

-- Agendador: única leitura entre organizações (IDs ativos), para enfileirar os ciclos periódicos por organização.
create or replace function app.scheduler_org_ids()
returns table (id uuid)
language sql stable security definer set search_path = ''
as $$ select o.id from public.organizations o where exists (select 1 from public.memberships m where m.organization_id = o.id and m.status = 'active') $$;
revoke all on function app.scheduler_org_ids() from public;
grant execute on function app.scheduler_org_ids() to tracker_system;
