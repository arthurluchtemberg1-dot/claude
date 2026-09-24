# Implantação

Referência: imagens de `Dockerfile` (alvos `api`, `worker`, `web`) e `deploy/docker-compose.yml` (PostgreSQL 16, Redis 7 com AOF, migrações, API, worker e painel). API e worker são **processos persistentes**; não use funções serverless de curta duração para eles.

## Construir e subir

```bash
cp deploy/.env.example deploy/.env           # preencha (ver checklist)
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/docker-compose.yml --env-file deploy/.env ps
```

- O serviço `migrate` aplica as migrações (somente para frente) e provisiona `tracker_app`/`tracker_system` com LOGIN (`node dist/db-cli.js provision-roles`) antes de API e worker subirem.
- O painel fixa `API_INTERNAL_URL` no build (rewrites do Next). Se a API tiver outro endereço interno, reconstrua o alvo `web` com `--build-arg API_INTERNAL_URL=…`.
- Proxy corporativo com inspeção TLS: `docker build --secret id=extra_ca,src=/caminho/ca.crt …` (o certificado não fica na imagem).
- Banco gerenciado (sem o serviço `postgres`): rode `node dist/db-cli.js migrate` e `provision-roles` com `DATABASE_URL_ADMIN` do provedor, a partir da imagem `api`.

## Checklist antes de produção

| Item | Como verificar |
| --- | --- |
| HTTPS no proxy reverso para painel e API; portas 3000/4000 publicadas só em `127.0.0.1` ou rede privada | `curl -I https://…/health` |
| `NODE_ENV=production`, `APP_ENV=production`, `SESSION_COOKIE_SECURE=true` | a API recusa iniciar sem cookie seguro em produção |
| `CREDENTIALS_KEYS`, `TOKEN_HMAC_SECRET` gerados com 32 bytes aleatórios e guardados em cofre **fora** do banco e dos backups | backups contêm apenas material cifrado (teste T69) |
| Senhas distintas e fortes (≥ 16) para `postgres`, `tracker_app`, `tracker_system` | `provision-roles` recusa senhas curtas |
| `PUBLIC_API_URL`/`NEXT_PUBLIC_APP_URL` corretos (URLs de webhook exibidas ao cliente usam `PUBLIC_API_URL`) | criar conexão de teste e conferir a URL |
| `MFA_REQUIRED_DEFAULT=true` | perfis sensíveis exigem MFA para ações privilegiadas |
| E-mail transacional real (`EMAIL_TRANSPORT=smtp` e variáveis SMTP) | cadastro envia verificação |
| `ALLOW_EXTERNAL_DELIVERY=false` até validar cada destino em modo de teste; depois `true` | Pixels e conversões → entregas |
| `OUTBOUND_ALLOW_PRIVATE_NETWORKS` ausente/false (recusado em produção) | cadastro de webhook para IP interno retorna 400 |
| Redis com AOF e volume persistente | `redis-cli CONFIG GET appendonly` |
| Backup diário + restauração testada em banco novo (abaixo) | relatório "Restauração verificada" |
| Monitorar `/ready` (API e worker), fila (`pnpm diag` ou Diagnóstico) e erros 5xx | alertas no seu provedor de observabilidade (DEP-OBSERVABILITY) |
| Documentos legais e política de privacidade publicados | DEP-LEGAL |

## Escala

- API: sem estado; várias réplicas atrás do balanceador (limites da API pública são compartilhados via banco).
- Worker: várias réplicas são seguras — o relay reivindica itens com `SKIP LOCKED` e cada item é processado com lock; aumente `WORKER_CONCURRENCY` com cuidado com o pool do banco (`WORKER_DB_POOL`).
- Encerramento: `SIGTERM` aguarda requisições/jobs em andamento (`stop_grace_period` de 30 s no worker).

## Backup e restauração (T69)

```bash
# Backup consistente (manifesto e dump no mesmo snapshot)
node scripts/backup.mjs --url "$DATABASE_URL_ADMIN" --out backups/tracker-$(date +%F).dump

# Restauração em banco NOVO e vazio (nunca sobre o banco em uso)
createdb tracker_restaurado
DATABASE_URL_ADMIN=postgres://…/tracker_restaurado DB_APP_PASSWORD=… DB_SYSTEM_PASSWORD=… node packages/db/dist/cli.js provision-roles
node scripts/restore.mjs --url postgres://…/tracker_restaurado --in backups/tracker-AAAA-MM-DD.dump
```

O `restore.mjs` confere o sha256 do arquivo, restaura em transação única e compara migrações, contagem de linhas de todas as tabelas, somas do razão por organização/moeda/tipo, pedidos por status e o digest das credenciais cifradas; qualquer divergência encerra com erro. Credenciais só decifram com `CREDENTIALS_KEYS` (fora do backup). Se um backup vazar, rotacione as credenciais dos provedores (Runbooks → Credencial comprometida). Automatizado e verificado em `apps/api/test/integration/backup-restore.test.ts`.

## Atualização e reversão

1. Backup verificado **antes** de migrar.
2. `docker compose … up -d --build` (o `migrate` roda primeiro; migrações são aditivas e checadas por checksum).
3. Reversão de código: suba a imagem anterior (`TRACKER_VERSION=…`) — as migrações são compatíveis para trás dentro da mesma versão maior; reversão de esquema só por restauração de backup em banco novo.
4. Pós-implantação: `/ready` da API e do worker, `pnpm diag` (fila e migrações), um webhook de teste (Integrações) e o painel carregando.
