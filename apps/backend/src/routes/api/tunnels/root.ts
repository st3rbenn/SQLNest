import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { parseBearerHeader } from "../../../domains/api-tokens/crypto";
import {
	assertAuthenticated,
	requireUser
} from "../../../domains/auth/require";
import { authenticateTunnelWithToken } from "../../../domains/tunnels/authenticate-token";
import { heartbeatTunnel } from "../../../domains/tunnels/heartbeat";
import { approvePairing } from "../../../domains/tunnels/pairing/approve";
import { authenticatePairing } from "../../../domains/tunnels/pairing/authenticate";
import { createPairing } from "../../../domains/tunnels/pairing/create";
import { normalizePairingCode } from "../../../domains/tunnels/pairing/crypto";
import {
	ApprovePairingBody,
	ApprovePairingResponse,
	AuthenticateBody,
	AuthenticateResponse,
	AuthenticateTokenBody,
	AuthenticateTokenResponse,
	CreatePairingBody,
	CreatePairingResponse,
	HeartbeatBody,
	HeartbeatResponse,
	PairingCodeParams,
	StatusPairingResponse,
	TunnelsErrorResponse
} from "../../../domains/tunnels/pairing/schema";
import { getPairingStatus } from "../../../domains/tunnels/pairing/status";

/**
 * Routes `/api/tunnels/*` — device flow CLI ↔ compte user + finalisation
 * (device flow OU mode CI Bearer).
 *
 * ─── Endpoints ─────────────────────────────────────────────────────────
 *   POST /api/tunnels/pairings                       (public, RL 10/min/IP)
 *     → { code, expiresAt, pollUrl }
 *
 *   GET  /api/tunnels/pairings/:code/status          (public, RL 30/min/IP)
 *     → { status, deviceName }
 *
 *   POST /api/tunnels/pairings/:code/approve         (auth cookie + CSRF)
 *     → { ok: true }
 *
 *   POST /api/tunnels/authenticate                    (public, RL 10/min IP+code)
 *     → { token, tunnelId, connectionId, expiresAt }
 *
 *   POST /api/tunnels/authenticate-token              (Bearer sn_..., RL 10/min/IP)
 *     → { token, tunnelId, connectionId, expiresAt }
 *
 * ─── Rate-limiting ────────────────────────────────────────────────────
 * - `POST /pairings` : cap 10/min par IP — protège contre l'énumération
 *   massive de codes (un attaquant qui inonderait la DB de pairings).
 * - `GET /pairings/:code/status` : cap 30/min par IP — plus large parce
 *   que le CLI poll toutes les 2s (30/min = 1 par 2s).
 * - `POST /pairings/:code/approve` : global 100/min (rate-limit global
 *   suffit — le user est déjà authentifié, c'est une action volontaire).
 * - `POST /authenticate` : cap 10/min par (IP, code) — protège contre
 *   le brute-force de signature. Combiné avec l'entropie 40 bits du
 *   code + TTL 5 min, ça rend l'attaque non-viable.
 * - `POST /authenticate-token` : cap 10/min par IP. Le token clair a
 *   256 bits d'entropie — brute-force impossible en pratique ; le
 *   rate-limit protège contre le DoS de la DB.
 *
 * ─── CSRF sur /approve ────────────────────────────────────────────────
 * Même pattern que canvas-state : check du header `Origin` contre
 * `TRUSTED_ORIGINS`. Le cookie de session est SameSite=Lax ; la
 * validation Origin est une ceinture sur bretelle rendue explicite.
 */

// ─── CSRF helper (dupliqué de canvas-state — même pattern, factorisable
// plus tard si un 3e domain en a besoin). ────────────────────────────
function isTrustedOrigin(origin: string | undefined): boolean {
	if (typeof origin !== "string" || origin.length === 0) return false;
	const trustedRaw = process.env.TRUSTED_ORIGINS ?? "http://localhost:3000";
	const trusted = trustedRaw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return trusted.includes(origin);
}

const RATE_LIMIT_CREATE = {
	max: 10,
	timeWindow: "1 minute"
} as const;

const RATE_LIMIT_STATUS = {
	max: 30,
	timeWindow: "1 minute"
} as const;

/** Rate-limit strict sur /authenticate — key = IP + code (body). Requiert
 * `hook: "preHandler"` pour lire le body parsé. Cap 10/min :
 * un CLI honnête réussit en 1 essai ; un attaquant qui force la sig
 * est bloqué au 11e. */
const RATE_LIMIT_AUTHENTICATE = {
	max: 10,
	timeWindow: "1 minute",
	hook: "preHandler" as const,
	keyGenerator: (request: FastifyRequest) => {
		const body = request.body as { code?: unknown } | undefined;
		const code = body && typeof body.code === "string" ? body.code : "anon";
		return `tunnel-auth:${request.ip}:${code}`;
	}
};

/** Rate-limit sur /authenticate-token (mode CI) — cap 10/min/IP. Le
 * token clair (256 bits) rend le brute-force impossible ; le cap
 * limite l'impact d'un DoS sur la DB (chaque req fait 2 INSERTs). */
const RATE_LIMIT_AUTHENTICATE_TOKEN = {
	max: 10,
	timeWindow: "1 minute"
} as const;

/** Rate-limit sur /heartbeat — cap 60/min/IP. Le CLI l'appelle au boot
 * + périodiquement (fréquence à déf côté CLI, ordre de la minute). Le
 * token clair (256 bits) rend le brute-force impossible ; ce cap protège
 * juste contre un CLI mal configuré qui spammerait. */
const RATE_LIMIT_HEARTBEAT = {
	max: 60,
	timeWindow: "1 minute"
} as const;

/**
 * NB : les routes WS (`/:sessionId/cli`, `/by-connection/:id/browser`)
 * vivent dans `ws.ts` — chargées automatiquement par `@fastify/autoload`
 * avec le même prefix `/api/tunnels`. Ne PAS les re-register ici
 * (`FST_ERR_DUPLICATED_ROUTE`).
 */
export default function tunnelsRoute(fastify: FastifyInstance) {
	const instance = fastify.withTypeProvider<ZodTypeProvider>();

	// ─── POST /pairings ───────────────────────────────────────────────
	instance.post(
		"/pairings",
		{
			config: { rateLimit: RATE_LIMIT_CREATE },
			schema: {
				body: CreatePairingBody,
				response: {
					200: CreatePairingResponse,
					500: TunnelsErrorResponse
				}
			}
		},
		async (request, reply) => {
			try {
				const result = await createPairing(
					fastify.db,
					request.body.cliPubkeyEd25519,
					request.body.cliConnectionName ?? null
				);
				return {
					code: result.code,
					expiresAt: result.expiresAt.toISOString(),
					// URL relative — le CLI compose avec le baseURL qu'il a en config.
					// `result.code` inclut déjà le dash `XXXX-XXXX`, on l'utilise
					// directement dans l'URL (les routes /status/authenticate normalisent).
					pollUrl: `/api/tunnels/pairings/${result.code}/status`
				};
			} catch (err) {
				request.log.error({ err }, "createPairing failed");
				return reply
					.code(500)
					.send({ message: "Erreur interne à la création du pairing" });
			}
		}
	);

	// ─── GET /pairings/:code/status ───────────────────────────────────
	instance.get(
		"/pairings/:code/status",
		{
			config: { rateLimit: RATE_LIMIT_STATUS },
			schema: {
				params: PairingCodeParams,
				response: {
					200: StatusPairingResponse,
					400: TunnelsErrorResponse
				}
			}
		},
		async (request, reply) => {
			const canonical = normalizePairingCode(request.params.code);
			if (canonical == null) {
				// Code mal formé — ne dévoile pas s'il existerait.
				return reply.code(400).send({ message: "Code invalide" });
			}
			// Passe le userId SEULEMENT si l'user est authentifié — le CLI
			// polling ne l'est pas et doit continuer à recevoir un status
			// sans `existingConnection` (privacy : ne révèle pas au CLI de
			// qui il est reconnu). L'UI /connect (cookie session) reçoit
			// `existingConnection` pour adapter l'affichage.
			const userId = request.user?.id;
			return getPairingStatus(
				fastify.db,
				canonical,
				userId !== undefined ? { userId } : {}
			);
		}
	);

	// ─── POST /pairings/:code/approve ─────────────────────────────────
	instance.post(
		"/pairings/:code/approve",
		{
			preHandler: [requireUser],
			schema: {
				params: PairingCodeParams,
				body: ApprovePairingBody,
				response: {
					200: ApprovePairingResponse,
					400: TunnelsErrorResponse,
					403: TunnelsErrorResponse,
					404: TunnelsErrorResponse,
					409: TunnelsErrorResponse,
					410: TunnelsErrorResponse
				}
			}
		},
		async (request, reply) => {
			assertAuthenticated(request);

			if (!isTrustedOrigin(request.headers.origin)) {
				request.log.warn(
					{ origin: request.headers.origin, path: request.url },
					"tunnels /approve refusé — Origin non autorisé"
				);
				return reply.code(403).send({ message: "Origin non autorisé" });
			}

			const canonical = normalizePairingCode(request.params.code);
			if (canonical == null) {
				return reply.code(400).send({ message: "Code invalide" });
			}

			const result = await approvePairing(
				fastify.db,
				canonical,
				request.user.id,
				request.body.deviceName
			);

			if (result.ok) return { ok: true as const };

			switch (result.reason) {
				case "not_found":
					return reply.code(404).send({ message: "Code introuvable" });
				case "expired":
					return reply.code(410).send({ message: "Code expiré" });
				case "already_used":
					return reply.code(410).send({ message: "Code déjà utilisé" });
				case "name_conflict":
					return reply.code(409).send({
						message:
							"Une connexion avec ce nom existe déjà. Choisis un autre nom ou révoque la connexion existante."
					});
				case "name_required":
					return reply.code(400).send({
						message:
							"Le nom de la connexion est requis pour un nouveau pairing."
					});
			}
		}
	);

	// ─── POST /authenticate ───────────────────────────────────────────
	instance.post(
		"/authenticate",
		{
			config: { rateLimit: RATE_LIMIT_AUTHENTICATE },
			schema: {
				body: AuthenticateBody,
				response: {
					200: AuthenticateResponse,
					400: TunnelsErrorResponse,
					401: TunnelsErrorResponse,
					403: TunnelsErrorResponse,
					410: TunnelsErrorResponse
				}
			}
		},
		async (request, reply) => {
			const canonical = normalizePairingCode(request.body.code);
			if (canonical == null) {
				return reply.code(400).send({ message: "Code invalide" });
			}

			const result = await authenticatePairing(
				fastify.db,
				canonical,
				request.body.signature,
				undefined,
				request.body.dbFingerprint ?? null
			);

			if (result.ok) {
				return {
					token: result.token,
					tunnelId: result.tunnelId,
					connectionId: result.connectionId,
					expiresAt: result.expiresAt.toISOString(),
					...(result.clonedFrom !== undefined
						? { clonedFrom: result.clonedFrom }
						: {})
				};
			}

			switch (result.reason) {
				case "not_found":
					// Message générique volontaire — ne distingue pas un code
					// invalide d'un signature invalide pour prévenir
					// l'énumération.
					return reply.code(401).send({ message: "Authentification refusée" });
				case "signature_invalid":
					return reply.code(401).send({ message: "Authentification refusée" });
				case "expired":
					return reply.code(410).send({ message: "Code expiré" });
				case "already_used":
					return reply.code(410).send({ message: "Code déjà utilisé" });
				case "not_approved":
					// Le CLI voit cette erreur si le user n'a pas encore autorisé.
					// Peut arriver si le CLI ne poll pas /status entre chaque
					// tentative.
					return reply.code(403).send({
						message: "Le pairing n'a pas encore été autorisé par l'utilisateur"
					});
			}
		}
	);

	// ─── POST /authenticate-token (mode CI Bearer) ────────────────────
	instance.post(
		"/authenticate-token",
		{
			config: { rateLimit: RATE_LIMIT_AUTHENTICATE_TOKEN },
			schema: {
				body: AuthenticateTokenBody,
				response: {
					200: AuthenticateTokenResponse,
					400: TunnelsErrorResponse,
					401: TunnelsErrorResponse,
					409: TunnelsErrorResponse
				}
			}
		},
		async (request, reply) => {
			const clearBearer = parseBearerHeader(
				request.headers.authorization ?? undefined
			);
			if (clearBearer == null) {
				return reply.code(401).send({
					message: "Header `Authorization: Bearer sn_...` requis"
				});
			}

			const result = await authenticateTunnelWithToken(
				fastify.db,
				clearBearer,
				request.body.cliPubkeyEd25519,
				request.body.deviceName,
				request.body.cliConnectionName ?? null,
				undefined,
				request.body.dbFingerprint ?? null
			);

			if (result.ok) {
				return {
					token: result.token,
					tunnelId: result.tunnelId,
					connectionId: result.connectionId,
					expiresAt: result.expiresAt.toISOString(),
					...(result.clonedFrom !== undefined
						? { clonedFrom: result.clonedFrom }
						: {})
				};
			}

			switch (result.reason) {
				case "invalid_token":
					// Message générique — ne distingue pas un token inconnu d'un
					// token révoqué (defense-in-depth anti-énumération).
					return reply.code(401).send({ message: "Authentification refusée" });
				case "name_conflict":
					return reply.code(409).send({
						message:
							"Une connexion avec ce nom existe déjà. Choisis un autre nom ou révoque la connexion existante."
					});
			}
		}
	);

	// ─── POST /heartbeat (backfill fingerprint / checksum sur resumed) ─
	// T4/1.5 : résout le trou où findResumableTunnel skip authenticate.
	// Le CLI POST ici au boot du serve loop (et périodiquement) avec le
	// token du tunnel + fingerprint DB + checksum schéma.
	instance.post(
		"/heartbeat",
		{
			config: { rateLimit: RATE_LIMIT_HEARTBEAT },
			schema: {
				body: HeartbeatBody,
				response: {
					200: HeartbeatResponse,
					401: TunnelsErrorResponse
				}
			}
		},
		async (request, reply) => {
			// Le heartbeat utilise un token de session tunnel (`tn_...`), pas
			// un API token (`sn_...`) — parseBearerHeader accepte uniquement
			// le préfixe sn_, on parse à la main ici. Format attendu :
			// `Authorization: Bearer tn_<hex>`.
			const authHeader = request.headers.authorization;
			const clearBearer =
				typeof authHeader === "string" &&
				authHeader.toLowerCase().startsWith("bearer ")
					? authHeader.slice("bearer ".length).trim()
					: null;
			if (clearBearer === null || !clearBearer.startsWith("tn_")) {
				return reply.code(401).send({
					message: "Header `Authorization: Bearer tn_...` requis"
				});
			}
			const result = await heartbeatTunnel(
				fastify.db,
				clearBearer,
				request.body.dbFingerprint ?? null,
				request.body.dbSchemaChecksum ?? null
			);
			if (result.ok) {
				return { ok: true as const, connectionId: result.connectionId };
			}
			// invalid_token — même message générique que les autres routes.
			return reply.code(401).send({ message: "Authentification refusée" });
		}
	);
}
