# SQLNest backend — Fastify + Better Auth + Drizzle
# Runtime : tsx sur node:22-alpine (pas de compile step, packages workspace
# consommés directement en .ts source). Tini pour PID 1 propre → SIGTERM
# atteint bien Fastify.close() (voir apps/backend/src/index.ts).
#
# Build depuis la RACINE du monorepo :
#   docker build -f infra/docker/backend.Dockerfile -t sqlnest/backend .

FROM node:22-alpine AS base
RUN apk add --no-cache tini && corepack enable
WORKDIR /app

# ─── Stage deps : install pnpm avec juste les manifests ─────────────────
# Copie ciblée pour maximiser le cache Docker (les manifests changent
# rarement, les sources changent souvent).
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json apps/backend/
COPY packages/cli/package.json packages/cli/
COPY packages/db/package.json packages/db/
COPY packages/engine/package.json packages/engine/
COPY packages/snql/package.json packages/snql/
COPY packages/tunnel-protocol/package.json packages/tunnel-protocol/
COPY packages/design-system/package.json packages/design-system/
RUN pnpm install --frozen-lockfile --ignore-scripts

# ─── Stage runtime ──────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production

# User non-root (`node` fourni par l'image officielle). `--chown` à la copie :
# un `chown -R` après coup réécrit chaque fichier dans une couche de plus et
# double la taille de l'image.
RUN chown node:node /app
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node --from=deps /app/apps/backend/node_modules ./apps/backend/node_modules
COPY --chown=node:node --from=deps /app/packages ./packages
COPY --chown=node:node --from=deps /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --chown=node:node --from=deps /app/package.json ./package.json

# Sources — copiées après node_modules pour que les changements de code
# n'invalident pas le cache d'install.
COPY --chown=node:node apps/backend ./apps/backend
COPY --chown=node:node packages/db ./packages/db
COPY --chown=node:node packages/engine ./packages/engine
COPY --chown=node:node packages/snql ./packages/snql
COPY --chown=node:node packages/tunnel-protocol ./packages/tunnel-protocol

USER node

EXPOSE 4000

# Healthcheck sur /health (statique, suffisant en liveness — voir
# apps/backend/src/routes/health/root.ts).
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:${PORT:-4000}/health || exit 1

# `tsx` appelé directement, sans passer par pnpm : corepack le téléchargerait
# à chaque démarrage, et le conteneur ne partirait pas sans accès à npm.
WORKDIR /app/apps/backend
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
