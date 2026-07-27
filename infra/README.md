# infra — environnements de dev locaux

Bases de données locales pour développer et tester SQLNest (couche connexion et au-delà).

## Démarrer

```bash
docker compose -f infra/docker-compose.yml up -d
```

Ou via les scripts racine : `pnpm db:up` / `pnpm db:down` / `pnpm db:reset`.

| Service  | Port  | Identifiants (dev)              | Base           |
| -------- | ----- | ------------------------------- | -------------- |
| postgres | 5432  | `sqlnest` / `sqlnest`           | `sqlnest_demo` |
| mongo    | 27017 | `sqlnest` / `sqlnest`           | `sqlnest_demo` |

> Identifiants de **développement uniquement**. Ne jamais les réutiliser ailleurs.

## Données de démo

Un schéma `users` / `orders` (avec FK `orders.user_id → users.id` côté Postgres)
est chargé au **premier** démarrage. Il exerce les slices à venir :

- **Slice 6 (introspection)** : types, clés primaires, FK explicites (PG) vs inférence (Mongo).
- **Slice 7 (exécution)** : join réel `users → orders`, identique cross-db.

Les seeds ne se rejouent que sur un volume vide. Pour repartir de zéro :

```bash
pnpm db:reset
```

## Tests d'intégration

Les tests `*.int.test.ts` du package `@sqlnest/engine` sont **sautés** tant que
`SNQL_TEST_PG_URL` n'est pas défini (voir `.env.example`). Avec les bases lancées :

```bash
export SNQL_TEST_PG_URL="postgres://sqlnest:sqlnest@localhost:5432/sqlnest_demo"
pnpm --filter @sqlnest/engine test
```
