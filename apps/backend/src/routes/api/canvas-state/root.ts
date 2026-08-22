import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import z from "zod/v4";
import {
	assertAuthenticated,
	requireUser
} from "../../../domains/auth/require";
import { countCanvasStates } from "../../../domains/canvas-state/count";
import { delCanvasState } from "../../../domains/canvas-state/del";
import { getCanvasState } from "../../../domains/canvas-state/get";
import { getCanvasChecksumHistory } from "../../../domains/canvas-state/history";
import { putCanvasState } from "../../../domains/canvas-state/put";
import {
	ChecksumHistoryResponse,
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

/**
 * Défense CSRF sur les mutations canvas — check explicite du header
 * `Origin` contre la liste `TRUSTED_ORIGINS`. C'est une ceinture sur la
 * bretelle : le cookie de session Better Auth est déjà `SameSite=Lax`
 * (bloque les fetch cross-origin) ET nos mutations PUT/DELETE avec
 * `Content-Type: application/json` déclenchent un CORS preflight
 * (bloqué par TRUSTED_ORIGINS allowlist). Cette validation en preHandler :
 *   - rend la protection VISIBLE au diff / à l'audit,
 *   - loggée en cas de refus (détection d'anomalies),
 *   - continue de protéger si un jour CORS est mal configuré.
 *
 * `Origin` est un header que le browser attache automatiquement sur les
 * requêtes cross-origin (et sur toutes les mutations same-origin en
 * pratique). Il n'est PAS forgeable depuis du JS browser — le browser
 * l'ignore si le code utilisateur essaie de le set via `fetch({ headers })`.
 *
 * Note : le TRUSTED_ORIGINS lu ici est le MÊME que celui utilisé par
 * Better Auth (env var) et CORS (index.ts). Une seule source de vérité.
 */
function assertTrustedOrigin(
	request: FastifyRequest,
	reply: FastifyReply
): { ok: true } | { ok: false; response: FastifyReply } {
	const origin = request.headers.origin;
	if (typeof origin !== "string" || origin.length === 0) {
		request.log.warn(
			{ path: request.url, method: request.method },
			"canvas-state mutation refusée : header Origin manquant"
		);
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
		request.log.warn(
			{ origin, path: request.url, method: request.method },
			"canvas-state mutation refusée : Origin non autorisé"
		);
		return {
			ok: false,
			response: reply.code(403).send({ message: "Origin non autorisé" })
		};
	}
	return { ok: true };
}

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
 *   GET    /api/canvas-state?connectionId=<uuid>  → 200 { payload, updatedAt } | 404
 *   PUT    /api/canvas-state                       → 200 { updatedAt }
 *                                                    body: { connectionId, payload }
 *   DELETE /api/canvas-state?connectionId=<uuid>  → 204
 *
 * ─── Autorisation ──────────────────────────────────────────────────────
 * Toujours filtrer par `request.user.id` — un user ne peut jamais lire ni
 * modifier le canvas d'un autre user, même en connaissant un connectionId.
 * L'isolation est enforced au niveau de la clause WHERE des queries
 * (getCanvasState, putCanvasState, delCanvasState). La FK cascade sur
 * `db_connection` garantit que si un user révoque sa connection, son
 * canvas orphelin disparait aussi.
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
					request.query.connectionId
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

			const csrfCheck = assertTrustedOrigin(request, reply);
			if (!csrfCheck.ok) return csrfCheck.response;

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

			const csrfCheck = assertTrustedOrigin(request, reply);
			if (!csrfCheck.ok) return csrfCheck.response;

			try {
				await delCanvasState(
					fastify.db,
					request.user.id,
					request.query.connectionId
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

	// ─── GET /canvas-state/checksum-history — audit trail ────────────
	instance.get(
		"/checksum-history",
		{
			preHandler: [requireUser],
			schema: {
				querystring: GetCanvasQuery,
				response: {
					200: ChecksumHistoryResponse,
					404: ErrorResponse
				}
			}
		},
		async (request, reply) => {
			assertAuthenticated(request);
			try {
				const history = await getCanvasChecksumHistory(
					fastify.db,
					request.user.id,
					request.query.connectionId
				);
				if (history === null) {
					return reply.code(404).send({ message: "Canvas introuvable" });
				}
				return history;
			} catch (err) {
				request.log.error({ err }, "canvas-state checksum-history failed");
				throw err;
			}
		}
	);
}
