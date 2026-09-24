# Decisões técnicas

Formato: decisão · contexto · alternativas rejeitadas · consequências. Reversíveis salvo indicação.

## D-001 — Monorepo pnpm com TypeScript 5.9.3 e Node 22
- **Contexto:** R05. TypeScript 7 (nativo) é o `latest`, mas typescript-eslint 8.70 suporta `< 6.1`; TS 6.0 é versão de transição.
- **Rejeitado:** TS 7 (tooling incompatível), Turborepo/Nx (sem benefício concreto ainda).
- **Consequência:** migrar para TS 6/7 quando o ecossistema de lint suportar.

## D-002 — Pacotes internos consumidos como TypeScript fonte
- `exports` apontam para `src/index.ts`; API/worker executam com `tsx` em dev e são empacotados com esbuild; Next usa `transpilePackages`.
- **Rejeitado:** build separado por pacote (lento, mais artefatos).

## D-003 — Autenticação própria em vez de Supabase Auth no ambiente local
- **Contexto:** R05-02 sugere Supabase para banco/auth/storage. Neste ambiente não há Docker ativo nem acesso ao Supabase; a regra R13 exige não bloquear por decisões reversíveis.
- **Decisão:** PostgreSQL puro com SQL compatível com Supabase (RLS, papéis, funções `SECURITY DEFINER` com `search_path` vazio); autenticação na API com sessões opacas, scrypt, TOTP.
- **Rejeitado:** JWT de Supabase simulado (não validável), bloquear a E1.
- **Consequência:** para usar Supabase Auth depois, trocar `resolveSession` por verificação JWT/JWKS e mapear `auth.uid()` para `app.user_id`. Registrado em DEP-SUPABASE.

## D-004 — Dois papéis de banco e RLS também no worker
- `tracker_system` também é sujeito a RLS com `app.org_id`, forçando todo job a declarar a organização (defesa em profundidade, R07-14). Operações entre organizações só por funções dedicadas (`outbox_claim`).

## D-005 — Outbox como fonte de verdade; BullMQ apenas transporte
- Handlers internos concluem na mesma transação que marca a outbox; efeitos externos em duas transações curtas ao redor da chamada HTTP.
- Correção encontrada pelo E2E: o job pode chegar antes do commit do relay → o dispatch espera o lock (`lock_timeout` 5 s) em vez de `SKIP LOCKED`; `jobId` inclui a geração de enfileiramento para republicações.

## D-006 — Agregado financeiro puro no domínio
- O worker carrega o estado do pedido, aplica `applyFinancialEvent` e persiste. Reversões limitadas ao valor aprovado da transação; chargeback que comprovadamente cobre um reembolso deduz só a diferença; disputa ganha é um evento próprio idempotente; estorno antes da aprovação fica pendente de conciliação.
- **Rejeitado:** triggers SQL com regra financeira (duplicaria fórmulas e dificultaria testes).

## D-007 — Lowify: hipóteses explícitas por conexão
- Documentação pública (lowify/docs, `internal-webhook.md` v1.0.0) não informa assinatura, moeda, fuso do `timestamp` nem semântica de valor em `sale.refunded`.
- **Decisão:** token opaco na URL; `currency` (BRL) e `source_timezone` (America/Sao_Paulo) configuráveis e exibidos; `sale.refunded` = reembolso integral; `click_id`/`campaign_id` guardados como referências internas da Lowify, nunca como IDs de anúncio; token do SDK só é lido do campo UTM explicitamente configurado.

## D-008 — Token de vínculo emitido pelo servidor
- O SDK solicita o token (`token_request`) ao coletor; guardado como HMAC no banco; exibido só com dica final. Evita token forjado no cliente e permite validade/escopo por projeto.

## D-009 — Tolerância de desvio de relógio de 10 minutos
- Descoberto em teste: o `timestamp` da Lowify tem precisão de segundos e o relógio do provedor pode divergir; tokens emitidos segundos "após" a compra eram descartados. Toques dentro da tolerância são tratados como simultâneos, com observação no motivo.

## D-010 — Métricas calculadas sob demanda pelo domínio
- SQL fornece somas/contagens por base temporal; o domínio calcula fórmulas e qualidade. Custo por consulta aceitável no volume inicial; evolução: tabelas de agregados diários incrementais.

## D-011 — Gráficos SVG próprios em vez de biblioteca
- Poucos gráficos, controle de acessibilidade (tabela equivalente para leitores de tela) e zero dependências. Rever quando houver drill-down interativo.

## D-012 — Consentimento `require_explicit` por padrão
- Eventos só são armazenados com `analytics=true`; sinais de publicidade (_fbp/_fbc, IP, User-Agent) só com `ads=true`. Modo alternativo `analytics_legitimate_interest` configurável por projeto, sem bypass global.

## D-013 — MFA obrigatório por organização (`mfa_required`)
- Padrão `true` quando `APP_ENV=production` (`MFA_REQUIRED_DEFAULT`), `false` em desenvolvimento para não bloquear avaliação local. Ações sensíveis (conectar provedor, destinos, membros, organização, vendas manuais) exigem MFA configurado para Proprietário/Administrador/Financeiro quando ativo.

## D-014 — Meta CAPI a partir do SDK oficial
- developers.facebook.com bloqueado neste ambiente. Campos, normalização e endpoint verificados no código do `facebook-nodejs-business-sdk@24.0.1` (npm oficial). Janela de idade (7 dias), lote (1000) e deduplicação navegador×servidor ficam como hipóteses a revalidar (DEP-META-DOCS).

## D-015 — Separação de dados de teste e demonstração
- `connections.environment=test` marca vendas como teste (fora das métricas por padrão, não enviadas a destinos de produção). `organizations.is_demo` impede qualquer envio externo.

## D-016 — Recebíveis e liquidações fora do razão de receita
- Contrato canônico ganhou `settlement.scheduled|paid|canceled` e `order.installments` como adição compatível ao v1.0 (campos opcionais, tipos novos). Registros vão para `public.settlements`, nunca para `financial_entries`: parcela, recebível ou repasse não é nova compra nem receita (R10-08, T18). Exibição por movimento de caixa fica para quando houver fonte real (nenhum checkout integrado documenta repasses).

## D-017 — Vínculo de upsell somente por declaração da origem, com resolução adiada
- `parent_order_id` do contrato vincula pedidos da mesma conta lógica e projeto; se o original ainda não chegou, o ID externo fica guardado e o vínculo é resolvido na chegada dele. Declaração posterior divergente não troca o vínculo (conflito `parent_mismatch`). O upsell sem vínculo próprio herda os visitantes vinculados por token ao original (evidência `parent_order`, mesma força do token); nunca por e-mail.

## D-018 — Gasto: um nível por conta **e por dia**; entidades importadas por CSV
- Antes o nível era escolhido por conta no período inteiro, o que descartava dias importados em outro nível. Agora o total usa o nível mais agregado disponível em cada dia; o detalhamento por campanha usa o nível mais agregado abaixo da conta e explicita o gasto não detalhável.
- A importação CSV registra entidades (`ad_entities.source = 'csv'`) e o histórico de nomes com datas da conta; o nome exibido é o de observação mais recente e a junção é sempre por ID (T39). Correção junto: o papel da API não tinha permissão de escrita em `ad_entity_names`, o que fazia falhar toda importação por campanha com nomes.

## D-019 — API pública com papel de sistema restrito à organização da chave
- Não há usuário numa chamada por chave, então `tracker_app` (que exige membro) não se aplica. As rotas `/public/v1` usam `tracker_system` com `app.org_id` da chave (RLS ainda isola a organização) e filtros explícitos de projeto e ambiente (sandbox ⇒ só `is_test`). Nada administrativo é exposto; chave com hash HMAC, prefixo para exibição.

## D-020 — Limite de taxa em janelas no PostgreSQL
- Janela fixa de 1 minuto por chave e por organização em `api_rate_windows` (uma escrita por requisição), consistente entre instâncias sem depender do Redis na API. Evolução: mover para Redis se o volume tornar a escrita relevante.

## D-021 — Webhooks de saída verificados antes de ativar e com política anti-SSRF única
- Assinatura nasce pausada; ativação exige `test.ping` assinado respondido com 2xx (prova de controle do destino). API e worker usam `outboundPolicyFromEnv` + `safeRequest` (DNS validado na conexão, redirecionamentos revalidados, só 307/308). Rede privada só com `OUTBOUND_ALLOW_PRIVATE_NETWORKS=true`, recusado em produção.

## D-022 — Resposta somente após o COMMIT
- Descoberto em teste: rotas que chamavam `reply.send()` dentro do callback da transação respondiam antes do COMMIT (cliente podia usar uma chave/conta ainda invisível, ou receber sucesso de algo revertido). Regra: dentro da transação só `reply.status()`; o corpo é retornado e enviado depois. Teste de regressão determinístico com COMMIT atrasado por gatilho adiado.

## D-023 — Política principal fixa (`default`) e políticas de comparação
- Vendas, exportações, webhooks e a lista de pedidos usam a política `default`; alterá-la cria nova versão (a anterior e seus resultados ficam no histórico). Outras políticas (até 6 ativas, pois todas são calculadas a cada venda) servem para comparação e podem ser escolhidas no painel. Vendas anteriores só recebem resultado numa política nova após recálculo explícito do período.

## D-024 — Clientes agrupados por e-mail normalizado, só para leitura
- Agrupamento pelo hash do e-mail informado no checkout, dentro da organização, exibindo o critério e permitindo separar pedidos (auditado, reversível). Não é usado para atribuição, vínculo de upsell (R10-07) nem compartilhado entre organizações.

## D-025 — Imagens sem pacotes do sistema; CA de build como segredo
- As imagens partem de `node:22.22.2-bookworm-slim` sem `apt` (o espelho Debian é bloqueado neste ambiente e não é necessário): API e worker tratam `SIGTERM` e não criam processos filhos; `init: true` no compose cobre sinais/zumbis. Um CA adicional para proxies com inspeção TLS entra só como segredo de build (`--secret id=extra_ca`), nunca na imagem.
- O painel fixa `API_INTERNAL_URL` no build (rewrites do Next); o compose passa `http://api:4000`.

## D-026 — "Produção" do e-mail é o ambiente de implantação (APP_ENV)
- `NODE_ENV=production` é modo de build/execução; `APP_ENV` identifica o ambiente. Transportes `log`/`file` são recusados só com `APP_ENV=production`, permitindo homologação em contêiner com imagens de produção. SMTP com TLS obrigatório em produção (smtps:// ou STARTTLS exigido).

## D-027 — Bases temporais por transação e coorte por cliente
- Descoberto ao modelar coortes: a base "por aprovação" agrupava pelo pedido e somava todas as transações dele, levando renovações para o mês da primeira compra. Agora: por aprovação = transações aprovadas no período (renovação na data dela) com reversões dessas transações até `as_of`; pedidos contados pela primeira aprovação. Renovações ficam fora da receita atribuída à aquisição (R16-11), inclusive nas campanhas.
- Coorte de aquisição = clientes (hash do e-mail do checkout na organização) cuja primeira compra aprovada caiu no período; toda a receita posterior deles até `as_of` é creditada pela atribuição da primeira compra. LTV observado = receita após estornos ÷ clientes adquiridos. Um cliente com compras em moedas diferentes aparece em cada moeda.
