import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Client Drizzle + connexion `postgres.js`.
 *
 * `createDbClient(url)` retourne un tuple `{ db, close }` — `db` est
 * l'instance Drizzle typée (schéma injecté), `close` ferme le pool sous-
 * jacent (utile pour les tests et pour graceful shutdown côté Fastify).
 *
 * Pas de singleton global : le backend Fastify décide où/quand instancier
 * (typiquement une seule fois via un plugin `@fastify/plugin`, ou par
 * request-scope selon la stratégie). Ça évite l'anti-pattern « connexion
 * ouverte à l'import de module ».
 */
export interface DbClient {
	readonly db: ReturnType<typeof drizzle<typeof schema>>;
	readonly close: () => Promise<void>;
}

export interface CreateDbClientOptions {
	/** Taille max du pool de connexions. Défaut 10 — Postgres tolère plus,
	 * mais 10 suffit pour un backend Fastify single-instance. */
	readonly max?: number;
	/** Timeout d'inactivité en secondes avant recyclage d'une connexion. */
	readonly idleTimeout?: number;
}

export function createDbClient(
	url: string,
	options: CreateDbClientOptions = {}
): DbClient {
	const client = postgres(url, {
		max: options.max ?? 10,
		idle_timeout: options.idleTimeout ?? 20,
		// Les erreurs de connexion doivent être bruyantes — pas de silent fail.
		onnotice: () => undefined
	});
	const db = drizzle(client, { schema });
	return {
		db,
		close: () => client.end()
	};
}
