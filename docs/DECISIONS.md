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
