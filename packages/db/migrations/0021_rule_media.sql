-- Regras com ações de mídia reais: "skipped_noop" quando a entidade já está no estado pedido (não é falha).
alter table public.rule_actions drop constraint rule_actions_status_check;
alter table public.rule_actions add constraint rule_actions_status_check
  check (status in ('executed', 'failed', 'skipped_capability', 'skipped_permission', 'skipped_noop'));
alter table public.rule_actions add column media_change_id uuid;
