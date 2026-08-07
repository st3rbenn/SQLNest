import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createApiToken } from "../../../domains/api-tokens/create";
import { listApiTokens } from "../../../domains/api-tokens/list";
import { revokeApiToken } from "../../../domains/api-tokens/revoke";
import {
	ApiTokenIdParams,
	ApiTokensErrorResponse,
	CreateApiTokenBody,
	CreateApiTokenResponse,
	ListApiTokensResponse
} from "../../../domains/api-tokens/schema";
import {
	assertAuthenticated,
	requireUser
} from "../../../domains/auth/require";

/**
 * Routes `/api/api-tokens/*` — gestion des API tokens (mode CI/scripts).
 *
 * Endpoints (tous auth cookie required) :
 *   POST   /api/api-tokens                → 200 { id, name, prefix, token, createdAt }
 *   GET    /api/api-tokens                → 200 { tokens: [...] }
 *   DELETE /api/api-tokens/:id            → 204
 *
 * ─── Contrat : le token clair ne repasse jamais par le backend ────────
 * `POST` renvoie le clair `sn_...` UNE fois. La liste `GET` ne retourne
 * jamais le clair (seul le `prefix` "sn_1a2b" pour l'identification
 * visuelle). Un DELETE est un soft-revoke — le token reste en DB pour
 * l'audit, mais toute tentative d'auth avec ce clair échoue (WHERE
 * `revoked_at IS NULL`).
 *
 * ─── CSRF ──────────────────────────────────────────────────────────────
 * `POST` et `DELETE` vérifient l'header `Origin` — même pattern que
 * canvas-state et tunnels/approve. Le cookie est SameSite=Lax ; la
 * vérification Origin rend la protection auditable.
 *
 * ─── Rate limit ────────────────────────────────────────────────────────
 * Aucun override — le rate-limit global 100/min/IP du plugin
 * `01-rate-limit` suffit. Ce sont des actions authentifiées et
 * délibérées, pas des routes brute-forceables.
 */

function isTrustedOrigin(origin: string | undefined): boolean {
	if (typeof origin !== "string" || origin.length === 0) return false;
	const trustedRaw = process.env.TRUSTED_ORIGINS ?? "http://localhost:3000";
	const trusted = trustedRaw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return trusted.includes(origin);
}

export default function apiTokensRoute(fastify: FastifyInstance) {
	const instance = fastify.withTypeProvider<ZodTypeProvider>();

	// ─── POST / ───────────────────────────────────────────────────────
	instance.post(
		"",
		{
			preHandler: [requireUser],
			schema: {
				body: CreateApiTokenBody,
				response: {
					200: CreateApiTokenResponse,
					400: ApiTokensErrorResponse,
					403: ApiTokensErrorResponse,
					409: ApiTokensErrorResponse,
					500: ApiTokensErrorResponse
				}
			}
		},
		async (request, reply) => {
			assertAuthenticated(request);

			if (!isTrustedOrigin(request.headers.origin)) {
				request.log.warn(
					{ origin: request.headers.origin, path: request.url },
					"api-token create refusé — Origin non autorisé"
				);
				return reply.code(403).send({ message: "Origin non autorisé" });
			}

			try {
				const created = await createApiToken(
					fastify.db,
					request.user.id,
					request.body.name
				);
				return {
					id: created.id,
					name: created.name,
					prefix: created.prefix,
					token: created.token,
					createdAt: created.createdAt.toISOString()
				};
			} catch (err) {
				// pg 23505 = unique_violation. L'index partiel
				// `api_token_user_name_active_unique` interdit deux tokens
				// ACTIFS du même nom pour un même user.
				if (
					err != null &&
					typeof err === "object" &&
					"code" in err &&
					(err as { code: unknown }).code === "23505"
				) {
					return reply.code(409).send({
						message: `Un token nommé "${request.body.name}" existe déjà. Choisis un autre nom ou révoque l'existant.`
					});
				}
				request.log.error({ err }, "api-token create failed");
				return reply
					.code(500)
					.send({ message: "Erreur interne à la création du token" });
			}
		}
	);

	// ─── GET / ────────────────────────────────────────────────────────
	instance.get(
		"",
		{
			preHandler: [requireUser],
			schema: {
				response: {
					200: ListApiTokensResponse
				}
			}
		},
		async (request) => {
			assertAuthenticated(request);
			const rows = await listApiTokens(fastify.db, request.user.id);
			return {
				tokens: rows.map((r) => ({
					id: r.id,
					name: r.name,
					prefix: r.prefix,
					createdAt: r.createdAt.toISOString(),
					lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
					revokedAt: r.revokedAt?.toISOString() ?? null
				}))
			};
		}
	);

	// ─── DELETE /:id ──────────────────────────────────────────────────
	instance.delete(
		"/:id",
		{
			preHandler: [requireUser],
			schema: {
				params: ApiTokenIdParams,
				response: {
					403: ApiTokensErrorResponse,
					404: ApiTokensErrorResponse
				}
			}
		},
		async (request, reply) => {
			assertAuthenticated(request);

			if (!isTrustedOrigin(request.headers.origin)) {
				request.log.warn(
					{ origin: request.headers.origin, path: request.url },
					"api-token delete refusé — Origin non autorisé"
				);
				return reply.code(403).send({ message: "Origin non autorisé" });
			}

			const ok = await revokeApiToken(
				fastify.db,
				request.user.id,
				request.params.id
			);
			if (!ok) {
				return reply.code(404).send({ message: "Token introuvable" });
			}
			// 204 No Content — soft-revoke réussi.
			return reply.code(204).send();
		}
	);
}
