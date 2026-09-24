# syntax=docker/dockerfile:1.7
# Imagens de produção do Tracker (alvos: api, worker, web). Uso:
#   docker build --target api    -t tracker-api .
#   docker build --target worker -t tracker-worker .
#   docker build --target web    -t tracker-web --build-arg API_INTERNAL_URL=http://api:4000 .
# O painel encaminha /api e /sdk para API_INTERNAL_URL, que o Next fixa no build (rewrites).

ARG NODE_IMAGE=node:22.22.2-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
# CA adicional opcional (proxies corporativos com inspeção TLS) via segredo de build — não fica na imagem:
#   docker build --secret id=extra_ca,src=/caminho/ca.crt ...
RUN --mount=type=secret,id=extra_ca,required=false NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca corepack enable && NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca corepack prepare pnpm@10.33.0 --activate
WORKDIR /repo

FROM base AS build
COPY . .
RUN --mount=type=secret,id=extra_ca,required=false NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca pnpm install --frozen-lockfile
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=${API_INTERNAL_URL}
RUN pnpm --filter @tracker/tracker build \
 && pnpm --filter @tracker/api build \
 && pnpm --filter @tracker/worker build \
 && pnpm --filter @tracker/db build:cli \
 && pnpm --filter @tracker/web build
# node_modules somente de produção por app (dependências de terceiros; pacotes do workspace já estão no bundle).
RUN --mount=type=secret,id=extra_ca,required=false export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca \
 && pnpm --filter @tracker/api deploy --prod --legacy /out/api \
 && pnpm --filter @tracker/worker deploy --prod --legacy /out/worker

# Sem pacotes do sistema: API e worker tratam SIGTERM (encerramento gracioso) e não criam processos filhos;
# para reaproveitar zumbis/sinais use `init: true` (compose) ou `--init` (docker run).
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

# API: servidor HTTP, SDK servido em /sdk/v1/tracker.js e CLI de banco (migrate/status/provision-roles).
FROM runtime AS api
COPY --from=build --chown=node:node /out/api/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
COPY --from=build --chown=node:node /repo/packages/db/dist/cli.js ./dist/db-cli.js
COPY --from=build --chown=node:node /repo/packages/db/migrations ./migrations
COPY --from=build --chown=node:node /repo/packages/tracker/dist/tracker.min.js ./sdk/tracker.min.js
USER node
ENV API_PORT=4000
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]

# Worker: relay da outbox, consumidor BullMQ, entregas. Processo persistente (não serverless).
FROM runtime AS worker
COPY --from=build --chown=node:node /out/worker/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/worker/dist ./dist
USER node
ENV WORKER_HEALTH_PORT=4100
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKER_HEALTH_PORT||4100)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

# Painel: saída standalone do Next.
FROM runtime AS web
ENV HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/entrar').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
