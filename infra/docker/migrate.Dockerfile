# SQLNest DB migrations — one-shot drizzle-kit migrate
# Lancée par docker-compose avant le backend, sort en 0 quand toutes les
# migrations sont appliquées. Le backend a `depends_on: { migrate:
# { condition: service_completed_successfully } }`.
#
# Build depuis la RACINE du monorepo :
#   docker build -f infra/docker/migrate.Dockerfile -t sqlnest/migrate .

FROM node:22-alpine
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json packages/db/

# Note : `drizzle-kit migrate` a besoin de dotenv + drizzle-kit + postgres
# (au runtime pour la connexion). Ils sont TOUS dans packages/db
# (dev + runtime deps).
RUN pnpm install --frozen-lockfile --filter @sqlnest/db... --ignore-scripts

COPY packages/db ./packages/db

ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@sqlnest/db", "db:migrate"]
