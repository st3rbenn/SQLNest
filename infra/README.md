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
| mongo    | 27017     | `sqlnest` / `sqlnest`   | `sqlnest_demo` |

> Identifiants de **développement uniquement**. Ne jamais les réutiliser ailleurs.
> Postgres est exposé sur **5433** (et non 5432) pour cohabiter avec un
> PostgreSQL installé nativement, qui occupe souvent 5432 sur un poste de dev.

## Données de démo

Un schéma `users` / `orders` (avec FK `orders.user_id → users.id` côté Postgres)
est chargé au **premier** démarrage. Il exerce les slices à venir :

- **Slice 6 (introspection)** : types, clés primaires, FK explicites (PG) vs inférence (Mongo).
- **Slice 7 (exécution)** : join réel `users → orders`, identique cross-db.

Les seeds ne se rejouent que sur un volume vide. Pour repartir de zéro :

```bash
pnpm db:reset
```

## Dataset e-commerce (`sqlnest_shop`) — pour tester en vrai

Un dataset **e-commerce riche** (~8 300 lignes, 7 entités) chargé **à l'identique**
dans Postgres ET MongoDB, pour comparer la sortie SNQL cross-db sur des vraies
données. C'est cette base que **l'app** (`/schema`, `/query`) affiche par défaut.

```bash
pnpm db:up          # démarre PG + Mongo
pnpm db:seed:shop   # génère + charge sqlnest_shop dans les deux moteurs
```

Entités : `categories`, `users`, `addresses`, `products`, `orders`,
`order_items`, `reviews`. Relations FK côté PG ; inférées par heuristique de
nommage (`user_id → users`, `category_id → categories`…) côté Mongo — **les deux
donnent les 7 mêmes relations**. Le générateur est déterministe
(`infra/scripts/seed-shop.mjs`), idempotent (re-lançable), et **ne touche pas**
`sqlnest_demo` (réservée aux tests d'intégration). Surcharger la cible de l'app :
`SCHEMA_PG_URL` / `SCHEMA_MONGO_URL`.

### Schéma cible Postgres

Par défaut l'app lit le schéma `public`. Pour viser un autre schéma (ex. une
base distante qui range ses tables ailleurs), ajouter `?schema=` à l'URL —
`SCHEMA_PG_URL="postgres://…/db?schema=rnacen"` — ou le saisir dans le champ
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
