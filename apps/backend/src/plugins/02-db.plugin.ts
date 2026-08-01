import { createDbClient } from "@sqlnest/db";
import fp from "fastify-plugin";

/**
 * Plugin DB — décorateur `fastify.db` (client Drizzle typé).
 *
 * Consommé par le plugin `03-auth` (drizzleAdapter) et par les futures
 * routes applicatives (canvas persistance…).
 *
 * Le préfixe `02-` garantit un chargement AVANT `03-auth.plugin.ts` et
 * `04-session.plugin.ts` par l'autoload alphabétique de `@fastify/autoload`
 * — plus une déclaration explicite `name: "02-db"` pour que les plugins
 * suivants puissent la référencer via `dependencies: ["02-db"]`.
 *
 * Le pool `postgres.js` sous-jacent est fermé au shutdown via le hook
 * `onClose`, pour éviter les fuites de connexions en tests et lors d'un
 * SIGTERM propre.
 *
 * Note : on lit `process.env.DATABASE_URL` directement (pas `fastify.config`)
 * — cohérent avec le reste du monorepo (drizzle.config.ts, plugin openapi,
 * etc.). La validation est déjà faite par `env.schema.ts` (@fastify/env) et
 * par le loadEnv de `index.ts`.
 */
export default fp(
	async (fastify) => {
		const url = process.env.DATABASE_URL;
		if (!url) {
			// Filet de sécurité : @fastify/env aurait déjà fait crasher le boot,
			// mais on garde une garde runtime au cas où l'ordre changerait.
			throw new Error(
				"DATABASE_URL manquant — vérifie le .env racine et env.schema.ts."
			);
		}

		const client = createDbClient(url);
		fastify.decorate("db", client.db);
		fastify.addHook("onClose", async () => {
			await client.close();
		});
	},
	{
		name: "02-db",
		fastify: "5.x"
	}
);
