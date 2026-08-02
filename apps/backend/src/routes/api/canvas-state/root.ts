import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import z from "zod/v4";
import {
	assertAuthenticated,
	requireUser
} from "../../../domains/auth/require";
import { delCanvasState } from "../../../domains/canvas-state/del";
import { getCanvasState } from "../../../domains/canvas-state/get";
import { putCanvasState } from "../../../domains/canvas-state/put";
import {
	GetCanvasQuery,
	GetCanvasResponse,
	PutCanvasBody,
	PutCanvasResponse
} from "../../../domains/canvas-state/schema";

// Limite volontaire à 100 KB (~200 tables avec positions/sizes/frames) — assez
// pour tous les cas réalistes du canvas actuel, mais protège contre un push
// pathologique. Fastify renvoie 413 (Payload Too Large) au-delà.
const CANVAS_BODY_LIMIT_BYTES = 100_000;

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
					500: ErrorResponse
				}
			}
		},
		async (request, reply) => {
			assertAuthenticated(request);
			try {
				return await putCanvasState(
					fastify.db,
					request.user.id,
					request.body.signature,
					request.body.payload
				);
			} catch (err) {
				request.log.error({ err }, "canvas-state PUT failed");
				// Renvoie 500 explicitement via reply.send — évite qu'un throw
				// non-catché renvoie du HTML default Fastify.
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
