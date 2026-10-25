# Guia rápido — Tracker no ar em ~20 minutos

Para uso próprio (1 a 10 pessoas, suas ofertas). Você vai precisar de: um servidor Linux, um domínio e acesso
ao Business Manager da Meta e ao painel do seu checkout. Nenhum segredo é pedido por mensagem: tudo é digitado
no servidor ou colado no painel (em campos protegidos, guardado cifrado).

| Etapa | Tempo |
| --- | --- |
| 1. Servidor e DNS | 5 min |
| 2. Instalação (um comando) | 5–8 min (automático) |
| 3. Primeiro acesso e verificação em duas etapas | 2 min |
| 4. Checkout (webhook) | 3 min |
| 5. Meta Ads (token) | 5 min |
| 6. Script na página e parâmetros de URL | 3 min |
| 7. Celular (notificações) | 1 min |

## 1. Servidor e DNS

1. Crie um servidor Ubuntu 22.04 ou 24.04 com **2 vCPU e 4 GB de RAM** (ex.: qualquer VPS; 40 GB de disco bastam no começo).
2. No seu provedor de domínio, crie um registro **A** `painel.seudominio.com.br` → IP do servidor.
3. Libere as portas **80 e 443** no firewall do provedor (o HTTPS é emitido automaticamente pelo Let's Encrypt).

## 2. Instalação (um comando)

No servidor (SSH como root ou com sudo):

```bash
git clone <URL do seu repositório> tracker && cd tracker
sudo bash deploy/install.sh --domain painel.seudominio.com.br --email voce@seudominio.com.br
```

O instalador:

- instala o Docker se faltar;
- gera `deploy/.env` com senhas e chaves aleatórias (banco, cofre de credenciais, sessões, chaves de push);
- sobe PostgreSQL, Redis, API, worker, painel e o Caddy (HTTPS);
- pergunta se liga os **envios reais** (push no celular, ações na Meta, API de Conversões) — responda `S`;
- pede a **senha do proprietário** (digitada no terminal, sem eco).

> Guarde uma cópia de `deploy/.env` fora do servidor (gerenciador de senhas). Sem `CREDENTIALS_KEYS` os tokens
> guardados não podem ser lidos depois de uma restauração.

Opções: `--smtp-url smtps://usuario:senha@smtp.provedor.com:465` liga e-mails (recuperação de senha, convites,
alertas por e-mail). Sem SMTP o sistema funciona normalmente; senha e verificação em duas etapas são redefinidas
pelo servidor:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile https exec api node dist/admin.js reset-password --email voce@seudominio.com.br
docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile https exec api node dist/admin.js reset-mfa --email voce@seudominio.com.br
```

Atualizar depois: `git pull && sudo bash deploy/install.sh` (mantém os segredos e os dados).

## 3. Primeiro acesso

1. Abra `https://painel.seudominio.com.br`, entre com o e-mail e a senha definidos e crie a organização (fuso e moeda).
2. Na primeira ação sensível (conectar integrações), o painel pede a **verificação em duas etapas**: leia o QR code
   com Google Authenticator, Authy ou 1Password e digite o código.
3. Abra **Primeiros passos** no menu: cada etapa abaixo é marcada sozinha quando o sistema confirma que funcionou.

## 4. Checkout (webhook)

1. **Integrações → Nova conexão**: escolha o provedor (ex.: Lowify), projeto e conta, e crie.
2. Copie a **URL do webhook** (aparece uma vez) e cadastre no checkout com os eventos de venda pendente, aprovada e reembolsada.
3. Faça uma venda de teste autorizada: ela aparece em **Vendas** e no sino de notificações.

## 5. Meta Ads

No [Business Manager](https://business.facebook.com) (os nomes dos menus podem variar):

1. Se ainda não houver, crie um app do tipo **Empresa** em developers.facebook.com → Meus apps, ligado ao seu negócio.
2. **Configurações do negócio → Usuários → Usuários do sistema → Adicionar** (ex.: “Tracker”).
3. **Atribuir ativos**: suas contas de anúncios com **controle total** (para pausar e mudar orçamento pelo painel).
4. **Gerar novo token**: escolha o app e marque `ads_read`, `ads_management` (e `business_management`). Prefira sem expiração.
5. No painel: **Meta Ads** (menu Rastreamento) → cole o token → **Conectar Meta**.

A primeira sincronização traz 30 dias de campanhas, conjuntos, anúncios, gasto e compras reportadas; depois
atualiza a cada 15 minutos (e após cada alteração). Para pausar/ativar e ajustar orçamento pelo painel e pelas
regras, ligue **Ações de gestão pelo painel** na mesma página.

## 6. Script na página e parâmetros de URL

1. **Instalação do SDK**: copie o script e cole no `<head>` da sua página de vendas (ou no construtor de páginas).
   O painel mostra quando os primeiros eventos chegarem.
2. Em **cada anúncio** (ou campanha) na Meta, campo **Parâmetros de URL**, cole o modelo da página Meta Ads:

```
utm_source=facebook&utm_medium=paid_social&utm_campaign={{campaign.name}}|{{campaign.id}}&utm_term={{adset.name}}|{{adset.id}}&utm_content={{ad.name}}|{{ad.id}}
```

Com os IDs na URL, venda e gasto se juntam por ID: renomear campanha não quebra nada.

## 7. Celular

1. Abra o painel no navegador do celular → **Adicionar à tela inicial** (iPhone: Compartilhar → Adicionar à Tela de Início).
2. Abra pelo ícone → **Notificações** → **Ativar neste dispositivo**. Você recebe cada venda aprovada e alertas
   (limite de gasto da conta perto do fim, conta com problema, acesso à Meta perdido).

## Depois

- **Campanhas**: gasto da Meta + vendas confirmadas por ID, ROAS, CPA, lucro, compras reportadas pela Meta (separadas),
  ligar/desligar, orçamento, duplicar, renomear e histórico de alterações.
- **Regras**: modelos (gasto sem venda, CPA acima do limite, ROAS abaixo do mínimo, pausar anúncio sem venda);
  simule antes de ativar; por padrão não agem em conjuntos em fase de aprendizado.
- **Gestor IA**: opcional; configure `AI_PROVIDER`/`AI_API_KEY` em `deploy/.env` e rode o instalador de novo.
- **API de Conversões**: Pixels e conversões → destino Meta com o token do conjunto de dados; teste com o código de evento de teste antes de ligar.

Problemas: **Diagnóstico** no painel; logs com
`docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile https logs -f api worker caddy`.
Backup e restauração: `docs/DEPLOYMENT.md`.
