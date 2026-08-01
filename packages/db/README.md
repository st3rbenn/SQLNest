# @sqlnest/db

Client Postgres + schéma Drizzle pour la couche applicative de SQLNest (auth, canvas persistance, etc.).

Isolé de la base de démo introspectée par l'engine (`sqlnest_demo` sur port 5433) — voir `infra/docker-compose.yml`, service `postgres-app` sur port hôte 5434.

## Setup local

```bash
# 1. Copier .env.example en .env et vérifier DATABASE_URL
cp .env.example .env

# 2. Démarrer le Postgres applicatif (idempotent si déjà up)
pnpm db:up

# 3. Installer les deps du monorepo (dont drizzle-orm, drizzle-kit, postgres)
pnpm install

# 4. Générer la première migration depuis src/schema.ts
pnpm app:db:generate

# 5. Appliquer la migration à la DB
pnpm app:db:migrate
```

Vérifier via Drizzle Studio :

```bash
pnpm app:db:studio
```

## Utilisation depuis le backend

```ts
import { createDbClient, schema } from "@sqlnest/db";

const { db, close } = createDbClient(process.env.DATABASE_URL);
// Requêtes typées :
const rows = await db.select().from(schema.canvasState).limit(10);
await close(); // graceful shutdown
```

## État actuel — Phase 1

- Table `canvas_state` (snapshot du canvas par user × schéma) — `user_id` sans FK à ce stade.
- Tables `users` / `sessions` / `accounts` / `verifications` : ajoutées en **Phase 2** par Better Auth (schéma géré par son adapter Drizzle).
- FK `canvas_state.user_id → users.id` : ajoutée en Phase 2 quand la table `users` sera en place.

Voir `06 - Roadmap/Auth & persistence server plan.md` dans le vault Obsidian pour le plan complet.
