-- Entidades de mídia registradas por importação da própria organização e histórico de nomes por data (T39).

-- Correção: a importação CSV (papel tracker_app) registra nomes/entidades; antes só havia leitura.
grant select, insert, update on public.ad_entities to tracker_app;
grant select, insert, update on public.ad_entity_names to tracker_app;
grant usage on sequence public.ad_entity_names_id_seq to tracker_app;

-- Origem do registro da entidade: API da rede (verificada) ou importação/manual (declarada pela organização).
alter table public.ad_entities add column source text not null default 'api' check (source in ('api', 'csv', 'manual'));

-- Datas (da conta) em que cada nome foi observado: o nome vigente é o de observação mais recente; a junção é sempre por ID.
alter table public.ad_entity_names
  add column first_seen_date date,
  add column last_seen_date date;
create index ad_entity_names_lookup_idx on public.ad_entity_names (organization_id, level, external_id);
