import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
	assertAuthenticated,
	requireUser
} from "../../../domains/auth/require";
import { listDbConnections } from "../../../domains/db-connections/list";
import {
	DbConnectionsErrorResponse,
	ListDbConnectionsResponse
} from "../../../domains/db-connections/schema";

/**
 * Route `/api/db-connections` — liste des `db_connection` du user.
 *
 * Retourne les métadonnées SÛRES (jamais la DSN — la règle 1 sécu
 * garantit qu'il n'y a JAMAIS de DSN en DB de toute façon) : id, name,
 * engine, cli_fingerprint, engine_metadata, timestamps.
 *
 * L'UI dashboard (Bloc 12) utilisera cette route pour surface les
 * connexions actives + rendre un sélecteur de connection.
 */
/**
 * NB : les sous-routes proxifiées `/:id/schema` et `/:id/query` vivent
 * dans `proxy.ts` — chargées automatiquement par `@fastify/autoload` avec
 * le même prefix `/api/db-connections`. Ne PAS les re-register ici, on
 * doublerait les déclarations (`FST_ERR_DUPLICATED_ROUTE`).
 */
export default function dbConnectionsRoute(fastify: FastifyInstance) {
	const instance = fastify.withTypeProvider<ZodTypeProvider>();

	instance.get(
		"",
		{
			preHandler: [requireUser],
			schema: {
				response: {
					200: ListDbConnectionsResponse,
					500: DbConnectionsErrorResponse
				}
			}
		},
		async (request, reply) => {
			assertAuthenticated(request);
			try {
				const rows = await listDbConnections(fastify.db, request.user.id);
				return {
					connections: rows.map((r) => {
						// isOnline : le registry indique-t-il un slot actif pour ce
						// (user, connection) avec un CLI attaché ? La check est O(N)
						// sur `slots.size` — largement acceptable, un user a peu de
						// db_connections. À optimiser via un index inverse si un jour
						// on en a des centaines.
						const slot = fastify.tunnelRegistry.findByConnection(
							request.user.id,
							r.id
						);
						const isOnline = slot?.cli != null;
						return {
							id: r.id,
							name: r.name,
							engine: r.engine,
							cliFingerprint: r.cliFingerprint,
							engineMetadata: r.engineMetadata,
							activeSince: r.activeSince.toISOString(),
							lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
							createdAt: r.createdAt.toISOString(),
							isOnline
						};
					})
				};
			} catch (err) {
				request.log.error({ err }, "list db-connections failed");
				return reply.code(500).send({ message: "Erreur interne" });
			}
		}
	);
}
