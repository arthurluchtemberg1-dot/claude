# Runbooks

Procedimentos para incidentes comuns. Comandos assumem acesso ao ambiente e ao `.env` correspondente. Toda correção deve deixar trilha (auditoria/commit); nunca edite valores financeiros diretamente no banco.

## Integração de checkout sem eventos
1. Painel → Diagnóstico: estado da conexão, último evento, rejeições por autenticação.
2. `404` no provedor: endpoint revogado ou URL errada → Integrações → "Novo endpoint" e atualize a URL no provedor; revogue a antiga depois.
3. `401`: segredo/assinatura (webhook próprio) — verifique relógio do emissor (janela 300 s) e segredo atual; após rotação o anterior vale 24 h.
4. Se o provedor recebeu `503`, ele deve reenviar; verifique o banco (`pnpm diag`).

## Recebimentos em quarentena
1. Diagnóstico → Recebimentos → filtro `quarantined`: leia o motivo (campo ausente, evento desconhecido, valor não interpretável).
2. Com permissão de dados pessoais, "Ver corpo (auditado)" para comparar com a documentação do provedor.
3. Após corrigir a causa (configuração da conexão ou código do conector), "Reprocessar". Reprocessar não reenvia conversões já enviadas.

## Fila acumulada (outbox)
1. `pnpm diag` → `outbox` por estado e item mais antigo; `redis` e `redis_aof`.
2. Worker parado: reinicie; itens `pending` são reivindicados pelo relay e itens `enqueued` antigos (>10 min) são republicados automaticamente.
3. Redis indisponível: nada se perde (a outbox é a fonte de verdade); restabeleça o Redis e o relay volta a publicar.
4. Itens `dead` (tentativas esgotadas): veja `last_error`; o recebimento correspondente aparece como `dead` no Diagnóstico e pode ser reprocessado após correção.

## Falha no banco
- API responde `503` a webhooks quando não consegue persistir (provedores reenviam). `/ready` retorna 503.
- Após restabelecer: `pnpm db:status`; verificar `pnpm diag`.

## Credencial comprometida
1. Webhook: crie novo endpoint, atualize no provedor, revogue o antigo. Webhook próprio: "rotacionar segredo" (anterior aceito por 24 h) — em caso de vazamento, revogue a conexão inteira.
2. Token Meta: gere novo token de sistema, atualize o destino; revogue o antigo no Business Manager.
3. Chave de cifragem (`CREDENTIALS_KEYS`): adicione nova versão, altere `CREDENTIALS_KEY_CURRENT`, re-cadastre as credenciais (re-cifragem em massa ainda não automatizada); remova a versão antiga depois.
4. Sessões: usuário pode "Encerrar todas as sessões"; troca de senha encerra todas.

## Evento duplicado
- Recebimentos repetidos incrementam `delivery_count` sem novo efeito. Se um pedido aparentar duplicidade, compare `external_order_id`/conta lógica: reconexões devem usar o mesmo identificador de conta do provedor (Integrações). Duas contas lógicas diferentes para o mesmo vendedor geram pedidos distintos — corrija o cadastro, não o razão.

## Reembolso/chargeback divergente
- Detalhe do pedido → "Lançamentos financeiros" e "Conflitos registrados". Reversões nunca excedem o valor aprovado; chargeback que cobre reembolso exige `covers_refund_id` da origem. Divergência com o provedor → registrar evento corretivo pelo canal suportado (ex.: webhook próprio); não apagar lançamentos.

## Entregas a destinos rejeitadas
- Pixels e conversões → Entregas: `rejected` (erro permanente, ver código do provedor), `retry_scheduled` (429/5xx), `unknown_outcome` (timeout; repetição só com o mesmo `event_id`), `not_eligible` (motivo explícito). Circuit breaker aberto reagenda por 5 min. Reenvio manual mantém o `event_id`.

## Restauração de backup
- Ainda não automatizado nem testado (T69, R42-05). Procedimento previsto: `pg_dump -Fc` diário do banco, restauração em banco novo, `pnpm db:status`, validação de contagens e somas do razão por organização, e rotação das credenciais se o backup tiver sido exposto (as credenciais estão cifradas com chaves fora do banco).
