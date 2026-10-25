-- Motor de regras e automações (R26) e metas/alertas por regra (R23-11).

create table public.rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text check (description is null or char_length(description) <= 500),
  -- draft: em edição; simulate: avalia no agendador sem executar; active: executa; paused: parada manual;
  -- suspended: parada automática (circuit breaker / permissão perdida).
  status text not null default 'draft' check (status in ('draft', 'simulate', 'active', 'paused', 'suspended')),
  current_version int not null default 1,
  preset_key text,
  status_reason text,
  consecutive_failures int not null default 0,
  last_run_at timestamptz,
  next_run_at timestamptz,
  activated_by uuid references iam.users(id),
  activated_at timestamptz,
  created_by uuid references iam.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);
create index rules_due_idx on public.rules (organization_id, next_run_at) where status in ('simulate', 'active');
create trigger rules_touch before update on public.rules for each row execute function app.touch_updated_at();
select app.setup_org_table('public.rules', 'rw');

-- Versões imutáveis (R26-05): editar cria nova versão; execuções guardam a versão usada.
create table public.rule_versions (
  organization_id uuid not null,
  rule_id uuid not null,
  version int not null check (version >= 1),
  definition jsonb not null,
  created_by uuid references iam.users(id),
  created_at timestamptz not null default now(),
  primary key (organization_id, rule_id, version),
  foreign key (organization_id, rule_id) references public.rules (organization_id, id) on delete cascade
);
create or replace function app.rule_versions_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'Versões de regra são imutáveis; crie uma nova versão';
end $$;
create trigger rule_versions_no_update before update on public.rule_versions for each row execute function app.rule_versions_immutable();
select app.setup_org_table('public.rule_versions', 'none');
create policy org_app on public.rule_versions for all to tracker_app
  using (organization_id = (select app.member_org_id())) with check (organization_id = (select app.member_org_id()));
grant select, insert on public.rule_versions to tracker_app;

-- Execuções (agendadas, manuais ou simulações) com os dados de contexto usados.
create table public.rule_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  rule_id uuid,
  version int,
  trigger text not null check (trigger in ('schedule', 'manual', 'simulation')),
  mode text not null check (mode in ('simulate', 'execute')),
  status text not null default 'running' check (status in ('running', 'ok', 'skipped', 'failed')),
  skip_reason text,
  as_of timestamptz not null,
  window_from date,
  window_to date,
  context jsonb not null default '{}',
  summary jsonb not null default '{}',
  definition jsonb,
  created_by uuid,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, rule_id) references public.rules (organization_id, id) on delete cascade
);
create index rule_runs_rule_idx on public.rule_runs (organization_id, rule_id, started_at desc);
select app.setup_org_table('public.rule_runs', 'ro');

-- Decisão por entidade avaliada: métricas usadas, árvore da avaliação e explicação legível (R26-05, R26-12).
create table public.rule_decisions (
  id bigserial primary key,
  organization_id uuid not null,
  run_id uuid not null,
  entity_level text not null,
  entity_id text,
  entity_name text,
  decision text not null,
  explanation text not null,
  metrics jsonb not null default '{}',
  evaluation jsonb not null default '{}',
  actions jsonb not null default '[]',
  foreign key (organization_id, run_id) references public.rule_runs (organization_id, id) on delete cascade
);
create index rule_decisions_run_idx on public.rule_decisions (organization_id, run_id);
select app.setup_org_table('public.rule_decisions', 'ro');
grant usage on sequence public.rule_decisions_id_seq to tracker_system;

-- Ações executadas (ou tentadas): idempotência por regra/versão/entidade/janela; base do cooldown e do teto diário.
create table public.rule_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  rule_id uuid not null,
  version int not null,
  run_id uuid not null,
  entity_level text not null,
  entity_id text,
  action_type text not null,
  idempotency_key text not null,
  status text not null check (status in ('executed', 'failed', 'skipped_capability', 'skipped_permission')),
  detail text,
  result jsonb not null default '{}',
  executed_at timestamptz not null default now(),
  unique (organization_id, idempotency_key),
  foreign key (organization_id, rule_id) references public.rules (organization_id, id) on delete cascade,
  foreign key (organization_id, run_id) references public.rule_runs (organization_id, id) on delete cascade
);
create index rule_actions_entity_idx on public.rule_actions (organization_id, entity_level, entity_id, executed_at desc);
create index rule_actions_rule_idx on public.rule_actions (organization_id, rule_id, executed_at desc);
select app.setup_org_table('public.rule_actions', 'ro');

-- Tags internas em entidades de mídia (ação "tag"): não alteram nada na rede.
create table public.entity_tags (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entity_level text not null check (entity_level in ('campaign', 'adset', 'ad')),
  entity_id text not null,
  tag text not null check (char_length(tag) between 1 and 40),
  rule_id uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  primary key (organization_id, entity_level, entity_id, tag)
);
select app.setup_org_table('public.entity_tags', 'rw');

-- Parada de emergência por projeto (a de organização fica em organizations.settings.rules_paused; a do sistema em
-- RULES_KILL_SWITCH no ambiente). R26-11.
create table public.rule_project_pauses (
  organization_id uuid not null,
  project_id uuid not null,
  reason text,
  paused_by uuid,
  paused_at timestamptz not null default now(),
  primary key (organization_id, project_id),
  foreign key (organization_id, project_id) references public.projects (organization_id, id) on delete cascade
);
select app.setup_org_table('public.rule_project_pauses', 'rw');

-- Webhook de saída para regras disparadas (ação "webhook").
alter table public.webhook_subscriptions drop constraint webhook_subscriptions_events_check;
alter table public.webhook_subscriptions add constraint webhook_subscriptions_events_check
  check (cardinality(events) > 0 and events <@ array['order.approved', 'order.reversed', 'order.status_changed', 'rule.triggered']::text[]);
