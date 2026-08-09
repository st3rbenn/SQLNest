# SQLNest frontend — Vite (rolldown-vite) → static → nginx:alpine
# Config runtime (URL du backend) injectée au démarrage via envsubst dans
# /config/context.js — pas de rebuild par environnement. Voir
# apps/frontend/public/config/context.js pour le format lu par le client.
#
# Build depuis la RACINE du monorepo :
#   docker build -f infra/docker/frontend.Dockerfile -t sqlnest/frontend .

# ─── Stage builder : Vite build ─────────────────────────────────────────
FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/frontend/package.json apps/frontend/
COPY packages/design-system/package.json packages/design-system/
COPY packages/snql/package.json packages/snql/
COPY packages/tunnel-protocol/package.json packages/tunnel-protocol/
RUN pnpm install --frozen-lockfile --filter @sqlnest/frontend... --ignore-scripts

COPY apps/frontend ./apps/frontend
COPY packages/design-system ./packages/design-system
COPY packages/snql ./packages/snql
COPY packages/tunnel-protocol ./packages/tunnel-protocol

RUN pnpm --filter @sqlnest/frontend build

# ─── Stage runtime : nginx statique ─────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

# envsubst live dans le paquet gettext.
RUN apk add --no-cache gettext

COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY infra/docker/context.js.tpl /usr/share/nginx/html-tpl/context.js.tpl
COPY infra/docker/frontend-entrypoint.sh /docker-entrypoint.d/40-render-context.sh
RUN chmod +x /docker-entrypoint.d/40-render-context.sh

COPY --from=builder /app/apps/frontend/dist /usr/share/nginx/html

# Le default nginx:alpine ENTRYPOINT scanne /docker-entrypoint.d/*.sh
# avant de démarrer nginx — notre script s'y insère naturellement.
EXPOSE 80
