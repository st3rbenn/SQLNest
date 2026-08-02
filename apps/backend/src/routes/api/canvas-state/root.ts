import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import z from "zod/v4";
import {
	assertAuthenticated,
	requireUser
} from "../../../domains/auth/require";
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
import { jsonDepthExceeds } from "../../../utils/json-depth";

/** Marker interne — un throw d'une erreur avec ce flag est rethrow depuis
 * la transaction pour aborter le upsert, puis intercepté par le handler
 * pour renvoyer un 403 quota. */
class QuotaExceededError extends Error {
	constructor() {
		super("QUOTA_EXCEEDED");
		this.name = "QuotaExceededError";
	}
}

const CANVAS_BODY_LIMIT_BYTES = 100_000;
const MAX_CANVAS_PER_USER = 50;
const MAX_JSON_DEPTH = 10;

// Schéma minimal pour les réponses d'erreur — nommé pour l'OpenAPI et
// réutilisé pour les 404 (`GET /api/canvas-state?signature=X` inconnu).
const ErrorResponse = z.object({ message: z.string() });
z.globalRegistry.add(ErrorResponse, { id: "CanvasErrorResponse" });

/**
 * Routes `/api/canvas-state` — persistance serveur du canvas utilisateur.
 *
 * Monté sous `/api/*` pour matcher la convention `/api/auth/*` et faciliter
 * le routing reverse-proxy production (une seule règle `/api → backend`).
 *
 * ─── Endpoints (tous protégés par requireUser → 401 si non authentifié) ─
 *   GET    /api/canvas-state?signature=<sig>   → 200 { payload, updatedAt } | 404
 *   PUT    /api/canvas-state                    → 200 { updatedAt }
 *                                                 body: { signature, payload }
 *   DELETE /api/canvas-state?signature=<sig>   → 204
 *
 * ─── Autorisation ──────────────────────────────────────────────────────
 * Toujours filtrer par `request.user.id` — un user ne peut jamais lire ni
 * modifier le canvas d'un autre user, même en connaissant sa signature.
 * L'isolation est enforced au niveau de la clause WHERE des queries
 * (getCanvasState, putCanvasState, delCanvasState).
 *
 * ─── Body opaque ───────────────────────────────────────────────────────
 * Le contenu de `payload` n'est PAS validé structurellement (z.record(
 * z.unknown()) — cf. schema.ts). Le stockage `jsonb` Postgres gère le
 * parsing, et le frontend est propriétaire du format. Sécurité assurée
 * par le `bodyLimit` (100 KB).
 */
export default function canvasStateRoute(fastify: FastifyInstance) {
	const instance = fastify.withTypeProvider<ZodTypeProvider>();

	// ─── GET /canvas-state ────────────────────────────────────────────
	instance.get(
		"",
		{
			preHandler: [requireUser],
			schema: {
				querystring: GetCanvasQuery,
				response: {
					200: GetCanvasResponse,
					404: ErrorResponse
				}
			}
		},
		async (request, reply) => {
			assertAuthenticated(request);
			try {
				const row = await getCanvasState(
					fastify.db,
					request.user.id,
					request.query.signature
				);
				if (row == null) {
					return reply.code(404).send({ message: "Canvas introuvable" });
				}
				return row;
			} catch (err) {
				request.log.error({ err }, "canvas-state GET failed");
				throw err;
			}
		}
	);

	// ─── PUT /canvas-state ────────────────────────────────────────────
	instance.put(
		"",
		{
			preHandler: [requireUser],
			// bodyLimit posé au niveau de la route SEULEMENT — les autres routes
			// gardent le default global (par défaut ~1 MB côté Fastify).
			bodyLimit: CANVAS_BODY_LIMIT_BYTES,
			schema: {
				body: PutCanvasBody,
				response: {
					200: PutCanvasResponse,
					400: ErrorResponse,
					403: ErrorResponse,
					500: ErrorResponse
				}
			}
		},
		async (request, reply) => {
			assertAuthenticated(request);

			if (jsonDepthExceeds(request.body.payload, MAX_JSON_DEPTH)) {
				return reply.code(400).send({ message: "Payload JSON trop profond" });
			}

			// Transaction avec advisory lock sérialisé sur userId : sans ça,
			// deux PUT concurrents avec des signatures différentes peuvent
			// tous deux voir count=49 et tous deux insérer → user dépasse le
			// quota (TOCTOU). `pg_advisory_xact_lock` prend un lock exclusif
			// dans la transaction ; deux PUT en parallèle pour le même user
			// s'exécutent en série sur ce chemin critique.
			const userId = request.user.id;
			try {
				return await fastify.db.transaction(async (tx) => {
					await tx.execute(
						sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`
					);

					const existing = await getCanvasState(
						tx,
						userId,
						request.body.signature
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
						request.body.signature,
						request.body.payload
					);
				});
			} catch (err) {
				if (err instanceof QuotaExceededError) {
					return reply.code(403).send({
						message: `Quota atteint (${MAX_CANVAS_PER_USER} canvas max)`
					});
				}
				request.log.error({ err }, "canvas-state PUT failed");
				return reply
					.code(500)
					.send({ message: "Erreur interne lors de la sauvegarde" });
			}
		}
	);

	// ─── DELETE /canvas-state ─────────────────────────────────────────
	instance.delete(
		"",
		{
			preHandler: [requireUser],
			schema: {
				querystring: GetCanvasQuery
				// Pas de schema.response pour 204 : Fastify ne sérialise rien
				// (spec HTTP interdit tout body sur 204).
			}
		},
		async (request, reply) => {
			assertAuthenticated(request);
			try {
				await delCanvasState(
					fastify.db,
					request.user.id,
					request.query.signature
				);
				// 204 No Content — idempotent : renvoie 204 que la row ait
				// existé ou pas (le state final est identique).
				return reply.code(204).send();
			} catch (err) {
				request.log.error({ err }, "canvas-state DELETE failed");
				return reply
					.code(500)
					.send({ message: "Erreur interne lors de la suppression" });
			}
		}
	);
}
