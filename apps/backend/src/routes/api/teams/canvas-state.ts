/**
 * Routes team-scoped `/api/teams/:slug/canvas-state` (C.21.3).
 *
 *   GET    /api/teams/:slug/canvas-state?connectionId=<uuid>
 *   PUT    /api/teams/:slug/canvas-state          (body: connectionId+payload)
 *   DELETE /api/teams/:slug/canvas-state?connectionId=<uuid>
 *
 * Décision (C.21.2/3) : `canvas_state` reste scopé par `user_id` — chaque
 * user a SON canvas pour une connection donnée. L'AUTORISATION passe
 * par team : on vérifie que la connection appartient à la team, puis on
 * lit/écrit le canvas de l'user. En V2 (plusieurs users dans une team),
 * chaque éditeur garde son propre layout (positions perso, non partagées).
 */

import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import z from "zod/v4";
import { countCanvasStates } from "../../../domains/canvas-state/count";
import { delCanvasState } from "../../../domains/canvas-state/del";
import { getCanvasState } from "../../../domains/canvas-state/get";
import { putCanvasState } from "../../../domains/canvas-state/put";
import {
	GetCanvasQuery,
	GetCanvasResponse,
	PutCanvasBody,
	PutCanvasResponse
} from "../../../domains/canvas-state/schema";
import { assertConnectionInTeam } from "../../../domains/db-connections/get-in-team";
import {
	assertTeamAccess,
	requireTeamAccess
} from "../../../domains/teams/require-team-access";
import { TeamSlugParams } from "../../../domains/teams/schema";
import { jsonDepthExceeds } from "../../../utils/json-depth";

class QuotaExceededError extends Error {
	constructor() {
		super("QUOTA_EXCEEDED");
		this.name = "QuotaExceededError";
	}
}

const CANVAS_BODY_LIMIT_BYTES = 100_000;
const MAX_CANVAS_PER_USER = 50;
const MAX_JSON_DEPTH = 10;

const ErrorResponse = z.object({ message: z.string() });
z.globalRegistry.add(ErrorResponse, { id: "TeamsCanvasErrorResponse" });

function assertTrustedOrigin(
	request: FastifyRequest,
	reply: FastifyReply
): { ok: true } | { ok: false; response: FastifyReply } {
	const origin = request.headers.origin;
	if (typeof origin !== "string" || origin.length === 0) {
		return {
			ok: false,
			response: reply.code(403).send({ message: "Origin manquant" })
		};
	}
	const trustedRaw = process.env.TRUSTED_ORIGINS ?? "http://localhost:3000";
	const trusted = trustedRaw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (!trusted.includes(origin)) {
		return {
			ok: false,
			response: reply.code(403).send({ message: "Origin non autorisé" })
		};
	}
	return { ok: true };
}

export default function teamsCanvasStateRoute(fastify: FastifyInstance) {
	const instance = fastify.withTypeProvider<ZodTypeProvider>();

	// ─── GET /:slug/canvas-state ─────────────────────────────────────
	instance.get(
		"/:slug/canvas-state",
		{
			preHandler: [requireTeamAccess],
			schema: {
				params: TeamSlugParams,
				querystring: GetCanvasQuery,
				response: {
					200: GetCanvasResponse,
					404: ErrorResponse
				}
			}
		},
		async (request, reply) => {
			assertTeamAccess(request);
			const okConn = await assertConnectionInTeam(
				fastify.db,
				request.team.id,
				request.query.connectionId
			);
			if (!okConn)
				return reply.code(404).send({ message: "Canvas introuvable" });
			const row = await getCanvasState(
				fastify.db,
				request.user.id,
				request.query.connectionId
			);
			if (row == null) {
				return reply.code(404).send({ message: "Canvas introuvable" });
			}
			return row;
		}
	);

	// ─── PUT /:slug/canvas-state ─────────────────────────────────────
	instance.put(
		"/:slug/canvas-state",
		{
			preHandler: [requireTeamAccess],
			bodyLimit: CANVAS_BODY_LIMIT_BYTES,
			schema: {
				params: TeamSlugParams,
				body: PutCanvasBody,
				response: {
					200: PutCanvasResponse,
					400: ErrorResponse,
					403: ErrorResponse,
					404: ErrorResponse,
					500: ErrorResponse
				}
			}
		},
		async (request, reply) => {
			assertTeamAccess(request);
			const csrfCheck = assertTrustedOrigin(request, reply);
			if (!csrfCheck.ok) return csrfCheck.response;

			const okConn = await assertConnectionInTeam(
				fastify.db,
				request.team.id,
				request.body.connectionId
			);
			if (!okConn)
				return reply.code(404).send({ message: "Connection introuvable" });

			if (jsonDepthExceeds(request.body.payload, MAX_JSON_DEPTH)) {
				return reply.code(400).send({ message: "Payload JSON trop profond" });
			}

			const userId = request.user.id;
			try {
				return await fastify.db.transaction(async (tx) => {
					await tx.execute(
						sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`
					);
					const existing = await getCanvasState(
						tx,
						userId,
						request.body.connectionId
					);
					if (existing == null) {
						const total = await countCanvasStates(tx, userId);
						if (total >= MAX_CANVAS_PER_USER) {
							throw new QuotaExceededError();
						}
					}
					return await putCanvasState(
						tx,
						userId,
						request.body.connectionId,
						request.body.payload
					);
				});
			} catch (err) {
				if (err instanceof QuotaExceededError) {
					return reply.code(403).send({
						message: `Quota atteint (${MAX_CANVAS_PER_USER} canvas max)`
					});
				}
				request.log.error({ err }, "teams canvas-state PUT failed");
				return reply
					.code(500)
					.send({ message: "Erreur interne lors de la sauvegarde" });
			}
		}
	);

	// ─── DELETE /:slug/canvas-state ──────────────────────────────────
	instance.delete(
		"/:slug/canvas-state",
		{
			preHandler: [requireTeamAccess],
			schema: {
				params: TeamSlugParams,
				querystring: GetCanvasQuery
			}
		},
		async (request, reply) => {
			assertTeamAccess(request);
			const csrfCheck = assertTrustedOrigin(request, reply);
			if (!csrfCheck.ok) return csrfCheck.response;

			// Pas de check strict connection-in-team ici : le delete est
			// idempotent, et le WHERE user_id + connection_id sur canvas_state
			// suffit à isoler. L'attaquant qui devinerait un connectionId
			// d'une autre team ne pourrait pas supprimer un canvas puisqu'il
			// n'a pas le user_id.

			try {
				await delCanvasState(
					fastify.db,
					request.user.id,
					request.query.connectionId
				);
				return reply.code(204).send();
			} catch (err) {
				request.log.error({ err }, "teams canvas-state DELETE failed");
				return reply
					.code(500)
					.send({ message: "Erreur interne lors de la suppression" });
			}
		}
	);
}
