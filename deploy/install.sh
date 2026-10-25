#!/usr/bin/env bash
# Instalação/atualização do Tracker em um servidor Linux (Ubuntu 22.04+/Debian 12+), em um comando:
#
#   sudo bash deploy/install.sh --domain painel.seudominio.com.br --email voce@seudominio.com.br
#
# O que faz: instala o Docker (se faltar), gera deploy/.env com segredos aleatórios (só na primeira vez),
# constrói e sobe PostgreSQL, Redis, API, worker, painel e Caddy (HTTPS automático), espera ficar saudável
# e cria a conta do proprietário (senha digitada aqui, sem eco). Rodar de novo atualiza mantendo os segredos.
#
# Antes: aponte o DNS (registro A) do domínio para o IP deste servidor e libere as portas 80 e 443.
# Opções: --name "Seu nome"  --smtp-url smtps://usuario:senha@host:465  --sem-envios (não liga envios reais)
set -euo pipefail

DOMAIN=""
EMAIL=""
NAME=""
SMTP_URL=""
EXTERNAL=""

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --name) NAME="${2:-}"; shift 2 ;;
    --smtp-url) SMTP_URL="${2:-}"; shift 2 ;;
    --sem-envios) EXTERNAL="false"; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Opção desconhecida: $1" >&2; usage; exit 1 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m[aviso]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[erro]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Rode como root (sudo bash deploy/install.sh ...)"
cd "$(dirname "$0")/.."
[ -f deploy/docker-compose.yml ] || die "Rode a partir do repositório do Tracker (deploy/docker-compose.yml não encontrado)"

ENV_FILE=deploy/.env
if [ -f "$ENV_FILE" ]; then
  # Atualização: reaproveita domínio e e-mail já configurados.
  DOMAIN="${DOMAIN:-$(grep -E '^TRACKER_DOMAIN=' "$ENV_FILE" | cut -d= -f2-)}"
  EMAIL="${EMAIL:-$(grep -E '^ACME_EMAIL=' "$ENV_FILE" | cut -d= -f2-)}"
fi
[ -n "$DOMAIN" ] || read -rp "Domínio do painel (ex.: painel.seudominio.com.br): " DOMAIN
[ -n "$EMAIL" ] || read -rp "Seu e-mail (login do proprietário e avisos do certificado): " EMAIL
DOMAIN="$(echo "$DOMAIN" | tr 'A-Z' 'a-z' | sed -E 's#^https?://##; s#/.*$##')"
echo "$DOMAIN" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$' || die "Domínio inválido: $DOMAIN"
echo "$EMAIL" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' || die "E-mail inválido: $EMAIL"

say "1/5 Docker"
if ! command -v docker >/dev/null 2>&1; then
  command -v curl >/dev/null 2>&1 || (apt-get update -y && apt-get install -y curl)
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose (plugin) não encontrado; instale o docker-compose-plugin"
command -v openssl >/dev/null 2>&1 || (apt-get update -y && apt-get install -y openssl)

say "2/5 DNS"
DNS_IP="$( (getent ahostsv4 "$DOMAIN" 2>/dev/null || true) | awk 'NR==1{print $1}')"
if [ -z "$DNS_IP" ]; then
  warn "$DOMAIN ainda não resolve para nenhum IP. Crie o registro A apontando para este servidor; o HTTPS só é emitido depois disso."
else
  echo "$DOMAIN → $DNS_IP"
  if ! hostname -I 2>/dev/null | tr ' ' '\n' | grep -qx "$DNS_IP"; then
    warn "O IP do DNS ($DNS_IP) não aparece nas interfaces deste servidor. Se o servidor estiver atrás de NAT/IP público próprio, ignore; senão, confira o registro A."
  fi
fi

say "3/5 Configuração (deploy/.env)"
if [ -f "$ENV_FILE" ]; then
  echo "Mantendo $ENV_FILE existente (segredos preservados)."
else
  rand() { openssl rand -hex 24; }
  key() { openssl rand -base64 32 | tr -d '\n'; }
  b64url() { base64 -w0 | tr '+/' '-_' | tr -d '='; }
  PEM="$(mktemp)"
  openssl ecparam -name prime256v1 -genkey -noout -out "$PEM" 2>/dev/null
  VAPID_PRIVATE="$(openssl ec -in "$PEM" -outform DER 2>/dev/null | tail -c +8 | head -c 32 | b64url)"
  VAPID_PUBLIC="$(openssl ec -in "$PEM" -pubout -outform DER 2>/dev/null | tail -c 65 | b64url)"
  rm -f "$PEM"
  if [ -n "$SMTP_URL" ]; then EMAIL_TRANSPORT=smtp; else EMAIL_TRANSPORT=disabled; fi
  if [ -z "$EXTERNAL" ]; then
    EXTERNAL=true
    if [ -t 0 ]; then
      echo "Envios reais: notificações push no celular, ações na Meta (ainda travadas no painel até você liberar),"
      echo "API de Conversões e webhooks de saída. Testes automatizados nunca usam isso."
      read -rp "Ligar envios reais agora? [S/n] " ans
      case "$ans" in [nN]*) EXTERNAL=false ;; esac
    fi
  fi
  umask 077
  cat >"$ENV_FILE" <<ENV
# Gerado por deploy/install.sh em $(date -u +%Y-%m-%dT%H:%MZ). GUARDE UMA CÓPIA deste arquivo fora do servidor:
# sem CREDENTIALS_KEYS os tokens guardados (Meta, checkout) não podem ser lidos após uma restauração.
TRACKER_DOMAIN=$DOMAIN
ACME_EMAIL=$EMAIL
PUBLIC_API_URL=https://$DOMAIN/api
NEXT_PUBLIC_APP_URL=https://$DOMAIN
APP_ENV=production

POSTGRES_PASSWORD=$(rand)
DB_APP_PASSWORD=$(rand)
DB_SYSTEM_PASSWORD=$(rand)

CREDENTIALS_KEYS=1:$(key)
CREDENTIALS_KEY_CURRENT=1
TOKEN_HMAC_SECRET=$(key)

SESSION_COOKIE_SECURE=true
MFA_REQUIRED_DEFAULT=true
SIGNUP_MODE=closed

EMAIL_TRANSPORT=$EMAIL_TRANSPORT
SMTP_URL=$SMTP_URL
EMAIL_FROM="Tracker <no-reply@$DOMAIN>"

ALLOW_EXTERNAL_DELIVERY=$EXTERNAL

API_BIND=127.0.0.1
WEB_BIND=127.0.0.1

WEB_PUSH_VAPID_PUBLIC_KEY=$VAPID_PUBLIC
WEB_PUSH_VAPID_PRIVATE_KEY=$VAPID_PRIVATE
WEB_PUSH_SUBJECT=mailto:$EMAIL

META_GRAPH_API_VERSION=v26.0
META_APP_SECRET=

AI_PROVIDER=none
AI_API_KEY=
ENV
  chmod 600 "$ENV_FILE"
  echo "Criado $ENV_FILE (permissão 600)."
fi

COMPOSE=(docker compose -f deploy/docker-compose.yml --env-file "$ENV_FILE" --profile https)

say "4/5 Construindo e subindo (a primeira vez leva alguns minutos)"
"${COMPOSE[@]}" up -d --build --remove-orphans

echo -n "Aguardando a API e o painel ficarem prontos"
ok=""
for _ in $(seq 1 120); do
  if "${COMPOSE[@]}" exec -T api node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then ok=1; break; fi
  echo -n "."
  sleep 5
done
echo
[ -n "$ok" ] || die "A API não respondeu. Veja: ${COMPOSE[*]} logs api migrate"
https_ok=""
for _ in $(seq 1 24); do
  if curl -fsS -o /dev/null "https://$DOMAIN/api/health" 2>/dev/null; then https_ok=1; break; fi
  sleep 5
done
[ -n "$https_ok" ] || warn "HTTPS ainda não respondeu em https://$DOMAIN (DNS/porta 80/443?). O Caddy tenta de novo sozinho; veja: ${COMPOSE[*]} logs caddy"

say "5/5 Conta do proprietário"
if "${COMPOSE[@]}" exec -T postgres psql -U postgres -d tracker -Atc "select 1 from iam.users where email = lower('$EMAIL')" 2>/dev/null | grep -q 1; then
  echo "A conta $EMAIL já existe (para trocar a senha: ${COMPOSE[*]} exec api node dist/admin.js reset-password --email $EMAIL)."
else
  if [ -t 0 ]; then
    echo "Defina a senha de $EMAIL (mín. 10 caracteres; não aparece enquanto digita):"
    "${COMPOSE[@]}" exec api node dist/admin.js create-owner --email "$EMAIL" --name "${NAME:-${EMAIL%@*}}"
  else
    warn "Sem terminal interativo. Crie a conta com: ${COMPOSE[*]} exec api node dist/admin.js create-owner --email $EMAIL"
  fi
fi

cat <<FIM

Pronto. Acesse: https://$DOMAIN
  1. Entre com $EMAIL e crie sua organização.
  2. Ative a verificação em duas etapas (pedido na primeira ação sensível) com um app autenticador.
  3. Siga "Primeiros passos" no menu: checkout (webhook), script na página, Meta Ads, parâmetros de URL, push.

Guarde uma cópia de $ENV_FILE fora deste servidor. Para atualizar depois: git pull && sudo bash deploy/install.sh
Guia completo: docs/GUIA_RAPIDO.md
FIM
