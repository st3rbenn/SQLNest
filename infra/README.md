# infra — dev locaux + prod Docker

## Prod (self-hosted)

Voir [`docker-compose.prod.yml`](docker-compose.prod.yml) + [`Caddyfile`](Caddyfile). Origin unique `https://dev.sqlnest.io` (le domaine `sqlnest.io` sera la prod définitive plus tard — pour l'instant `dev.sqlnest.io` fait office de prod).

Setup serveur :

```bash
# Base + Docker
sudo apt install -y ca-certificates curl gnupg ufw fail2ban
sudo ufw allow 22,80,443/tcp && sudo ufw enable
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker

# Repo + secrets
sudo mkdir -p /opt/sqlnest /var/backups/sqlnest /var/log/sqlnest
sudo chown $USER:$USER /opt/sqlnest /var/backups/sqlnest /var/log/sqlnest
git clone <repo> /opt/sqlnest && cd /opt/sqlnest
cp infra/.env.prod.example infra/.env.prod && chmod 600 infra/.env.prod
# Éditer infra/.env.prod avec AUTH_SECRET (openssl rand -hex 32) etc.

# Deploy
cp infra/scripts/deploy.sh.example deploy.sh && chmod +x deploy.sh
./deploy.sh
```

Backups quotidiens (cron) :

```bash
crontab -e
# 0 3 * * * /opt/sqlnest/infra/scripts/backup-db.sh >> /var/log/sqlnest/backup.log 2>&1
```

Restore d'un backup :

```bash
gunzip -c /var/backups/sqlnest/sqlnest-YYYYMMDD-HHMMSS.sql.gz | \
    docker exec -i sqlnest-postgres-1 psql -U sqlnest -d sqlnest
```

## Checks post-deploy

```bash
curl https://dev.sqlnest.io/health
# → 200 {"status":"OK", ...}

curl -X POST https://dev.sqlnest.io/api/auth/reset-password \
    -H 'Content-Type: application/json' -d '{}' -i
# → HTTP/2 404 {"error":"email_flows_disabled"}
```

---

# infra — environnements de dev locaux

Bases de données locales pour développer et tester SQLNest (couche connexion et au-delà).

## Démarrer

```bash
docker compose -f infra/docker-compose.yml up -d
```

Ou via les scripts racine : `pnpm db:up` / `pnpm db:down` / `pnpm db:reset`.

| Service  | Port hôte | Identifiants (dev)      | Base           |
| -------- | --------- | ----------------------- | -------------- |
| postgres | **5433**  | `sqlnest` / `sqlnest`   | `sqlnest_demo` |
| mongo    | 27017     | *(noauth)*              | `sqlnest_demo` |

> Identifiants de **développement uniquement**. Ne jamais les réutiliser ailleurs.
> Postgres est exposé sur **5433** (et non 5432) pour cohabiter avec un
> PostgreSQL installé nativement, qui occupe souvent 5432 sur un poste de dev.
>
> Mongo tourne en **replica set single-node** (`rs0`, auth désactivée) — requis
> pour les transactions natives. Clients : ajouter `?directConnection=true` à
> l'URL pour cibler ce membre unique sans découverte de topologie.
> Ex : `mongodb://localhost:27017/sqlnest_demo?directConnection=true`.

## Données de démo

Un schéma `users` / `orders` (avec FK `orders.user_id → users.id` côté Postgres)
est chargé au **premier** démarrage. Il exerce les slices à venir :

- **Slice 6 (introspection)** : types, clés primaires, FK explicites (PG) vs inférence (Mongo).
- **Slice 7 (exécution)** : join réel `users → orders`, identique cross-db.

Les seeds ne se rejouent que sur un volume vide. Pour repartir de zéro :

```bash
pnpm db:reset
```

```bash
pnpm db:up          # démarre PG + Mongo
pnpm db:seed:shop   # génère + charge sqlnest_shop dans les deux moteurs
```

Entités : `categories`, `users`, `addresses`, `products`, `orders`,
`order_items`, `reviews`. Relations FK côté PG ; inférées par heuristique de
nommage (`user_id → users`, `category_id → categories`…) côté Mongo — **les deux
donnent les 7 mêmes relations**. Le générateur est déterministe
(`infra/scripts/seed-shop.mjs`), idempotent (re-lançable), et **ne touche pas**
`sqlnest_demo` (réservée aux tests d'intégration).

### Schéma cible Postgres

Par défaut l'app lit le schéma `public`. Pour viser un autre schéma (ex. une
base distante qui range ses tables ailleurs), ajouter `?schema=` à l'URL —
**schéma** de l'UI (pages Schéma et Requête, Postgres uniquement). L'introspection
et l'exécution (`get <table>`) visent alors ce schéma. Le nom doit être un
identifiant simple (`[a-z_][a-z0-9_]*`). Mongo n'a pas de schéma → champ ignoré.

## Tests d'intégration

Les tests `*.int.test.ts` du package `@sqlnest/engine` sont **sautés** tant que
`SNQL_TEST_PG_URL` n'est pas défini (voir `.env.example`). Avec les bases lancées :

```bash
export SNQL_TEST_PG_URL="postgres://sqlnest:sqlnest@localhost:5433/sqlnest_demo"
pnpm --filter @sqlnest/engine test
```

En PowerShell :

```powershell
$env:SNQL_TEST_PG_URL = "postgres://sqlnest:sqlnest@localhost:5433/sqlnest_demo"
pnpm --filter @sqlnest/engine test
```
