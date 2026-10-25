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
1. Crie um banco NOVO (nunca restaure sobre o banco em uso) e provisione os papéis: `DATABASE_URL_ADMIN=… DB_APP_PASSWORD=… DB_SYSTEM_PASSWORD=… node packages/db/dist/cli.js provision-roles`.
2. `node scripts/restore.mjs --url <admin do banco novo> --in <arquivo.dump>`: confere sha256, restaura em transação única e compara contagens, somas do razão, migrações e digest das credenciais cifradas; divergência = erro.
3. Aponte API e worker para o banco restaurado (mesmas `CREDENTIALS_KEYS` e `TOKEN_HMAC_SECRET`, que ficam fora do backup) e confira `/ready`, `pnpm diag` e um webhook de teste.
4. Se o arquivo de backup foi exposto, rotacione credenciais de provedores e segredos de webhooks (seção acima). Procedimento automatizado em `backup-restore.test.ts` (T69).

## Chave de API vazada ou uso suspeito
1. API e webhooks → revogar a chave (efeito imediato, `401 api_key_revoked`); criar outra com escopos mínimos e projetos restritos.
2. Uso da chave: rotas, status e `request_id` das últimas chamadas (sem conteúdo). Picos de `429` indicam laço no cliente.
3. Vendas importadas pela chave aparecem na auditoria como `order.manual_created` com `actor_type = api_key`; correções por estorno/ajuste, nunca apagando lançamentos.

## Webhook de saída falhando
1. API e webhooks → Entregas: `retry_scheduled` (nova tentativa agendada), `dead` (tentativas esgotadas), `blocked` (destino recusado pela política anti-SSRF — o endereço resolveu para rede interna ou o redirecionamento apontou para lá).
2. Corrija o destino e use "Enviar teste"; depois "Reenviar" nas entregas da fila de falhas (mesmo `X-Tracker-Webhook-Id`, o receptor deduplica).
3. Segredo vazado: "Rotacionar segredo" — por 24 h as entregas levam as duas assinaturas; depois só a nova.
4. Loop entre sistemas: entradas com `X-Tracker-Hop` acima de 3 são recusadas (`508`) e aparecem em rejeições do endpoint.

## Notificações não chegam (push/e-mail)
1. Em **Notificações → Push neste dispositivo**, veja o estado do canal: "Web Push não configurado" = faltam `WEB_PUSH_VAPID_PUBLIC_KEY`/`WEB_PUSH_VAPID_PRIVATE_KEY`/`WEB_PUSH_SUBJECT` (gere com `pnpm push:keys`); "Envio externo desligado" = `ALLOW_EXTERNAL_DELIVERY=false` no ambiente.
2. Use **Enviar notificação de teste**. Se aparece no sino mas não no dispositivo: permissão do navegador, modo "não perturbe" do sistema ou horário silencioso nas preferências.
3. Inscrição marcada como "expirada ou recusada": o serviço de push respondeu 404/410 — reative o push no dispositivo.
4. Consulta (operador): `select channel, status, last_error, last_http_status from public.notification_deliveries where organization_id = '<org>' order by created_at desc limit 20;`
5. Trocar as chaves VAPID invalida todas as inscrições: comunique os usuários antes.

## Alerta "Integração sem eventos" ou "Processamento atrasado"
1. Siga "Integração de checkout sem eventos" ou "Fila acumulada (outbox)" acima.
2. Limiares por organização em **Notificações → Alertas da organização** (0 desliga). O alerta só se repete depois que o problema for resolvido e voltar.

## Regra suspensa ou executando de forma inesperada
1. Parada imediata: **Automação → Pausar todas as regras agora** (organização) ou, no servidor, `RULES_KILL_SWITCH=true` no worker (todas as organizações; simulações continuam).
2. Abra a regra: o histórico mostra cada decisão com os valores usados, a janela e o motivo de não executar. Motivos de suspensão: falhas consecutivas nas ações (ex.: webhook inativo), permissão retirada de quem ativou.
3. Corrija e simule de novo; só então reative. Tags internas aplicadas por engano podem ser desfeitas na lista de ações; notificações e webhooks entregues não têm desfazer.
