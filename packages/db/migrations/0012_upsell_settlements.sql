-- Vínculo de upsell/downsell comprovado pela origem (R10-06, R10-07, T16) e recebíveis/liquidações (R10-08, T18).

-- O pedido original pode chegar depois do upsell: guardamos o ID externo declarado e resolvemos o vínculo quando o
-- pedido original existir na MESMA conta lógica do provedor e no mesmo projeto. Nunca por e-mail ou similaridade.
alter table public.orders
  add column parent_external_order_id text check (char_length(parent_external_order_id) between 1 and 200),
  add constraint orders_parent_not_self check (parent_order_id is null or parent_order_id <> id);
create index orders_parent_pending_idx on public.orders (organization_id, provider_account_id, parent_external_order_id)
  where parent_external_order_id is not null and parent_order_id is null;
create index orders_parent_idx on public.orders (organization_id, parent_order_id) where parent_order_id is not null;

-- Parcelas do cartão (informativo; a receita é a da aprovação).
alter table public.payment_transactions add column installments int check (installments between 1 and 99);

-- Vínculo herdado: o upsell comprovado herda o visitante vinculado ao pedido original.
alter table public.order_visitor_links drop constraint order_visitor_links_evidence_check;
alter table public.order_visitor_links
  add constraint order_visitor_links_evidence_check check (evidence in ('token_link', 'identity', 'parent_order')),
  add column inherited_from_order_id uuid,
  add constraint order_visitor_links_inherited_fk foreign key (organization_id, inherited_from_order_id)
    references public.orders (organization_id, id) on delete cascade,
  add constraint order_visitor_links_inherited_chk check ((evidence = 'parent_order') = (inherited_from_order_id is not null));

-- Recebíveis e liquidações (repasses). Fora do razão de receita: nenhuma métrica de venda soma esta tabela.
create table public.settlements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null,
  order_id uuid not null,
  provider_account_id uuid not null,
  settlement_key text not null,
  stage text not null check (stage in ('scheduled', 'paid', 'canceled')),
  transaction_key text not null,
  installment_number int check (installment_number between 1 and 99),
  installment_count int check (installment_count between 1 and 99),
  gross_minor bigint check (gross_minor >= 0),
  fee_minor bigint check (fee_minor >= 0),
  net_minor bigint not null check (net_minor >= 0),
  currency char(3) not null,
  anticipated boolean not null default false,
  expected_at timestamptz,
  occurred_at timestamptz not null,
  source_receipt_id uuid,
  is_test boolean not null default false,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  -- Cada estágio de um recebível é registrado uma única vez (repetições do webhook não duplicam).
  unique (organization_id, provider_account_id, settlement_key, stage),
  unique (organization_id, id),
  foreign key (organization_id, project_id) references public.projects (organization_id, id) on delete cascade,
  foreign key (organization_id, order_id) references public.orders (organization_id, id) on delete cascade,
  foreign key (organization_id, provider_account_id) references public.provider_accounts (organization_id, id) on delete cascade
);
create index settlements_order_idx on public.settlements (organization_id, order_id);
create index settlements_occurred_idx on public.settlements (organization_id, occurred_at desc);
select app.setup_org_table('public.settlements', 'ro');
