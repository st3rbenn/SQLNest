// Augmentation des types Fastify pour SQLNest.
//
// Ce fichier est chargé automatiquement via le glob `include` de
// `tsconfig.app.json` — voir la clé `include` qui référence `src/types` —
// PAS via `typeRoots`, qui attend un layout `@types/pkg/index.d.ts`
// incompatible avec un simple répertoire de fichiers d'augmentation. Il
// enrichit les interfaces globales Fastify avec les décorations posées
// par nos plugins :
//
// - `fastify.db`   -> client Drizzle (posé par le plugin `02-db.plugin.ts`)
// - `fastify.auth` -> instance Better Auth (posée par `03-auth.plugin.ts`)
// - `request.user` -> utilisateur authentifié (posé par le hook preHandler
//                     du plugin `04-session.plugin.ts` qui lit le cookie
//                     de session)
//
// Les imports sont `type-only` pour éviter d'introduire des dépendances
// runtime circulaires entre les plugins et le fichier de types.
//
// NOTE PARSER : ne pas remettre ce header en JSDoc /** ... */ tant que
// des exemples de globs (star-star-slash) apparaissent dedans — le parser
// TS ferme le commentaire au premier `*/`, y compris celui embarqué dans
// `**/*.d.ts`. Les commentaires simples `//` évitent le piège.

import type { createDbClient } from "@sqlnest/db";
import type { Auth } from "better-auth";

declare module "fastify" {
	interface FastifyInstance {
		// Posé par apps/backend/src/plugins/02-db.plugin.ts
		db: ReturnType<typeof createDbClient>["db"];
		// Posé par apps/backend/src/plugins/03-auth.plugin.ts
		// Générique par défaut (`Auth<BetterAuthOptions>`) — les handlers qui
		// veulent l'API typée précisément peuvent la re-typer localement via
		// `typeof fastify.auth`. Suffisant pour l'usage courant :
		// `fastify.auth.handler(req)` et `fastify.auth.api.getSession(...)`.
		auth: Auth;
	}

	interface FastifyRequest {
		// Populé par le hook `preHandler` du plugin 04-session à partir du
		// cookie de session Better Auth. `null` si la requête est anonyme.
		// `name` non-null : Better Auth garantit `name: string` (défaut "")
		// et notre schéma DB (`packages/db/src/schema.ts`) contraint
		// `name notNull default ''`.
		user: {
			id: string;
			email: string;
			emailVerified: boolean;
			name: string;
		} | null;
	}
}
