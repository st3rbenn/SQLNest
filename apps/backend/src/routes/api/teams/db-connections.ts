/**
 * Routes team-scoped `/api/teams/:slug/db-connections/*` (C.21.3).
 *
 *   GET  /api/teams/:slug/db-connections
 *   PUT  /api/teams/:slug/db-connections/:id/preview-snapshot
 *
 * Les endpoints proxifiés (schema + query) vivent dans
 * `db-connections-proxy.ts` — même préfixe autoload.
 */

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import z from "zod/v4";
import { listDbConnectionsByTeam } from "../../../domains/db-connections/list-by-team";
import { putPreviewSnapshotByTeam } from "../../../domains/db-connections/preview-snapshot-by-team";
import {
	DbConnectionsErrorResponse,
	ListDbConnectionsResponse,
	PutPreviewSnapshotBody,
	PutPreviewSnapshotResponse
} from "../../../domains/db-connections/schema";
import {
	assertTeamAccess,
	requireTeamAccess
} from "../../../domains/teams/require-team-access";
import { TeamSlugParams } from "../../../domains/teams/schema";

const SlugAndConnectionParams = TeamSlugParams.extend({
	id: z.string().uuid()
});
z.globalRegistry.add(SlugAndConnectionParams, {
	id: "TeamSlugAndConnectionIdParams"
});

export default function teamsDbConnectionsRoute(fastify: FastifyInstance) {
	const instance = fastify.withTypeProvider<ZodTypeProvider>();

	// ─── GET /:slug/db-connections ────────────────────────────────────
	instance.get(
		"/:slug/db-connections",
		{
			preHandler: [requireTeamAccess],
			schema: {
				params: TeamSlugParams,
				response: {
					200: ListDbConnectionsResponse,
					404: DbConnectionsErrorResponse,
					500: DbConnectionsErrorResponse
				}
			}
		},
		async (request, reply) => {
			assertTeamAccess(request);
			try {
				const rows = await listDbConnectionsByTeam(fastify.db, request.team.id);
				return {
					connections: rows.map((r) => {
						// isOnline via le registry — même logique que la route legacy
						// mais en interrogeant par le user owner de la team (V1) car
						// le registry indexe encore par userId. En V2 quand plusieurs
						// users partagent une team, on scopera par teamId.
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
							lastPreviewSnapshot:
								(r.lastPreviewSnapshot as unknown as ListDbConnectionsResponse["_output"]["connections"][number]["lastPreviewSnapshot"]) ??
								null
						};
					})
				};
			} catch (err) {
				request.log.error(
					{ err, teamId: request.team.id },
					"team-scoped list db-connections failed"
				);
				return reply.code(500).send({ message: "Erreur interne" });
			}
		}
	);

	// ─── PUT /:slug/db-connections/:id/preview-snapshot ───────────────
	instance.put(
		"/:slug/db-connections/:id/preview-snapshot",
		{
			preHandler: [requireTeamAccess],
			bodyLimit: 200_000,
			schema: {
				params: SlugAndConnectionParams,
				body: PutPreviewSnapshotBody,
				response: {
					200: PutPreviewSnapshotResponse,
					404: DbConnectionsErrorResponse,
					500: DbConnectionsErrorResponse
				}
			}
		},
		async (request, reply) => {
			assertTeamAccess(request);
			try {
				const result = await putPreviewSnapshotByTeam(
					fastify.db,
					request.team.id,
					// biome-ignore lint/suspicious/noExplicitAny: Zod-narrowed but TS types are lost through extend
					(request.params as any).id,
					request.body.snapshot
				);
				if (!result.ok) {
					return reply.code(404).send({ message: "Connection introuvable" });
				}
				return { ok: true as const };
			} catch (err) {
				request.log.error(
					{ err, teamId: request.team.id },
					"team-scoped put preview snapshot failed"
				);
				return reply.code(500).send({ message: "Erreur interne" });
			}
		}
	);
}

// Fastify autoload ne charge que le `default export`. Le second fichier
// `db-connections-proxy.ts` sera chargé séparément.
