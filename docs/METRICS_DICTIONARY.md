# Dicionário de métricas

> Gerado por `pnpm docs:metrics` a partir de `packages/domain/src/metrics/definitions.ts` (fonte única usada por API, painel e testes; R22-01).

## Princípios

- Dinheiro em inteiros na menor unidade da moeda (`bigint`); razões como frações exatas, arredondadas só na apresentação.
- Denominador zero → **indefinido** ("—") com motivo; dado ausente → **indisponível** (nunca zero). Qualidade: completo, parcial ou estimado.
- Moedas nunca são somadas sem câmbio identificado e datado; sem câmbio, cada moeda é exibida separadamente.
- Períodos locais no fuso da organização convertidos para UTC como intervalo `[início, fim)`.
- Bases temporais: **por aprovação** (pedidos pela primeira confirmação no período; estornos da coorte até `as_of`), **por movimento financeiro** (cada lançamento na data em que ocorreu) e **por coorte de aquisição** (atualmente igual à base por aprovação; receita posterior de clientes requer identidade de cliente — pendente).
- Atribuição: ROAS/CPA usam os pedidos creditados pela política selecionada (padrão: último clique pago elegível, 7 dias). Modelos fracionados são rotulados como "conversões creditadas".
- Gasto: um único nível por conta de anúncios (conta > campanha > conjunto > anúncio) e uma única fonte por entidade/dia (API > CSV > manual), evitando dupla contagem; reimportação substitui o snapshot.

## Fixture obrigatória (R43-02)

Pedidos de R$100 e R$50 aprovados, taxas R$5, investimento R$30, estorno parcial de R$20 e integral de R$50 → receita bruta R$150, estornos R$70, após estornos R$80, 2 aprovados, 1 retido, CPA aprovado R$15, CPA retido R$30, ticket R$75, ROAS bruto 5, ROAS após estornos 80/30, contribuição R$45. Verificada em `packages/domain/test/metrics-fixture.test.ts` e ponta a ponta via webhooks + API em `apps/api/test/integration/webhook-pipeline.test.ts`, com repetição de todos os webhooks.

## Métricas

| ID | Métrica | Unidade | Fórmula | Denominador | Fonte | Estornos | Bases | Observações |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `orders_generated` | Pedidos gerados | count | COUNT(DISTINCT pedido) com qualquer evento conhecido no período (criação na origem) | — | orders (checkouts que enviam pedidos pendentes) | Não afetado por estornos | por aprovação | Indisponível quando o checkout só envia aprovações; nunca exibido como zero nesse caso. |
| `approved_orders_gross` | Pedidos aprovados brutos | count | COUNT(DISTINCT pedido) com primeira confirmação válida no período | — | financial_entries tipo approval | Mantém pedidos depois estornados | por aprovação, por coorte de aquisição | — |
| `retained_orders` | Pedidos retidos | count | Aprovados brutos que não foram integralmente revertidos até as_of | — | financial_entries (approval, refund, chargeback, chargeback_reversal) | Estorno parcial permanece retido e identificado | por aprovação, por coorte de aquisição | — |
| `gross_approved_revenue` | Receita bruta aprovada | money | Σ valor confirmado das transações (uma vez por transação; sem itens, parcelas ou repasses) | — | financial_entries tipo approval | Bruto original preservado | por aprovação, por movimento financeiro, por coorte de aquisição | — |
| `financial_reversals` | Estornos financeiros | money | Σ reembolsos efetivos + chargebacks efetivos − disputas ganhas (sem dupla dedução) | — | financial_entries tipos refund, chargeback, chargeback_reversal | Por aprovação: estornos da coorte até as_of; por movimento: na data do estorno | por aprovação, por movimento financeiro, por coorte de aquisição | — |
| `revenue_after_reversals` | Receita após estornos | money | Receita bruta aprovada − estornos financeiros (mesma base) | — | financial_entries | Deduz estornos da mesma base de análise | por aprovação, por movimento financeiro, por coorte de aquisição | — |
| `org_revenue` | Receita da organização | money | Participação informada pela origem (após reversões) + receita após estornos de pedidos em que a organização é produtora sem participação informada | — | financial_entries tipos org_share/org_share_reversal; papel da conexão | Redução proporcional da participação é rotulada como estimada | por aprovação, por movimento financeiro, por coorte de aquisição | Afiliado/coprodutor sem participação informada fica indisponível (parcial), nunca igual ao bruto. |
| `media_spend` | Investimento em mídia | money | Σ gasto importado (snapshot mais recente por entidade/dia) + gastos manuais validados | — | ad_spend_daily (origem: API da rede, CSV ou manual) | Não se aplica | por aprovação, por movimento financeiro, por coorte de aquisição | Sem sincronização ou cobertura parcial → indisponível/parcial, não zero. |
| `roas_gross` | ROAS bruto | ratio | Receita bruta atribuída / investimento da mesma entidade e período | Investimento em mídia | order_attributions + ad_spend_daily | Não deduz estornos | por aprovação, por coorte de aquisição | — |
| `roas_after_reversals` | ROAS após estornos | ratio | Receita atribuída após estornos / investimento correspondente | Investimento em mídia | order_attributions + financial_entries + ad_spend_daily | Deduz estornos da coorte até as_of | por aprovação, por coorte de aquisição | — |
| `mer` | MER | ratio | Receita total da operação / gasto total de mídia (não é ROAS atribuído) | Gasto total de mídia | financial_entries + ad_spend_daily | Usa receita após estornos da base escolhida | por aprovação, por movimento financeiro, por coorte de aquisição | — |
| `cpa_approved` | CPA aprovado | money | Investimento / pedidos aprovados creditados pela regra selecionada | Pedidos aprovados creditados | ad_spend_daily + order_attributions | Não considera estornos | por aprovação, por coorte de aquisição | — |
| `cpa_retained` | CPA retido | money | Investimento / pedidos retidos creditados pela regra selecionada | Pedidos retidos creditados | ad_spend_daily + order_attributions + financial_entries | Exclui pedidos integralmente revertidos | por aprovação, por coorte de aquisição | — |
| `avg_ticket_gross` | Ticket médio bruto | money | Receita bruta aprovada / pedidos aprovados brutos | Pedidos aprovados brutos | financial_entries | Bruto | por aprovação, por coorte de aquisição | — |
| `cpl` | CPL | money | Investimento / leads definidos e deduplicados da mesma fonte/coorte | Leads deduplicados | tracking_events Lead + ad_spend_daily | Não se aplica | por aprovação | — |
| `link_ctr` | CTR de link | percent | Cliques no link / impressões | Impressões | ad_insights (métricas reportadas pela rede) | Não se aplica | por aprovação | — |
| `link_cpc` | CPC de link | money | Investimento / cliques no link | Cliques no link | ad_insights | Não se aplica | por aprovação | — |
| `cpm` | CPM | money | Investimento / impressões × 1.000 | Impressões | ad_insights | Não se aplica | por aprovação | — |
| `page_conversion` | Conversão da página | percent | Pedidos atribuídos / sessões elegíveis observadas | Sessões elegíveis observadas pelo SDK | sessions + order_attributions | Bruto | por aprovação | Sessões sem consentimento ou bloqueadas não são observáveis; limitação explícita. |
| `payment_approval_rate` | Aprovação de pagamento | percent | Pedidos aprovados / pedidos elegíveis com tentativa de pagamento | Pedidos com tentativa de pagamento conhecida | payment_transactions | Não se aplica | por aprovação | Indisponível quando o conector não envia tentativas pendentes/recusadas. |
| `fees` | Taxas efetivas | money | Σ taxas informadas pela origem + taxas estimadas por tabela vigente (rotuladas) | — | financial_entries tipo fee; fee_schedules | Taxa não devolvida em estorno salvo informação da origem | por aprovação, por movimento financeiro, por coorte de aquisição | — |
| `contribution_after_media` | Contribuição após mídia | money | Receita da organização após estornos − custos variáveis conhecidos (taxas etc.) − investimento | — | financial_entries + custos + ad_spend_daily | Após estornos | por aprovação, por movimento financeiro, por coorte de aquisição | Custos materiais ausentes → resultado parcial com a lista de custos faltantes. Não é lucro líquido. |
| `operating_result_estimated` | Resultado operacional estimado | money | Contribuição após mídia − despesas operacionais incluídas (critério de rateio informado) | — | contribuição + operating_expenses | Após estornos | por aprovação, por movimento financeiro, por coorte de aquisição | — |
| `unattributed_orders` | Vendas sem atribuição | count | Pedidos aprovados sem atribuição elegível pela política ativa (com motivo) | — | order_attributions | Bruto | por aprovação, por coorte de aquisição | — |
| `breakeven_roas` | ROAS de equilíbrio | ratio | 1 / margem de contribuição antes da mídia | Margem de contribuição antes da mídia (deve ser positiva) | receita da organização após estornos − custos variáveis conhecidos | Após estornos | por aprovação, por movimento financeiro, por coorte de aquisição | Não calculado com margem não positiva, moedas misturadas ou custos materiais ausentes. |
| `customers_acquired` | Clientes adquiridos | count | Clientes cuja primeira compra aprovada ocorreu no período | — | pedidos aprovados agrupados pelo e-mail informado no checkout (hash, por organização); sem e-mail = um cliente por pedido | Bruto | por coorte de aquisição | Somente na base por coorte de aquisição. |
| `ltv_observed` | LTV observado | money | Receita após estornos acumulada até as_of pelos clientes da coorte / clientes adquiridos | Clientes adquiridos no período | financial_entries dos pedidos dos clientes da coorte | Após estornos até as_of | por coorte de aquisição | Valor observado até a data de corte; nunca uma previsão. |
