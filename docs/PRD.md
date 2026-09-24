# PRD — Tracker (nome provisório)

Fonte integral: [`docs/spec/PROMPT_COMPLETO_TRACKER_CLAUDE_CODE.md`](spec/PROMPT_COMPLETO_TRACKER_CLAUDE_CODE.md)
(SHA-256 `6849c3706683e596598708c9139b860b7237b80fe941c00b96a61d94f419a7c3`, recebida em 24/09/2026).
A especificação original é preservada sem alterações; este PRD reorganiza o conteúdo em requisitos com
identificadores estáveis. **Nenhum requisito foi removido.** Em caso de dúvida, a especificação original prevalece.

Convenções:

- `Rss-nn`: requisito da seção `ss` da especificação (ex.: `R09-04` = 4º requisito da seção 09).
- `Tnn`: cenário obrigatório de teste da seção 43 (mantém a numeração original T01–T70).
- `Ex`: etapa de execução da seção 44 (E0–E10).
- `DEP-xx`: dependência externa (ver [`EXTERNAL_DEPENDENCIES.md`](EXTERNAL_DEPENDENCIES.md)).
- Estado de cada requisito: [`REQUIREMENTS_TRACEABILITY.md`](REQUIREMENTS_TRACEABILITY.md).

## Visão do produto

Plataforma SaaS multi-organização (também utilizável só na operação própria) de rastreamento de vendas e gestão
de performance para produtores digitais, afiliados, e-commerces, prestadores de serviço, gestores de tráfego e
agências. Responde, com evidência: quais vendas foram confirmadas pelo checkout; qual origem/campanha/conjunto/anúncio
pode ser associada a cada venda e com qual evidência; quanto foi investido, qual receita e qual resultado operacional;
quais eventos chegaram, falharam, foram enviados às plataformas ou ficaram sem atribuição; quais campanhas e
automações podem ser geridas dentro dos limites definidos.

Referências funcionais públicas: UTMify e LowTrack (categorias funcionais apenas; identidade, código e textos
originais). Nome, logo, cores, domínio e textos comerciais centralizados em configuração (`packages/config/brand.ts`).

---

## 01. Missão

- **R01-01** — Construir a aplicação real no repositório, com decisões técnicas fundamentadas, código, testes executados e documentação de operação.
- **R01-02** — O produto deve responder: vendas confirmadas pelo checkout; origem/campanha/conjunto/anúncio de cada venda com evidência; investimento, receita e resultado operacional com custos conhecidos; eventos recebidos/falhos/enviados/sem atribuição; campanhas e automações gerenciáveis dentro de limites.
- **R01-03** — Público: produtores digitais, afiliados, e-commerces, prestadores de serviços, gestores de tráfego e agências.
- **R01-04** — Identidade, código, interface e textos originais; não copiar marcas, ativos, páginas privadas, termos ou código proprietário de UTMify/LowTrack.
- **R01-05** — Nome provisório "Tracker"; nome, logo, cores, domínio e textos comerciais centralizados em configuração.

## 02. Premissas e abrangência

- **R02-01** — SaaS com isolamento entre organizações; modo de uso interno que desativa cobrança sem enfraquecer autenticação/isolamento.
- **R02-02** — Idioma pt-BR com estrutura preparada para en-US e es.
- **R02-03** — Fuso padrão America/Sao_Paulo; horários armazenados em UTC.
- **R02-04** — Moeda de apresentação BRL; valores originais preservados por moeda.
- **R02-05** — Integrações prioritárias: Lowify e Meta Ads.
- **R02-06** — Modelo de atribuição inicial: último clique pago elegível, janela de 7 dias, configurável.
- **R02-07** — Identificação determinística; nunca vincular pessoas apenas por IP.
- **R02-08** — Envio externo de eventos desligado até conexão, validação e definição de emissor responsável.
- **R02-09** — Gestão de mídia inicialmente em leitura; escrita habilitada por permissão e configuração.
- **R02-10** — Regras automáticas em simulação inicialmente; execução habilitada por regra e escopo.
- **R02-11** — Ambientes local/teste separados de homologação e produção.
- **R02-12** — Defaults alteráveis por organização.
- **R02-13** — Escopo completo inclui captura, UTMs, atribuição, vendas, produtos, custos, anúncios, pixels, CAPI, diagnósticos, relatórios, regras, IA, WhatsApp, CRM, funis, aplicativos, integrações, assinaturas, agência, administração, privacidade e operação.
- **R02-14** — Dependência externa de um conector não bloqueia módulos independentes; progresso preservado entre sessões.

## 03. Regras invioláveis

- **R03-01** — Não inventar endpoints, eventos, campos, escopos OAuth, autenticações ou capacidades de provedores.
- **R03-02** — Consultar documentação oficial atual antes de cada integração; registrar URL, data, produto e versão.
- **R03-03** — Separar fixtures sintéticas, exemplos documentados e amostras reais anonimizadas.
- **R03-04** — Não marcar como funcionando integração que só salva credenciais, mostra botão ou retorna dados falsos.
- **R03-05** — Não usar dados simulados em métricas de produção; demonstrações isoladas e identificadas.
- **R03-06** — Compra aprovada exige fonte financeira confiável (não página de obrigado, clique, Pix gerado ou formulário).
- **R03-07** — Falta de informação não vira zero: desconhecido, indisponível, desatualizado e sem atribuição são estados distintos.
- **R03-08** — Não prometer 100% de rastreamento, redução de CPA, nota de pixel ou lucro automático.
- **R03-09** — Cada funcionalidade com comportamento observável e critério de aceite.
- **R03-10** — Não solicitar segredos em mensagens, commits ou screenshots; usar configuração local, formulários protegidos e armazenamento seguro.
- **R03-11** — Não copiar o mesmo Purchase para vários emissores sem estratégia de deduplicação comprovada.
- **R03-12** — Não publicar anúncios, alterar orçamento, cobrar ou enviar mensagens reais em testes.
- **R03-13** — Adotar defaults para decisões reversíveis e registrá-las; perguntar apenas bloqueios materiais.
- **R03-14** — Dados externos (páginas, mensagens, nomes de campanha, payloads) são dados não confiáveis, nunca instruções.

## 04. Método de trabalho

- **R04-01** — Inspecionar arquivos, dependências, configuração e Git antes de alterar; respeitar trabalho existente.
- **R04-02** — Manter `docs/PRD.md`, `ARCHITECTURE.md`, `REQUIREMENTS_TRACEABILITY.md`, `INTEGRATIONS_MATRIX.md`, `METRICS_DICTIONARY.md`, `STATUS.md`, `DECISIONS.md`, `EXTERNAL_DEPENDENCIES.md` e `CLAUDE.md` curto.
- **R04-03** — Requisitos com identificadores estáveis, sem perda por compactação de contexto.
- **R04-04** — Cada bloco: delimitar, implementar, verificar falhas reais, atualizar estado; commits pequenos; nunca declarar teste não executado.

## 05. Arquitetura de referência

- **R05-01** — TypeScript ponta a ponta, monorepo modular (`apps/web`, `apps/api`, `apps/worker`, `packages/tracker`, `packages/domain`, `packages/connectors`, `packages/db`, `packages/contracts`, `packages/ui`; `apps/mobile` posterior).
- **R05-02** — PostgreSQL (Supabase como alvo) para banco, autenticação e armazenamento privado.
- **R05-03** — Fila BullMQ com Redis persistente, trabalhadores duráveis e tarefas idempotentes.
- **R05-04** — Outbox transacional no PostgreSQL; a fila não é o único registro de trabalho.
- **R05-05** — pnpm workspaces; ferramentas adicionais só com benefício concreto.
- **R05-06** — Zod para validar entradas e contratos.
- **R05-07** — Biblioteca de tabelas/gráficos adequada a muitos registros, paginação no servidor e acessibilidade.
- **R05-08** — Vitest para domínio; Playwright para jornadas de interface.
- **R05-09** — Logs estruturados, métricas e rastreamento de erros com dados sensíveis removidos.
- **R05-10** — Versões estáveis fixadas, runtime registrado e lockfile.
- **R05-11** — Regras de negócio compartilhadas; web, API, worker e app não têm fórmulas financeiras independentes.

## 06. Autenticação, organizações e permissões

- **R06-01** — Cadastro, login, verificação de e-mail, recuperação de senha e encerramento de sessões.
- **R06-02** — Proteção contra abuso (rate limit, bloqueio progressivo) em autenticação.
- **R06-03** — MFA para perfis sensíveis.
- **R06-04** — Login Google somente quando configurado; sem integração social inventada.
- **R06-05** — Usuário em várias organizações por associação explícita; organização é a fronteira de isolamento.
- **R06-06** — Organização contém projetos, domínios, integrações, contas de anúncio, produtos, dashboards e regras.
- **R06-07** — Projeto pode ter membros e permissões mais restritas.
- **R06-08** — Agência acessa clientes por vínculos explícitos e revogáveis, sem bypass genérico.
- **R06-09** — Perfis: Proprietário, Administrador, Gestor, Analista, Financeiro, Cliente/leitor com capacidades definidas.
- **R06-10** — Permissões granulares: ler métricas, ler dados pessoais, exportar, configurar pixel, conectar provedor, administrar membros, alterar custos, executar mídia, ativar regras, acessar cobrança, administrar API.
- **R06-11** — Convite com token de uso único e expiração.
- **R06-12** — Alteração de permissão revoga acesso efetivo rapidamente.
- **R06-13** — Troca de organização limpa cache, assinaturas em tempo real e seleções anteriores.
- **R06-14** — Testes de vazamento por busca, exportação, URLs diretas e WebSocket/SSE.

## 07. Banco de dados e invariantes

- **R07-01** — Mapa de domínio com grupos: Identidade, Operação, Integrações, Mídia, Rastreamento, Financeiro, Atribuição, Transporte, CRM, WhatsApp, Análise, Ações, Custos, SaaS, Governança (tabelas criadas conforme cada etapa).
- **R07-02** — `organization_id` em entidades de negócio; `project_id` quando aplicável.
- **R07-03** — FKs compostas ou verificação equivalente impedindo relações entre organizações.
- **R07-04** — Dinheiro em inteiro na menor unidade (ou decimal exato) com moeda/escala; nunca ponto flutuante.
- **R07-05** — IDs externos como strings opacas (inclusive IDs de anúncio).
- **R07-06** — `occurred_at`, `received_at`, `processed_at`, `source_updated_at` distintos.
- **R07-07** — Valores originais e normalizados rastreáveis; evidência de origem não sobrescrita.
- **R07-08** — Unicidade garantida no banco.
- **R07-09** — Índices por organização, período, IDs de origem, estado e cursores.
- **R07-10** — Filtros de período `[início, fim)`.
- **R07-11** — Migrações reproduzíveis com estratégia de reversão/correção.
- **R07-12** — RLS e grants em tabelas, views e funções expostas; views sem bypass involuntário.
- **R07-13** — Credenciais fora de tabelas/schemas expostos ao cliente.
- **R07-14** — Workers privilegiados validam organização, conexão e projeto em toda execução; funções privilegiadas pequenas e auditáveis.

## 08. Modelo canônico de eventos

- **R08-01** — Contrato interno versionado (`schema_version`) próprio, não confundido com formato de checkout.
- **R08-02** — Organização e projeto resolvidos pelo servidor a partir da conexão; ignorar `organization_id` do corpo público.
- **R08-03** — Schemas tratam obrigatórios, opcionais e desconhecidos sem adivinhar estados ou dinheiro.
- **R08-04** — Dados pessoais em estrutura restrita, não propagados automaticamente; procedência, finalidade e retenção registradas.
- **R08-05** — Vocabulário interno: `checkout.started`, `payment.pending`, `payment.approved`, `payment.failed`, `refund.created`, `refund.succeeded`, `dispute.opened`, `dispute.won`, `chargeback.confirmed`, `subscription.renewed`, `subscription.canceled`, `lead.created`, `deal.won`; não presumir que provedores os possuem.

## 09. Recebimento confiável de webhooks

- **R09-01** — Resolver conexão por identificador opaco e verificar situação.
- **R09-02** — Limitar tamanho, método, taxa e tipo de conteúdo.
- **R09-03** — Preservar corpo bruto quando a autenticação exigir.
- **R09-04** — Validar assinatura/token e política de replay por provedor.
- **R09-05** — Persistir recebimento, chave de idempotência e trabalho pendente em transação durável.
- **R09-06** — Responder rápido, após persistência, sem aguardar CAPI/relatórios/IA.
- **R09-07** — Normalizar e processar no worker com transações e locks.
- **R09-08** — Atualizar pedido e lançamentos; efeitos externos por outbox.
- **R09-09** — Agendar atribuição, agregações e notificações sem duplicar efeitos.
- **R09-10** — Registrar tentativas, erro acionável, próxima tentativa e resultado final.
- **R09-11** — Sem persistência, não confirmar recebimento.
- **R09-12** — Evento válido desconhecido guardado para diagnóstico sem virar venda.
- **R09-13** — Requisição não autenticada rejeitada sem alterar finanças.
- **R09-14** — Idempotência em camadas: recebimento (org+conta+evento), pedido (org+provedor+conta+pedido), transação (identidade da cobrança/captura/estorno), efeito externo (destino+evento semântico+ambiente).
- **R09-15** — Reconexões/dois webhooks da mesma conta não criam duas vendas.
- **R09-16** — Sem ID de evento: fingerprint determinístico de campos estáveis (sem horário de recebimento), limitações documentadas e detecção de colisão.
- **R09-17** — Tratar repetição, concorrência, perda de conexão após commit, fora de ordem e falha após envio externo; não ordenar só pela data do webhook.
- **R09-18** — Backoff exponencial com jitter, limite de tentativas, dead letters, circuit breaker por provedor e reprocessamento seletivo.
- **R09-19** — Reprocessar contabilidade/atribuição não reenvia conversões externas automaticamente.
- **R09-20** — Autenticação fraca/não documentada: registrar risco e usar consulta autenticada de confirmação quando disponível; não aceitar qualquer JSON como venda.
- **R09-21** — Segredos em URL protegidos contra exposição em logs e interface.

## 10. Pedidos, cobranças e ciclo financeiro

- **R10-01** — Separar pedido, tentativa de pagamento, transação confirmada, itens, estornos, disputas, comissão e repasse; status de pagamento separado de entrega.
- **R10-02** — Pix gerado, boleto emitido e cartão recusado não somam faturamento aprovado.
- **R10-03** — Várias tentativas de pagamento do mesmo pedido não multiplicam vendas.
- **R10-04** — Capturas parciais/complementares seguem semântica documentada do provedor.
- **R10-05** — Order bump no mesmo pedido soma valor e itens sem criar outra compra.
- **R10-06** — Upsell/downsell com outra transação gera registro próprio com vínculo ao pedido original quando comprovado.
- **R10-07** — Não vincular compras apenas por e-mail coincidente.
- **R10-08** — Parcela de cartão não é nova compra; distinguir captura, recebível e liquidação.
- **R10-09** — Renovação de assinatura é receita nova separável da aquisição inicial.
- **R10-10** — Estorno parcial preserva histórico e reduz líquido pela quantia efetiva.
- **R10-11** — Chargeback, reembolso e reversão não subtraem o mesmo valor duas vezes.
- **R10-12** — Disputa ganha restaura valor retido mediante evento confiável.
- **R10-13** — Pendente atrasado não rebaixa cobrança confirmada.
- **R10-14** — Estorno antes da confirmação guardado e reconciliado sem fabricar aprovação.
- **R10-15** — Bases de receita separadas para afiliado, produtor e coprodutor.
- **R10-16** — Conciliação por API oficial ou exportação importada: pedidos ausentes, valores divergentes, estados conflitantes e reparação auditável.

## 11. Estrutura dos conectores

- **R11-01** — Interfaces tipadas: `CheckoutConnector`, `AdNetworkConnector`, `ConversionDestination`, `CRMConnector`, `MessagingConnector`, `ExportDestination`.
- **R11-02** — Capacidades declaradas individualmente por conector.
- **R11-03** — Estados de implementação: Planejado, Em pesquisa, Bloqueado externamente, Implementado localmente, Validado em sandbox, Validado em produção, Degradado/descontinuado.
- **R11-04** — Estados de conexão: desconectada, aguardando configuração, aguardando permissão, conectada, token expirado, revogada, falha temporária, sincronização atrasada.
- **R11-05** — Manifesto por integração: provedor/produto, URLs oficiais, versão, autenticação, escopos, webhooks, transporte de UTMs/token, dinheiro e unidade, timezone, limites, capacidades, testes, último sucesso, limitações.
- **R11-06** — Não usar documentação de conta bancária/Pix como documentação do checkout do mesmo fornecedor.

## 12. Catálogo de checkouts e pagamentos

- **R12-01** — Arquitetura para todos os conectores listados (Lowify; Kiwify, Hotmart, Cakto, Kirvano, PerfectPay, Ticto, Eduzz, Braip, Monetizze; Lastlink, Doppus, Greenn, Hubla, Payt, Pepper, Guru, TriboPay, Vega, Paradise; Cartpanda, Yampi, Shopify, WooCommerce, Nuvemshop, Adoorei, Logzz; Stripe, Mercado Pago, Pagar.me, Asaas, PagBank, PayPal, Appmax, BananaPay; ClickBank, Digistore24, BuyGoods, MaxWeb, Everflow, Systeme.io; sistemas próprios).
- **R12-02** — Implementar primeiro os com documentação verificável e acesso; sem implementações fictícias.
- **R12-03** — Catálogo complementar (lista pública UTMify: MundPay … KitePay) registrado para pesquisa; confirmar identidade, domínio, produto e APIs; sem unir nomes semelhantes sem prova.
- **R12-04** — Sistema próprio: API autenticada e webhook canônico assinado.
- **R12-05** — Para cada conector implementado: cadastro orientado, credenciais protegidas, eventos selecionáveis, validação de autenticação, amostras anonimizadas, normalização, testes de repetição/estorno, diagnóstico, instruções e reconciliação quando suportada.
- **R12-06** — Mapeador genérico não é chamado de "integração nativa" sem validar eventos e regras do provedor.

## 13. SDK próprio de rastreamento

- **R13-01** — Script instalável em uma linha, identificador público de projeto (não é segredo, não autentica vendas) e versão controlada.
- **R13-02** — Inicialização assíncrona, instalação única e isolamento de variáveis.
- **R13-03** — Captura de visita, origem, página, referência permitida, sessão e UTMs.
- **R13-04** — Eventos PageView, ViewContent, Lead, AddToCart, InitiateCheckout, clique em checkout e próprios.
- **R13-05** — Distinguir clique no botão de checkout de checkout iniciado.
- **R13-06** — Capturar `fbclid`, `gclid`, `gbraid`, `wbraid`, `ttclid`, `msclkid`, `_fbp`, `_fbc` quando disponíveis e permitidos.
- **R13-07** — Não fabricar click IDs/cookies de plataforma; formatos derivados só conforme documentação do destino.
- **R13-08** — Preservar separadamente primeiro toque, último toque e último toque pago elegível.
- **R13-09** — Suporte a páginas tradicionais, SPA/mudança de rota, links dinâmicos, formulários e múltiplas etapas.
- **R13-10** — Adaptadores de iframe só com cooperação e origem verificada em `postMessage`.
- **R13-11** — Fila curta, lotes, `sendBeacon`/`fetch`, limites de tamanho e repetição sem travar a página.
- **R13-12** — API pública documentada (`init`, `track`, `setConsent`, `linkCheckout`, `identify`, `reset`) com validação.
- **R13-13** — `identify` só com identidade fornecida voluntariamente; nunca capturar formulários automaticamente.
- **R13-14** — Respeitar CSP, sem `eval` ou acesso invasivo ao DOM.
- **R13-15** — Compatibilidade documentada: HTML, WordPress/Elementor, Webflow, Wix, Shopify, WooCommerce, React/Next.js, GTM, Typebot e construtores.
- **R13-16** — Domínio próprio de coleta com DNS/TLS verificados, nunca para contornar consentimento/bloqueios.
- **R13-17** — CDN, versionamento, rollback e implantação gradual do SDK.
- **R13-18** — Consentimento explícito por finalidade (armazenamento, analytics, publicidade).
- **R13-19** — Padrão: sem persistência/envio publicitário sem sinal de consentimento; políticas alternativas fundamentadas por finalidade, sem bypass global.
- **R13-20** — Funcionamento limitado sem storage/cookies/JS/identificação, sem prometer rastreamento integral.
- **R13-21** — Preservar UTMs sem copiar dados pessoais, senhas ou parâmetros de autenticação para logs.
- **R13-22** — URL sanitizada (caminho + parâmetros permitidos).
- **R13-23** — Sem fingerprinting, canvas, leitura de campos sensíveis ou união por IP.
- **R13-24** — Orçamento de tamanho/impacto medido; sem alegar "zero impacto"; testes com scripts existentes e falhas de rede.

## 14. Gerador de UTMs, links e instalação

- **R14-01** — Gerador visual com presets por rede, produto e funil; `utm_source/medium/campaign/content/term` e campos de IDs.
- **R14-02** — Templates dinâmicos só com macros oficialmente suportadas pela rede.
- **R14-03** — Detectar placeholders não expandidos e UTMs inválidas.
- **R14-04** — Preservar case de IDs opacos, acentos, Unicode e parâmetros existentes.
- **R14-05** — Evitar dupla codificação, dupla interrogação e destruição de fragmentos.
- **R14-06** — Separar parâmetros de campanha dos de checkout/afiliação.
- **R14-07** — Não sobrescrever afiliado, cupom, oferta ou token de segurança.
- **R14-08** — Taxonomia editável, presets e histórico de alterações.
- **R14-09** — Links curtos com domínio validado, destino permitido, proteção contra open redirect e abuso.
- **R14-10** — QR codes para campanhas físicas, sem prometer identidade de quem escaneou.
- **R14-11** — Importar/exportar templates e links; link de teste e diagnóstico de instalação.
- **R14-12** — Instruções específicas e verificadas por plataforma.
- **R14-13** — Assistente de instalação verifica evento de teste real, domínio, consentimento, campos e passagem até o checkout; "código copiado" ≠ "rastreamento validado".

## 15. Passagem de origem entre página e checkout

- **R15-01** — Por checkout, confirmar: parâmetros aceitos no link/criação; preservação em redirecionamentos/upsells; retorno no webhook/consulta; limites de tamanho/caracteres; associação de token opaco; acesso à confirmação e verificação sem confiar no navegador.
- **R15-02** — Preferir token opaco, temporário, sem dados pessoais, vinculado a organização e projeto; integridade protegida e destino validado.
- **R15-03** — Não presumir cookies disponíveis entre domínios.
- **R15-04** — Sem token de retorno: usar campos de origem suportados e declarar granularidade.
- **R15-05** — Sem ligação confiável: guardar a venda e marcá-la sem atribuição; não adivinhar anúncio.
- **R15-06** — URL pública não altera valor, organização ou status de pagamento.
- **R15-07** — Campos de atribuição declarados podem ser falsificados: preservar origem da evidência, validar pertencimento de IDs e diferenciar declaração de confirmação.
- **R15-08** — Página de diagnóstico: visita capturada, token criado, parâmetro enviado, parâmetro recebido, pedido associado e motivo de perda; sem tokens completos ou dados pessoais.

## 16. Motor de atribuição

- **R16-01** — Políticas versionadas com comparação entre modelos: primeiro toque, último toque, último não direto, primeiro clique pago elegível, último clique pago elegível, atribuição explícita ao pedido, linear (análise adicional).
- **R16-02** — Janelas configuráveis (1, 7, 14, 30 dias), internas, sem replicar configuração das redes.
- **R16-03** — Aplicar pela data do toque e da conversão real, não do recebimento do webhook.
- **R16-04** — Hierarquia de evidência: token↔pedido; origem do checkout com IDs validados; sessão/visitante persistidos; identidade própria fornecida com vínculo comprovado; sem atribuição com motivo.
- **R16-05** — IP, proximidade temporal, dispositivo ou valor não comprovam identidade; click IDs não são decodificados como se revelassem anúncio.
- **R16-06** — Persistir modelo, versão, janela, toque, IDs, tipo de evidência, qualidade, data do cálculo, motivo e origem manual.
- **R16-07** — Relatórios indicam recálculo; recalcular não muda o webhook nem reenvia Purchase.
- **R16-08** — Separar pago conhecido, orgânico conhecido, direto, recuperação, sem atribuição (ausente/inválido/expirado/conflitante).
- **R16-09** — Crédito de clique anterior após retorno pela bio conforme política/janela; exibir caminho observado; sem prometer paridade com a Meta.
- **R16-10** — Modelos fracionados: pesos somam 1; receita não multiplica; "conversões creditadas" ≠ pedidos inteiros.
- **R16-11** — Renovações não atribuídas indefinidamente à aquisição sem visão de coorte.
- **R16-12** — Métricas internas separadas das conversões reportadas pelas redes; não somar conversões de várias redes como compradores únicos; view-through/cross-device só de fonte autorizada.

## 17. Pixels, Meta CAPI e deduplicação

- **R17-01** — Múltiplos destinos por organização com roteamento por projeto, domínio, produto e evento.
- **R17-02** — Configuração de Pixel/dataset ID e credencial no servidor, teste de conexão, versão da API, eventos habilitados e diagnóstico.
- **R17-03** — Modelar evento, horário original, origem da ação, moeda, valor, produtos e identificadores permitidos.
- **R17-04** — Purchase apenas com política financeira e confirmação válidas.
- **R17-05** — Hash somente nos campos exigidos pela documentação; não aplicar hash a click IDs, cookies, IP ou User-Agent.
- **R17-06** — IP/User-Agent do comprador apenas quando capturados e permitidos; nunca IP do servidor do checkout.
- **R17-07** — Não fabricar e-mail, telefone, nome ou localização.
- **R17-08** — Preservar consentimento, parâmetros de privacidade e restrições por destino.
- **R17-09** — Identificador semântico estável por compra/transação, destino e ambiente, reutilizado em tentativas.
- **R17-10** — Coordenar `event_name` e `event_id` entre navegador e servidor conforme Meta (grafias diferentes entre pixel e API).
- **R17-11** — Event ID independente do horário de envio e não recriado em retry.
- **R17-12** — Navegador só emite Purchase após confirmação confiável, com o mesmo ID do servidor.
- **R17-13** — Sem coordenação com pixel nativo do checkout: escolher emissor responsável e documentar o que desativar.
- **R17-14** — Order bumps, upsells e assinaturas sem contar a mesma transação duas vezes.
- **R17-15** — Respeitar limite de idade dos eventos, tamanho de lote e regras da API.
- **R17-16** — Painel de entrega: recebido, validado, em fila, enviado, aceito, rejeitado, aguardando reenvio, expirado, não elegível; aceite ≠ correspondência/atribuição.
- **R17-17** — Registrar HTTP, código do provedor, tentativa, latência e trace id sem conteúdo sensível.
- **R17-18** — Métricas oficiais de qualidade só quando disponíveis; indicador interno rotulado e explicado.
- **R17-19** — Sem Purchase negativo para reembolso; usar ajustes suportados ou corrigir relatório interno e mostrar limitação.
- **R17-20** — Proteção de domínios não vendida como invulnerabilidade de Pixel ID público.

## 18. Outros destinos de conversão

- **R18-01** — Adaptadores independentes: TikTok Pixel + Events API; Google Ads/Data Manager API; GA4; Microsoft Advertising; Pinterest, Snapchat, LinkedIn; Kwai, Taboola, Outbrain; webhook próprio assinado.
- **R18-02** — Google: confirmar rota atual (restrições ao UploadClickConversions legado; Data Manager API); GA4 MP não substitui conversões do Google Ads.
- **R18-03** — `gclid`, `gbraid`, `wbraid` guardados sem tratar como intercambiáveis.
- **R18-04** — Normalização e hash específicos por destino.
- **R18-05** — Deduplicação, IDs de pedido, janelas, moedas, ação, ambiente e reembolsos definidos por adaptador; HTTP positivo não comprova processamento final.

## 19. Integração Meta Ads

- **R19-01** — Conexão oficial, seleção de negócios/contas autorizados, permissões, revogação, reconexão, expiração e saúde.
- **R19-02** — Distinguir permissões de leitura, administração e envio de eventos.
- **R19-03** — Requisitos de acesso para contas próprias/terceiros (acesso avançado, App Review) documentados, sem contornar revisão.
- **R19-04** — Sincronizar contas (moeda, fuso, estado, limites, saldo quando expostos).
- **R19-05** — Sincronizar campanhas, conjuntos, anúncios, criativos, nomes, IDs e hierarquia.
- **R19-06** — Objetivos, orçamento, estado configurado e efetivo.
- **R19-07** — Investimento, impressões, alcance, cliques por tipo, CPC, CPM, CTR, frequência.
- **R19-08** — Ações/resultados/conversões da Meta com definição e janela.
- **R19-09** — Métricas de vídeo, posicionamento e detalhamentos válidos respeitando combinações.
- **R19-10** — Junções por IDs estáveis, histórico de nomes, ativos excluídos/arquivados; renomear não perde vendas.
- **R19-11** — Paginação, relatórios assíncronos, rate limits, quota por organização, cache, incremental e backfill.
- **R19-12** — Ressincronizar período recente sem somar snapshots repetidos.
- **R19-13** — Status de sincronização com período coberto e última atualização.
- **R19-14** — Alerta de saldo baixo só com campo válido; ausência de saldo ≠ zero.

## 20. Outras redes e custos externos

- **R20-01** — Catálogo: Meta, Google, TikTok, Microsoft, Pinterest, LinkedIn, Snapchat, Kwai, Taboola, Outbrain (ordem Meta → Google/TikTok → demais).
- **R20-02** — Capacidades separadas por rede: conexão, contas, gastos, hierarquia, detalhamentos, gestão, conversões; modelo comum com extensões (ex.: grupos de recursos).
- **R20-03** — Google: OAuth, contas gerenciadoras, requisitos de acesso; TikTok: autorização, anunciantes, cotas.
- **R20-04** — Custos sem API (influenciadores, afiliados, offline, impulsionamentos, outras despesas).
- **R20-05** — Importação CSV com prévia, mapeamento, moeda, fuso, período, entidade, validação e prevenção de duplicidade.
- **R20-06** — Valor manual com origem identificada, sem mistura silenciosa com gasto importado.

## 21. Conciliação e qualidade dos dados

- **R21-01** — Centro de qualidade cobrindo vendas, mídia, atribuição e transporte.
- **R21-02** — Comparar pedidos/valores com exportação/API do checkout.
- **R21-03** — Comparar gastos com a rede no mesmo período, moeda, conta, nível e timezone.
- **R21-04** — Guardar cobertura e intervalos não sincronizados.
- **R21-05** — Diferenciar atraso esperado, erro de conexão, permissão insuficiente, dados incompatíveis e divergência financeira.
- **R21-06** — Detectar queda de eventos, ausência de vendas com tráfego, vendas sem origem crescendo, token expirado, fila acumulada e mudança de schema.
- **R21-07** — Backfill com intervalo, prévia de volume, cota e rastreabilidade.
- **R21-08** — Importações históricas atualizam relatórios sem reenviar conversões.
- **R21-09** — Evitar dupla contagem entre níveis campanha/conjunto/anúncio e breakdowns.
- **R21-10** — Não somar alcance diário para alcance mensal; frequência não é soma de frequências.
- **R21-11** — Exibir fórmulas e denominadores; médias ponderadas com totais corretos.
- **R21-12** — Snapshot/versão dos dados usados em exportações e avaliações de regras.
- **R21-13** — Correções registram autor, mudança e relatórios recalculados; nunca apagar evidência original.

## 22. Dicionário financeiro e fórmulas

- **R22-01** — Serviço único de métricas compartilhado por dashboard, API, relatórios, regras, IA e app; cada métrica declara fonte, fórmula, denominador, base temporal, moeda, qualidade e política de reembolso.
- **R22-02** — Bases temporais: por aprovação, por movimento financeiro, por coorte de aquisição; nunca apresentadas como iguais.
- **R22-03** — Por aprovação: estornos posteriores ajustam a coorte até `as_of`, mantendo bruto original e histórico.
- **R22-04** — Métricas: pedidos gerados, aprovados brutos, retidos, receita bruta aprovada, estornos financeiros, receita após estornos, receita da organização, investimento, ROAS bruto, ROAS após estornos, MER, CPA aprovado, CPA retido, ticket médio bruto, CPL, CTR de link, CPC de link, CPM, conversão da página, aprovação de pagamento, contribuição após mídia, resultado operacional estimado, LTV observado.
- **R22-05** — Denominador zero/inexistente → "—" com razão; conversões fracionadas rotuladas.
- **R22-06** — Custos versionados por vigência: taxa % e fixa de checkout, gateway, antecipação, parcelamento, impostos estimados, comissão, coprodução, custo de produto, frete, subsídio, chargeback, reembolso, despesas fixas, custo do rastreador.
- **R22-07** — Priorizar valores reais do provedor; estimativas identificadas; não subtrair taxa duas vezes quando a origem envia líquido.
- **R22-08** — Custos materiais ausentes → "resultado parcial" com custos faltantes; nunca chamar faturamento − anúncios de lucro líquido.
- **R22-09** — ROAS/CPA de equilíbrio com margem conhecida; sem margem não positiva, moedas misturadas ou premissas ocultas.
- **R22-10** — Multimoeda: valor original preservado, câmbio identificado/datado/configurável; sem taxa válida separar moedas; sem taxa fixa inventada.

## 23. Dashboard

- **R23-01** — Painel profissional, responsivo, tema claro/escuro, acessível, densidade ajustável, layout original.
- **R23-02** — Elementos globais: organização/projeto, período, comparação, fuso, moeda, última atualização.
- **R23-03** — Filtros: checkout, produto, oferta, fonte, rede, conta, campanha, conjunto, anúncio, status, método.
- **R23-04** — Modelo e janela de atribuição visíveis.
- **R23-05** — Seletor métricas internas vs reportadas pelas redes, sem misturar.
- **R23-06** — Indicador de sincronização parcial, dados estimados e integrações com falha.
- **R23-07** — Cards configuráveis (investimento, receita, aprovadas, retidas, CPA, ROAS, ticket, estornos, contribuição, leads, vendas sem atribuição) que abrem definição e registros.
- **R23-08** — Gráficos: evolução receita/gasto/contribuição, vendas por hora/dia, composição por produto/canal, funil, qualidade da atribuição; sem empilhar receitas sobrepostas.
- **R23-09** — Tabelas: colunas selecionáveis, ordenação, redimensionar, fixar, visões salvas, busca, paginação no servidor, filtros compostos, tags, totais corretos, exportação e drill-down.
- **R23-10** — Múltiplos dashboards (produto, cliente, projeto, consolidado autorizado), modelos, duplicação, ordem de widgets e compartilhamento controlado sem credenciais/dados pessoais.
- **R23-11** — Metas e alertas de receita, contribuição, gasto, CPA, ROAS; notificações informam o que mudou.

## 24. Vendas, produtos e clientes

- **R24-01** — Lista de vendas: busca por pedido, filtros, origem, valores, taxas, status, método, produto, oferta, cupom, afiliado, histórico; dados pessoais mascarados por permissão.
- **R24-02** — Detalhe da venda: linha do tempo, recebimentos, eventos, itens, pagamentos, reembolsos, evidência de atribuição, destinos e conciliação; copiar IDs não sensíveis; exportar autorizado.
- **R24-03** — Produtos: grupos, ofertas, planos, preço de referência, custos com vigência, mapeamento de IDs externos por provedor; mesmo nome em checkouts diferentes não é o mesmo produto.
- **R24-04** — Clientes: histórico, primeira compra, recorrência, receita/contribuição, consentimentos, vínculos; deduplicação explicável e reversível; sem grafo compartilhado entre clientes do SaaS.
- **R24-05** — Vendas manuais/offline por API ou formulário com permissão, origem, comprovante e auditoria; confirmação manual ≠ checkout; correções por ajustes.
- **R24-06** — E-commerce: pagamento, cancelamento, devolução, frete e atendimento separados; respeitar mecanismos de extensão de cada loja.

## 25. Gestão de campanhas

- **R25-01** — Consultar/filtrar campanhas, conjuntos/grupos e anúncios nas redes implementadas.
- **R25-02** — Pausar, ativar, renomear e editar campos permitidos.
- **R25-03** — Orçamento absoluto/percentual respeitando unidade, moeda, mínimo, teto e nível (CBO/ABO).
- **R25-04** — Ações em lote com resultado por item, sem repetir concluídos.
- **R25-05** — Duplicar na mesma conta e entre contas com remapeamento explícito e validação de ativos.
- **R25-06** — Histórico de alterações com autor, regra/IA e antes/depois.
- **R25-07** — Criação rápida guiada com presets e validação de objetivo, orçamento, destino, pixel, evento, criativo, identidade, público e UTMs.
- **R25-08** — Biblioteca de criativos próprios/autorizados com upload, prévia e metadados.
- **R25-09** — Antes de executar: objetos, conta, moeda, valores, limites e validade; revalidar no servidor; políticas autorizadas sem confirmação repetida mas suspensíveis.
- **R25-10** — Novas campanhas/duplicações pausadas por padrão; publicação explícita.
- **R25-11** — Timeout em escrita → reconciliar antes de repetir; "desfazer" é compensatório e limitado.

## 26. Motor de regras

- **R26-01** — Construtor visual AND/OR com escopo, agenda, timezone, período, fonte de métrica, janela de atribuição, amostra mínima e ação; sem código arbitrário.
- **R26-02** — Condições: gasto, aprovadas/retidas, CPA, ROAS, contribuição, CTR, CPC, CPM, frequência, idade, status, variação de orçamento, saldo real.
- **R26-03** — Ações: alertar, pausar, ativar, ajustar orçamento, duplicar, tag, webhook autorizado.
- **R26-04** — Simulação sem escrita com relatório.
- **R26-05** — Versão imutável da regra e registro dos dados usados.
- **R26-06** — Cooldown, teto diário de ações, teto de gasto/orçamento e variação máxima.
- **R26-07** — Lock por entidade, idempotência e prevenção de ciclos.
- **R26-08** — Política de conflito explícita.
- **R26-09** — Sem execução com fonte atrasada/incompleta/indisponível; faltante ≠ zero.
- **R26-10** — Excluir itens em aprendizagem por padrão; respeitar atraso de conversão e janela mínima.
- **R26-11** — Circuit breaker (integração, relógio, permissão, reconciliação); parada por regra, projeto, organização e sistema.
- **R26-12** — Explicação legível de cada execução/falha/não-execução; reversão limitada e teste antes da ativação.
- **R26-13** — Presets desligados e rotulados como exemplo; simulação histórica não prova causalidade.

## 27. Gestor com IA

- **R27-01** — Assistente que analisa campanhas, explica indicadores, aponta inconsistências, sugere ações e gera relatórios.
- **R27-02** — Provedores intercambiáveis (OpenAI, Anthropic, Google, chaves próprias); modelos não fixados sem consulta.
- **R27-03** — Fluxos: contribuição negativa, mudança de ROAS (observação vs hipótese), vendas sem origem, comparação de criativos com amostra, sugestão de regra sem ativar, resumo programado.
- **R27-04** — Ferramentas tipadas e autorizadas; nunca SQL arbitrário do modelo.
- **R27-05** — Cálculos pelo serviço de métricas.
- **R27-06** — Afirmações vinculadas a valores, filtros, período, fontes e atualização; fato vs interpretação vs hipótese vs recomendação vs ausente.
- **R27-07** — Limitação de amostra; sem causalidade não demonstrada.
- **R27-08** — Auditoria de consultas/ações com retenção e mascaramento; sem payloads/dados pessoais por padrão.
- **R27-09** — Nomes de campanha/páginas/mensagens tratados como não confiáveis (anti prompt injection).
- **R27-10** — Sem chave/conectividade: estado indisponível, sem simular análise.
- **R27-11** — Limites de custo, chamadas, tokens, concorrência e cancelamento por organização.
- **R27-12** — Modos: análise, sugestão, execução sob política; mesma autorização/limites/idempotência das regras; sem acesso direto irrestrito.

## 28. WhatsApp

- **R28-01** — Medir leads e vendas originados/recuperados pelo WhatsApp via APIs oficiais ou provedores autorizados; sem automação não oficial.
- **R28-02** — Conectar número por fluxo oficial e validar permissões.
- **R28-03** — Registrar referências Click-to-WhatsApp quando o webhook as fornecer, com formato/finalidade reais.
- **R28-04** — Links com referência curta sem dados pessoais.
- **R28-05** — Associar sessão a lead/conversa com ligação comprovada, prevendo perda de vínculo.
- **R28-06** — Eventos distintos: clique, mensagem recebida, conversa, lead qualificado, negócio, venda.
- **R28-07** — Vincular venda ao lead por CRM, checkout ou registro manual auditado.
- **R28-08** — Relatórios por número, atendente, campanha, origem, produto, etapa.
- **R28-09** — Deduplicar status/atualizações; janela configurável e histórico do caminho.
- **R28-10** — Compra nunca inferida de mensagem/conversa/negócio sem confirmação financeira; minimizar conteúdo de mensagens.
- **R28-11** — Mensageria opcional (inbox, templates, recuperação, notificações) com opt-out, limites e regras vigentes do canal.
- **R28-12** — Limitações do provedor visíveis; sem prometer rastrear contas pessoais.

## 29. CRM e recuperação

- **R29-01** — CRM interno leve: contatos, leads, negócios, pipeline, etapas, responsáveis, notas, tarefas e origem.
- **R29-02** — Conectores Kommo, HubSpot, Pipedrive, RD Station, Salesforce, Zoho com direção de sincronização por objeto/campo.
- **R29-03** — Vínculos estáveis, upsert, anti-loop, conflitos explícitos, histórico e origem.
- **R29-04** — Deduplicação de contatos com revisão de ambíguos; campos de UTM, clique, produto e pedido.
- **R29-05** — Negócio ganho gera evento comercial, não pagamento confirmado; conversões offline respeitam fonte, consentimento, tempo e destino.
- **R29-06** — Recuperação: detectar pendência/abandono só com evidência; separar Pix pendente/expirado, boleto, cartão recusado e carrinho.
- **R29-07** — Elegibilidade, consentimento, frequência, quiet hours e cancelamento após pagamento; revalidar antes do envio (corrida).
- **R29-08** — Canais e-mail/WhatsApp/SMS/webhook via conectores autorizados; sem mensagem após cancelamento/opt-out.
- **R29-09** — Origem de aquisição e canal de recuperação medidos separadamente sem duplicar receita; automações exigem habilitação explícita.

## 30. Funis, páginas, VSL e testes

- **R30-01** — Funis, páginas, ofertas, checkout, bump, upsell, downsell com versões e domínios.
- **R30-02** — Análise por etapa (visitas, conteúdo, lead, checkout, pagamento gerado, aprovado, retido, estornado), abandono, taxas, latência e perda de origem, sem números inventados.
- **R30-03** — VSL via APIs de players suportados; sem acesso a iframe de terceiros; repetição ≠ espectador único; definição de retenção.
- **R30-04** — Experimentos com variantes, alocação estável, datas, população, métrica definida antes, relatórios por variante.
- **R30-05** — Sem vencedor com poucas observações; estatística com método documentado; observacional ≠ causal.
- **R30-06** — Sem manipulação de páginas de terceiros; fallback de redirecionamentos de teste.

## 31. Criativos

- **R31-01** — Biblioteca de criativos das contas conectadas com prévia autorizada, ID, nome, tags, formato, produto, datas e performance; sem scraping.
- **R31-02** — Comparação por investimento, receita, contribuição, CPA, ROAS, cliques, retenção e vídeo disponíveis; agrupamentos informados pelo usuário ou rotulados como assistidos.
- **R31-03** — Reutilização por IDs/assinaturas confiáveis sem multiplicar gasto/receita; detalhamento por posicionamento/dispositivo/período.
- **R31-04** — Hook/hold rate com fórmula e disponibilidade por rede; fadiga como hipótese.
- **R31-05** — Exportação e ligação com campanhas, funis e testes; IA sem inventar conteúdo não analisado.

## 32. Relatórios e exportações

- **R32-01** — Relatórios personalizáveis e salvos (filtros, colunas, agrupamentos, fórmulas, atribuição).
- **R32-02** — CSV/XLSX tipados com moeda e timezone; PDF com data, fontes e notas.
- **R32-03** — Link de relatório com permissão, expiração, revogação e dados pessoais ocultos.
- **R32-04** — Agendamento diário/semanal/mensal com destinatários autorizados.
- **R32-05** — Comparações de períodos, campanhas, produtos e fontes.
- **R32-06** — Exportação assíncrona com progresso e link temporário.
- **R32-07** — Conectores Google Sheets, Drive, BigQuery, Metabase, Looker Studio; sem chamar CSV de integração nativa.
- **R32-08** — Make, n8n, Zapier, webhook, e-mail e notificações com templates documentados.
- **R32-09** — Migração de históricos por APIs/exportações do usuário; sem Purchase histórico por padrão; política de colisão.
- **R32-10** — Neutralizar fórmulas em células (CSV injection); sem URLs públicas permanentes com dados de clientes.

## 33. API pública e webhooks de saída

- **R33-01** — REST versionada com OpenAPI, paginação por cursor, filtros coerentes, chaves revogáveis com escopos por organização/projetos; hash da chave armazenado.
- **R33-02** — Recursos: métricas, pedidos, produtos, fontes, campanhas, status de integração, leads, eventos, importação de vendas; nada administrativo.
- **R33-03** — Rate limit por organização/chave com cabeçalhos; Idempotency-Key em criações/importações.
- **R33-04** — Erro consistente com código, mensagem e request ID; versionamento e depreciação; exemplos testados e sandbox; logs de uso sem conteúdo sensível, último acesso e revogação.
- **R33-05** — Webhooks de saída: eventos selecionáveis, destino, ownership, assinatura com timestamp e ID, retries, dead letters, teste explícito, rotação de segredo com transição.
- **R33-06** — Proteção SSRF: bloquear privados, loopback, link-local, metadata e esquemas indevidos; validar DNS e redirects no momento da conexão; limitar resposta, timeout e redirects.
- **R33-07** — Webhook de saída que retorna à entrada não cria loop; proveniência e limite de encaminhamento.

## 34. Alertas e notificações

- **R34-01** — Central com preferências por usuário, projeto, tipo e horário; canais painel, e-mail, web push, app; Telegram/Slack/WhatsApp só conectados.
- **R34-02** — Alertas: venda aprovada, reembolso, chargeback, meta, conexão perdida, token expirando, fila atrasada, custo excedido, gasto sem conversão, saldo baixo, regra executada, falha de CAPI, cobrança do SaaS.
- **R34-03** — Deduplicar por evento semântico; som de venda opcional com teste/mute/volume, sem reemitir vendas antigas.
- **R34-04** — Tela bloqueada sem dados pessoais; push dependente de consentimento; falha de push não interrompe registro da venda.

## 35. Mobile, PWA e app nativo

- **R35-01** — Web responsiva e PWA instalável primeiro; dashboard, vendas, notificações, filtros e diagnóstico em telas pequenas.
- **R35-02** — App `apps/mobile` (Expo) com API compartilhada, armazenamento seguro, biometria opcional, push, deep links e troca de organização.
- **R35-03** — Escopo móvel: métricas, vendas, integrações, regras, campanhas, ações com mesma validação, modo leitura, offline datado sem ações silenciosas, limpeza ao sair.
- **R35-04** — Publicação em lojas só declarada após publicação real; PWA não prova app nas lojas.

## 36. Cobrança do SaaS

- **R36-01** — Assinaturas da plataforma totalmente separadas dos pedidos rastreados.
- **R36-02** — Planos configuráveis, trial, mensal/anual, cupons, upgrade/downgrade, cancelamento, tolerância, reativação, histórico, recibos, portal; preços em configuração.
- **R36-03** — Entitlements aplicados no servidor.
- **R36-04** — Metering idempotente e auditável; política de estorno de uso definida.
- **R36-05** — Inadimplência com tolerância limitada, sem descartar vendas silenciosamente; aviso de retenção.
- **R36-06** — Checkout hospedado pelo provedor; sem cartão/CVV; ativação por webhook autenticado.
- **R36-07** — Anti-abuso de trial e reembolso auditado; recibo ≠ nota fiscal; NF só com conector verificado.

## 37. Agências e personalização

- **R37-01** — Vários clientes isolados com contratos de acesso independentes; visão consolidada só com acesso explícito.
- **R37-02** — Equipes, responsáveis, permissões por projeto e onboarding.
- **R37-03** — Compartilhamento com cliente leitor; marca própria em relatórios; domínio personalizado com validação e TLS.
- **R37-04** — Templates (dashboards, UTMs, custos, regras) sem copiar segredos; transferência de projeto com prévia e prevenção de vazamento.
- **R37-05** — Revogar agência/colaborador não destrói dados do cliente; white-label mantém identificação de processadores; sem revenda ilimitada.

## 38. Administração e suporte

- **R38-01** — Área administrativa separada: organizações, planos, uso, limites, jobs, saúde, incidentes, custos, conexões degradadas, tickets.
- **R38-02** — Sem leitura irrestrita de dados pessoais por padrão; acesso excepcional com justificativa, prazo, escopo e auditoria; impersonação explícita e restrita.
- **R38-03** — Feature flags, rollout por organização, manutenção, incidentes, status, busca técnica, exportação de diagnóstico sanitizado, suporte contextual.
- **R38-04** — Desativar conector, drenar filas, isolar organizações abusivas, reprocessar intervalo; sem correções diretas no banco sem registro.

## 39. Telas e qualidade de experiência

- **R39-01** — Áreas: Entrada, Onboarding, Visão geral, Campanhas, Vendas, Produtos, Origem, Pixels, Integrações, Automação, IA, WhatsApp/CRM, Funis, Relatórios, Financeiro, Configurações, Assinatura, Administração — implementadas conforme módulos; módulos vazios não apresentados como prontos.
- **R39-02** — Sidebar recolhível, filtros persistentes, teclado, contraste, foco visível, erros acionáveis, atalhos, skeletons, estados vazios, carregamento progressivo.
- **R39-03** — Estados em andamento/concluída/parcial/falha; sem sucesso antes da confirmação do servidor; otimismo reversível.
- **R39-04** — Dados reais da API; contas novas sem faturamento fictício; tour em organização demo isolada.
- **R39-05** — Sem detalhes de infraestrutura na navegação normal; responsividade verificada em desktop e mobile.

## 40. Segurança, privacidade e retenção

- **R40-01** — Autorização no servidor em toda leitura, exportação e mutação.
- **R40-02** — RLS e grants com testes independentes.
- **R40-03** — Sessões seguras, JWT/JWKS com issuer/audience/expiração, cookies adequados, CSRF.
- **R40-04** — OAuth com `state`, redirect URI controlada e PKCE.
- **R40-05** — Segredos criptografados com gestão de chaves, versão e rotação; chaves fora do banco.
- **R40-06** — Nenhum segredo com prefixo público ou no bundle do navegador.
- **R40-07** — Isolamento em storage, relatórios, caches, filas, realtime e busca.
- **R40-08** — SQL parametrizado, validação, limites de tamanho, XSS e sanitização.
- **R40-09** — CORS configurado sem ser autenticação; origem/referrer/segredo público não comprovam identidade.
- **R40-10** — Assinatura de webhooks e anti-replay compatível com retransmissões.
- **R40-11** — Rate limits, anti-flood e defesa contra eventos sintéticos.
- **R40-12** — SSRF, CSV injection e uploads maliciosos.
- **R40-13** — Logs redigidos, retenção limitada e auditoria de acesso a dados sensíveis.
- **R40-14** — Separação de ambientes e credenciais de teste/produção.
- **R40-15** — Revogação, exclusão de credenciais, expiração de links e política de incidentes.
- **R40-16** — Dependências atualizadas, scan de segredos e tratamento de vulnerabilidades.
- **R40-17** — Privacidade: inventário de dados (finalidade, origem, destinatários, retenção), consentimento/CMP, processamento do serviço vs publicidade.
- **R40-18** — Exportação, correção e exclusão/anonimização; exclusão de identificação vs lançamentos financeiros agregados; hash ≠ anonimização.
- **R40-19** — Minimizar IP, telefone, e-mail, endereço, CPF e mensagens; sem monitoramento sensível; exclusão em índices, caches, derivados e backups.
- **R40-20** — Minutas de política de privacidade, termos e DPA identificadas para revisão.
- **R40-21** — Retenção configurável por categoria com aviso da consequência para reatribuição.

## 41. Configuração, desenvolvimento local e implantação

- **R41-01** — `.env.example` com descrição, escopo público/servidor, formato, obrigatoriedade e origem; sem valores reais.
- **R41-02** — Categorias: URLs, Supabase, PostgreSQL por papel, Redis/worker, chaves de criptografia/assinatura, OAuth por provedor, cobrança, SMTP/push/observabilidade, feature flags/ambiente.
- **R41-03** — Credenciais de clientes no cofre do servidor por conexão; nunca em variáveis globais ou Git.
- **R41-04** — Desenvolvimento local reproduzível: banco local, Redis, lockfile, migrações, seed sintético marcado; documentar qual banco cada comando usa.
- **R41-05** — Comandos reais: dev, build, lint, typecheck, testes, migrações, seed, worker, simulação de webhook, backfill, diagnóstico; README sem comandos inexistentes.
- **R41-06** — Implantação: web compatível; API/worker em processos persistentes; Dockerfiles, health checks, readiness, encerramento gracioso, migrações seguras, variáveis por ambiente, TLS, domínio, rollback, limites de conexão/pool/cron.
- **R41-07** — Sem provisionamento pago implícito; produção não declarada pronta por build.

## 42. Operação, capacidade e custo

- **R42-01** — Instrumentar webhooks, eventos, rejeições, atraso de fila, processamento, tentativas externas, falhas por provedor, sincronia de gastos, erros de atribuição e tempo de consultas.
- **R42-02** — IDs de correlação sem dados pessoais; alertas com alcance e ação recomendada.
- **R42-03** — Resiliência: outbox recupera após falha do Redis; worker reinicia sem duplicar; isolamento entre provedores; prioridades/cotas por organização; cursores/checkpoints; backfill não bloqueia vendas; encerramento gracioso; relógio/atraso observáveis.
- **R42-04** — Índices, agregações incrementais, análise de consultas; sem warehouse/Kafka/K8s prematuros.
- **R42-05** — Backups, restauração e DR com procedimento testado; RPO/RTO/SLA como metas até evidência.
- **R42-06** — Estimador de custos operacionais com premissas.
- **R42-07** — Teste de carga reproduzível com cenário, dataset, hardware, concorrência, latências, erros e custo.

## 43. Matriz de testes

- **R43-01** — Automatizar T01–T70 nas etapas correspondentes (lista completa na matriz de rastreabilidade).
- **R43-02** — Fixture financeira sintética obrigatória (R$100 + R$50; mídia R$30; taxas R$5; estornos R$20 e R$50 → bruto 150, estornos 70, líquido 80, 2 aprovados, 1 retido, CPA aprovado 15, CPA retido 30, ticket 75, ROAS bruto 5, ROAS após estornos 80/30, contribuição 45; repetição de webhooks mantém resultados).
- **R43-03** — Testes complementares: login/onboarding, responsividade, teclado, acessibilidade, importação grande, limites do SDK, schemas por provedor, carga do pipeline; sandbox de terceiros identificado; simulação local ≠ homologação.

## 44–47. Execução, entregáveis e definição de pronto

- **R44-01** — Etapas E0–E10 com critérios de conclusão (ver [`STATUS.md`](STATUS.md)); segurança e isolamento desde E1.
- **R44-02** — Lowify sem documentação/payload autorizado: pipeline e simulador próprios, sem declarar E2 validada; idem Meta/Google/lojas.
- **R44-03** — Integrações sem API/acesso: manifesto, limitação comprovada e alternativas legítimas; sem stubs de sucesso.
- **R45-01** — Entregáveis 1–15 da seção 45 (código, schema/RLS, testes, ambiente reproduzível e demo isolada, `.env.example`, docs de conectores, OpenAPI e webhook próprio, manual do SDK, dicionário de métricas, relatório de aceitação, runbooks, implantação, inventário de dados/privacidade, guia de operação, estado atualizado).
- **R45-02** — README permite preparar e executar sem conhecimento implícito; dependências opcionais separadas; recursos bloqueados documentados.
- **R45-03** — Ao fim de cada etapa: resultado, reprodução, testes, limitações, pendências e próximo trabalho.
- **R46-01** — Definição de pronto: interface/contrato, dados reais, autorização/tipos/limites, persistência/concorrência, estados de erro, testes com evidência, documentação de operação, dependências verificadas para a maturidade alegada.
- **R47-01** — Início: inspecionar, PRD, matriz, verificar docs das primeiras integrações, implementar E1 e primeiro fluxo de E2, continuar etapas desbloqueadas, registrar bloqueios, atualizar STATUS e matriz antes de encerrar.

## Anexos

- **RA-01** — Anexo A: referências públicas (UTMify, LowTrack) apenas como categorias funcionais; divergência sobre app LowTrack registrada; promessas comerciais substituídas por indicadores verificáveis.
- **RA-02** — Anexo A: fontes técnicas oficiais a revalidar ao codificar (Meta autorização/dedup/parâmetros, Google Data Manager e restrições do legado, TikTok dedup, Stripe webhooks, Supabase RLS/API, Hotmart, Kiwify, ANPD cookies).
- **RB-01** — Anexo B: dependências externas rastreáveis (ver `EXTERNAL_DEPENDENCIES.md`).
- **RC-01** — Anexo C: instruções curtas de continuidade (reproduzidas em `CLAUDE.md`).
