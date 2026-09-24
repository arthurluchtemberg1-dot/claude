-- 0005 — Rastreamento (visitantes, sessões, eventos, toques, tokens de link, consentimento) e atribuição (R13, R15, R16).

create table public.visitors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  -- Identificador anônimo aleatório gerado pelo SDK (sem fingerprinting, R13-23).
  anon_id text not null check (anon_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, project_id, anon_id),
  unique (organization_id, id),
  foreign key (organization_id, project_id) references public.projects (organization_id, id) on delete cascade
);
select app.setup_org_table('public.visitors', 'ro');

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  visitor_id uuid not null,
  session_key text not null check (session_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  started_at timestamptz not null,
  last_event_at timestamptz not null,
  landing_url text,
  referrer_host text,
  utm jsonb not null default '{}',
  click_ids jsonb not null default '{}',
  channel text not null,
  is_paid boolean not null default false,
  network text,
  classification_reason text,
  created_at timestamptz not null default now(),
  unique (organization_id, project_id, session_key),
  unique (organization_id, id),
  foreign key (organization_id, visitor_id) references public.visitors (organization_id, id) on delete cascade
);
create index sessions_visitor_idx on public.sessions (organization_id, visitor_id, started_at);
create index sessions_project_time_idx on public.sessions (organization_id, project_id, started_at);
select app.setup_org_table('public.sessions', 'ro');

create table public.tracking_events (
  id bigserial primary key,
  organization_id uuid not null,
  project_id uuid not null,
  visitor_id uuid not null,
  session_id uuid,
  -- ID gerado no cliente para deduplicar reenvios do SDK.
  client_event_id text not null check (client_event_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  event_name text not null check (char_length(event_name) between 1 and 64),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  page_url text,
  properties jsonb not null default '{}',
  consent jsonb not null default '{}',
  is_test boolean not null default false,
  unique (organization_id, project_id, client_event_id),
  foreign key (organization_id, visitor_id) references public.visitors (organization_id, id) on delete cascade
);
create index tracking_events_project_time_idx on public.tracking_events (organization_id, project_id, occurred_at desc);
create index tracking_events_name_idx on public.tracking_events (organization_id, project_id, event_name, occurred_at desc);
select app.setup_org_table('public.tracking_events', 'ro');
grant usage on sequence public.tracking_events_id_seq to tracker_system;

-- Token opaco para ligar sessão ao pedido pelo checkout (R15-02). Guardado como hash; exibido só com dica.
create table public.link_tokens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  visitor_id uuid not null,
  session_id uuid,
  token_hash bytea not null,
  token_hint text not null,
  destination_host text,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  first_order_id uuid,
  first_linked_at timestamptz,
  unique (organization_id, project_id, token_hash),
  foreign key (organization_id, visitor_id) references public.visitors (organization_id, id) on delete cascade
);
create index link_tokens_session_idx on public.link_tokens (organization_id, session_id);
select app.setup_org_table('public.link_tokens', 'ro');

create table public.consent_records (
  id bigserial primary key,
  organization_id uuid not null,
  project_id uuid not null,
  visitor_id uuid not null,
  analytics boolean,
  advertising boolean,
  storage boolean,
  source text not null,
  recorded_at timestamptz not null default now(),
  foreign key (organization_id, visitor_id) references public.visitors (organization_id, id) on delete cascade
);
create index consent_records_visitor_idx on public.consent_records (organization_id, visitor_id, recorded_at desc);
select app.setup_org_table('public.consent_records', 'ro');
grant usage on sequence public.consent_records_id_seq to tracker_system;

-- Toques usados pela atribuição. evidence: token_link | checkout_source | session | identity.
create table public.touchpoints (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  visitor_id uuid,
  session_id uuid,
  order_id uuid,
  occurred_at timestamptz not null,
  channel text not null,
  is_paid boolean not null,
  network text,
  evidence text not null check (evidence in ('token_link', 'checkout_source', 'session', 'identity')),
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  campaign_id text,
  adset_id text,
  ad_id text,
  ids_validated boolean not null default false,
  click_ids jsonb not null default '{}',
  declared boolean not null default false,
  classification_reason text,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, order_id) references public.orders (organization_id, id) on delete cascade
);
create index touchpoints_visitor_idx on public.touchpoints (organization_id, visitor_id, occurred_at);
create index touchpoints_order_idx on public.touchpoints (organization_id, order_id);
create unique index touchpoints_session_unique on public.touchpoints (organization_id, session_id) where session_id is not null and evidence = 'session';
create unique index touchpoints_checkout_unique on public.touchpoints (organization_id, order_id) where evidence = 'checkout_source';
select app.setup_org_table('public.touchpoints', 'ro');

-- Vínculo pedido ↔ visitante com evidência (token devolvido, etc.).
create table public.order_visitor_links (
  organization_id uuid not null,
  order_id uuid not null,
  visitor_id uuid not null,
  evidence text not null check (evidence in ('token_link', 'identity')),
  link_token_id uuid,
  linked_at timestamptz not null default now(),
  primary key (organization_id, order_id, visitor_id),
  foreign key (organization_id, order_id) references public.orders (organization_id, id) on delete cascade,
  foreign key (organization_id, visitor_id) references public.visitors (organization_id, id) on delete cascade
);
select app.setup_org_table('public.order_visitor_links', 'ro');

-- Políticas de atribuição versionadas: cada alteração cria nova versão imutável (R16-01, R16-06).
create table public.attribution_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  policy_key text not null,
  name text not null,
  version int not null check (version >= 1),
  model text not null check (model in ('first_touch', 'last_touch', 'last_non_direct', 'first_paid_click', 'last_paid_click', 'explicit_order', 'linear')),
  window_days int not null check (window_days between 1 and 90),
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, policy_key, version),
  unique (organization_id, id)
);
create unique index attribution_policies_default_idx on public.attribution_policies (organization_id) where is_default and is_active;
select app.setup_org_table('public.attribution_policies', 'rw');

create table public.order_attributions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null,
  order_id uuid not null,
  policy_id uuid not null,
  policy_key text not null,
  policy_version int not null,
  model text not null,
  window_days int not null,
  conversion_at timestamptz not null,
  category text not null check (category in ('paid', 'organic', 'direct', 'recovery', 'unattributed')),
  selected_touchpoint_id uuid,
  evidence text,
  quality text not null,
  reason text not null,
  unattributed_reason text,
  path jsonb not null default '[]',
  credits jsonb not null default '[]',
  network text,
  campaign_id text,
  adset_id text,
  ad_id text,
  utm_source text,
  utm_campaign text,
  computed_at timestamptz not null default now(),
  is_current boolean not null default true,
  recalculation_of uuid,
  unique (organization_id, id),
  foreign key (organization_id, order_id) references public.orders (organization_id, id) on delete cascade,
  foreign key (organization_id, policy_id) references public.attribution_policies (organization_id, id)
);
create unique index order_attributions_current_idx on public.order_attributions (organization_id, order_id, policy_key) where is_current;
create index order_attributions_campaign_idx on public.order_attributions (organization_id, campaign_id) where is_current;
select app.setup_org_table('public.order_attributions', 'ro');
