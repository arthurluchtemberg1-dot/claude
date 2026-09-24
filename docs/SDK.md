# SDK de rastreamento

Arquivo: `packages/tracker` → `dist/tracker.min.js` (IIFE, sem dependências). Tamanho medido no build: **11,4 KB minificado / 4,3 KB gzip** (orçamento: 6 KiB gzip; o build falha se exceder). Servido pela API em `/sdk/v1/tracker.js` (cache 5 min); em produção recomenda-se CDN com versão fixa.

## Instalação (uma linha)

A tela **Instalação do SDK** gera o código com a chave pública do projeto:

```html
<script>!function(w,d,n,u){w.TrackerQ=w.TrackerQ||[];w[n]=w[n]||function(){w.TrackerQ.push([].slice.call(arguments))};var s=d.createElement("script");s.async=1;s.src=u;d.head.appendChild(s)}(window,document,"tracker","https://SEU-PAINEL/sdk/v1/tracker.js");
tracker("init",{projectKey:"pk_...",endpoint:"https://SEU-PAINEL/api",checkoutHosts:["pay.lowify.com.br"],tokenParam:"utm_term"});</script>
```

A chave pública (`pk_…`) identifica o projeto; **não é segredo e não autentica vendas**. Vendas só são confirmadas pelo webhook do checkout.

## API

| Chamada | Efeito |
| --- | --- |
| `tracker("init", opções)` | Instalação única. Opções: `projectKey`, `endpoint`, `consent`, `checkoutHosts`, `tokenParam` (padrão `trk`), `tokenParamMode` (`set`/`append`; `append` é o padrão para campos `utm_*`), `autoPageView` (true), `spa` (true), `frameOrigins`, `test` |
| `tracker("setConsent", {analytics, ads, storage})` | Consentimento por finalidade. Negar/revogar limpa fila e armazenamento |
| `tracker("track", nome, props)` | Evento próprio (ex.: `ViewContent`, `Lead`, `AddToCart`, `InitiateCheckout`). Até 20 propriedades primitivas; chaves com aparência de dado pessoal são descartadas no servidor |
| `tracker("linkCheckout", url)` | Retorna a URL do checkout com UTMs da sessão (sem sobrescrever parâmetros existentes) e o token no parâmetro configurado |
| `tracker("requestToken")` | Solicita token opaco ao servidor (requer consentimento de analytics) |
| `tracker("identify", email)` | Envia somente o hash SHA-256 do e-mail fornecido voluntariamente (requer consentimento) |
| `tracker("reset")` | Limpa identificadores, token e fila |
| `tracker("touches")` | Primeiro toque, último toque e último toque pago (quando o armazenamento é permitido) |

Cliques em links cujo host está em `checkoutHosts` (ou com atributo `data-tracker-checkout`) geram o evento `CheckoutClick` — que **não** equivale a checkout iniciado — e têm o `href` decorado no momento do clique.

## Consentimento e privacidade

- Padrão do projeto `require_explicit`: sem `analytics=true` nada é enviado nem armazenado; sem `storage=true` identificadores ficam apenas em memória (duram a página); sem `ads=true` os cookies `_fbp`/`_fbc` não são lidos e IP/User-Agent não são guardados no servidor.
- URLs enviadas contêm apenas origem, caminho e parâmetros UTM/click ID; e-mails ou tokens no caminho são redigidos.
- Não há fingerprinting, leitura de formulários, canvas ou vínculo por IP.
- Falhas de rede: lotes de até 50 eventos, reenvio com backoff (até 5 tentativas), `sendBeacon` ao sair da página. Armazenamento indisponível (modo privado, bloqueio) não quebra a página.

## Passagem para o checkout (Lowify)

A Lowify documenta o retorno de `utm_source/medium/campaign/content/term` no webhook, mas não um campo para token próprio. Configure na conexão Lowify o campo transportador (ex.: `utm_term`) e use o mesmo `tokenParam` no SDK; o valor é acrescentado como `…|trk_…`. **Valide com uma venda de teste autorizada** (DEP-LOWIFY-TRACKING) — o diagnóstico de cada pedido mostra se o token voltou.

## Compatibilidade

HTML, WordPress/Elementor, GTM, React/Next.js (rotas SPA detectadas), Webflow/Wix (quando o plano permite código), Shopify/WooCommerce (tema; checkouts hospedados podem bloquear scripts), Typebot/iframes via `frameOrigins` + `postMessage({type:"tracker:event", name, props})`. Instruções por plataforma na tela de instalação; validação em cada plataforma ainda pendente.
