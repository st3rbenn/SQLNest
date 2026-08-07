import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
	assertAuthenticated,
	requireUser
} from "../../../domains/auth/require";
import { listDbConnections } from "../../../domains/db-connections/list";
import { putPreviewSnapshot } from "../../../domains/db-connections/preview-snapshot";
import {
	ConnectionIdParams,
	DbConnectionsErrorResponse,
	ListDbConnectionsResponse,
	PutPreviewSnapshotBody,
	PutPreviewSnapshotResponse
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
							isOnline,
							// `lastPreviewSnapshot` est en `jsonb` non-typé côté DB —
							// on le cast à travers le schema Zod côté response, qui
							// re-valide sa forme. Un snapshot mal formé (corruption
							// improbable, migration cassée) est renvoyé comme null
							// à la place de faire 500 la route entière.
							lastPreviewSnapshot:
								(r.lastPreviewSnapshot as unknown as ListDbConnectionsResponse["_output"]["connections"][number]["lastPreviewSnapshot"]) ??
								null
						};
					})
				};
			} catch (err) {
				request.log.error({ err }, "list db-connections failed");
				return reply.code(500).send({ message: "Erreur interne" });
			}
		}
	);

	// ─── PUT /:id/preview-snapshot (C.15) ────────────────────────────
	// Enregistre le snapshot précalculé du dernier rendu de preview.
	// Piggyback typique : appelé par le frontend au save du canvas
	// (débounced avec `useCanvasSync`). Body cappé à 200 nodes / 500
	// edges / 50 frames via Zod pour éviter les payloads abusifs.
	instance.put(
		"/:id/preview-snapshot",
		{
			preHandler: [requireUser],
			// bodyLimit intentionnellement bas — un snapshot légitime dépasse
			// rarement les 50 KB. On tolère jusqu'à 200 KB pour laisser de la
			// marge sur un très gros schéma (les caps Zod protègent d'abord).
			bodyLimit: 200_000,
			schema: {
				params: ConnectionIdParams,
				body: PutPreviewSnapshotBody,
				response: {
					200: PutPreviewSnapshotResponse,
					404: DbConnectionsErrorResponse,
					500: DbConnectionsErrorResponse
				}
			}
		},
		async (request, reply) => {
			assertAuthenticated(request);
			try {
				const result = await putPreviewSnapshot(
					fastify.db,
					request.user.id,
					request.params.id,
					request.body.snapshot
				);
				if (!result.ok) {
					return reply.code(404).send({ message: "Connection introuvable" });
				}
				return { ok: true as const };
			} catch (err) {
				request.log.error({ err }, "put preview snapshot failed");
				return reply.code(500).send({ message: "Erreur interne" });
			}
		}
	);
}
