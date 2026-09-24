-- Visão de clientes (R24-04): agrupamento explicável por e-mail normalizado (hash) dentro da organização,
-- com exclusões reversíveis. Nunca usado para atribuição nem compartilhado entre organizações.
create index if not exists order_contacts_email_idx on public.order_contacts (organization_id, email_sha256) where email_sha256 is not null;

create table public.customer_exclusions (
  organization_id uuid not null,
  order_id uuid not null,
  reason text not null check (char_length(reason) between 1 and 300),
  created_by uuid,
  created_at timestamptz not null default now(),
  primary key (organization_id, order_id),
  foreign key (organization_id, order_id) references public.orders (organization_id, id) on delete cascade
);
select app.setup_org_table('public.customer_exclusions', 'rw');
