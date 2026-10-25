-- Gestor IA (R27): conversas por usuário, mensagens, auditoria de ferramentas, uso diário e chave própria.

alter table private.credentials drop constraint credentials_purpose_check;
alter table private.credentials add constraint credentials_purpose_check check (purpose in (
  'webhook_secret', 'oauth_access_token', 'oauth_refresh_token', 'api_key', 'capi_access_token', 'outbound_signing_secret', 'totp_secret', 'ai_api_key'));

create table public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references iam.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  status text not null default 'idle' check (status in ('idle', 'running')),
  cancel_requested boolean not null default false,
  -- Histórico no formato do provedor que o produziu (anexado sem edição).
  provider text,
  model text,
  transcript jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  retention_until timestamptz not null default now() + interval '180 days',
  unique (organization_id, id)
);
create index ai_conversations_user_idx on public.ai_conversations (organization_id, user_id, updated_at desc);
select app.setup_org_table('public.ai_conversations', 'none');
create policy own_app on public.ai_conversations for all to tracker_app
  using (organization_id = (select app.member_org_id()) and user_id = (select app.current_user_id()))
  with check (organization_id = (select app.member_org_id()) and user_id = (select app.current_user_id()));
-- O painel não lê o histórico bruto do provedor (só as mensagens).
grant select (id, organization_id, user_id, title, status, cancel_requested, provider, model, created_at, updated_at, retention_until) on public.ai_conversations to tracker_app;
grant update (cancel_requested, title) on public.ai_conversations to tracker_app;
grant delete on public.ai_conversations to tracker_app;

create table public.ai_messages (
  id bigserial primary key,
  organization_id uuid not null,
  conversation_id uuid not null,
  role text not null check (role in ('user', 'assistant')),
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed', 'refused', 'canceled')),
  content text not null check (char_length(content) <= 100000),
  error text,
  -- Ferramentas consultadas (nome e parâmetros): base para conferir de onde veio cada número (R27-06).
  sources jsonb not null default '[]',
  attachments jsonb not null default '{}',
  model text,
  usage jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  foreign key (organization_id, conversation_id) references public.ai_conversations (organization_id, id) on delete cascade
);
create index ai_messages_conv_idx on public.ai_messages (organization_id, conversation_id, id);
select app.setup_org_table('public.ai_messages', 'none');
create policy own_app on public.ai_messages for select to tracker_app
  using (organization_id = (select app.member_org_id())
         and exists (select 1 from public.ai_conversations c where c.organization_id = ai_messages.organization_id and c.id = ai_messages.conversation_id and c.user_id = (select app.current_user_id())));
grant select on public.ai_messages to tracker_app;
grant usage on sequence public.ai_messages_id_seq to tracker_system;

-- Auditoria das consultas da IA (R27-08): ferramenta, parâmetros (sem dados pessoais), tamanho e duração.
create table public.ai_tool_calls (
  id bigserial primary key,
  organization_id uuid not null,
  conversation_id uuid not null,
  message_id bigint,
  tool text not null,
  input jsonb not null default '{}',
  ok boolean not null,
  result_bytes int,
  duration_ms int,
  created_at timestamptz not null default now(),
  retention_until timestamptz not null default now() + interval '180 days',
  foreign key (organization_id, conversation_id) references public.ai_conversations (organization_id, id) on delete cascade
);
create index ai_tool_calls_conv_idx on public.ai_tool_calls (organization_id, conversation_id, id);
select app.setup_org_table('public.ai_tool_calls', 'ro');
grant usage on sequence public.ai_tool_calls_id_seq to tracker_system;

-- Uso diário por organização (limites de perguntas e tokens — R27-11).
create table public.ai_usage_daily (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  day date not null,
  requests int not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  primary key (organization_id, day)
);
select app.setup_org_table('public.ai_usage_daily', 'ro');
