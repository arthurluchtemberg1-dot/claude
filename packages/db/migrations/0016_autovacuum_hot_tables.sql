-- Estatísticas do planejador atualizadas logo após picos de ingestão (D-028). Medido no teste de carga: sem ANALYZE
-- após ~2.000 vendas em base nova, o resumo de métricas teve p95 ≈ 22 s (planos com laços aninhados); após ANALYZE,
-- p95 ≈ 0,5 s. O papel da aplicação não pode executar ANALYZE; o autovacuum passa a analisar essas tabelas com
-- limiares menores (o intervalo do autovacuum é configuração do servidor: autovacuum_naptime).
do $$
declare t text;
begin
  foreach t in array array['public.orders', 'public.financial_entries', 'public.payment_transactions', 'public.order_attributions',
                           'public.touchpoints', 'public.order_visitor_links', 'public.webhook_receipts', 'public.outbox',
                           'public.order_contacts', 'public.sessions', 'public.visitors', 'public.tracking_events', 'public.normalized_events']
  loop
    execute format('alter table %s set (autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 200)', t);
  end loop;
end $$;
