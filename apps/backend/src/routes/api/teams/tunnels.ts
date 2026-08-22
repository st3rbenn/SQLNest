/**
 * Routes team-scoped `/api/teams/:slug/tunnels/*` :
 *
 *   POST /api/teams/:slug/tunnels/pairings
 *   GET  /api/teams/:slug/tunnels/pairings/:code/status
 *   POST /api/teams/:slug/tunnels/pairings/:code/approve
 *
 * Miroir de `routes/api/tunnels/root.ts` pour les routes qui touchent
 * un pairing lié à une team précise. Le device flow
 * `POST /api/tunnels/authenticate` (le CLI présente sa signature) reste
 * PUBLIC + non team-scoped : le CLI ne connaît pas la team (choisie côté
 * user au moment du /approve). `tunnel_pairing.team_id` transporte le
 * choix du `/approve` vers le `/authenticate`. */

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import z from "zod/v4";
import {
	assertTeamAccess,
	requireTeamAccess
} from "../../../domains/teams/require-team-access";
import { TeamSlugParams } from "../../../domains/teams/schema";
import { approvePairing } from "../../../domains/tunnels/pairing/approve";
import { createPairing } from "../../../domains/tunnels/pairing/create";
import { normalizePairingCode } from "../../../domains/tunnels/pairing/crypto";
import {
	ApprovePairingBody,
	ApprovePairingResponse,
	CreatePairingBody,
	CreatePairingResponse,
	StatusPairingResponse,
	TunnelsErrorResponse
} from "../../../domains/tunnels/pairing/schema";
import { getPairingStatus } from "../../../domains/tunnels/pairing/status";

// Params combinés — slug + code
const SlugAndCodeParams = TeamSlugParams.extend({
	code: z.string()
});
z.globalRegistry.add(SlugAndCodeParams, { id: "TeamSlugAndPairingCodeParams" });
type SlugAndCodeParamsT = z.infer<typeof SlugAndCodeParams>;

function isTrustedOrigin(origin: string | undefined): boolean {
	if (typeof origin !== "string" || origin.length === 0) return false;
	const trustedRaw = process.env.TRUSTED_ORIGINS ?? "http://localhost:3000";
	return trustedRaw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.includes(origin);
}

const RATE_LIMIT_CREATE = { max: 10, timeWindow: "1 minute" } as const;
const RATE_LIMIT_STATUS = { max: 30, timeWindow: "1 minute" } as const;

export default function teamsTunnelsRoute(fastify: FastifyInstance) {
	const instance = fastify.withTypeProvider<ZodTypeProvider>();

	// ─── POST /:slug/tunnels/pairings ────────────────────────────────
	// L'user connecté (auth cookie) initie un pairing DEPUIS l'UI d'une
	// team précise. Différent du POST /api/tunnels/pairings (appelé
	// par le CLI, publique) — ici on est côté browser, on know the team.
	instance.post(
		"/:slug/tunnels/pairings",
		{
			preHandler: [requireTeamAccess],
			config: { rateLimit: RATE_LIMIT_CREATE },
			schema: {
				params: TeamSlugParams,
				body: CreatePairingBody,
				response: {
					200: CreatePairingResponse,
					500: TunnelsErrorResponse
				}
			}
		},
		async (request, reply) => {
			assertTeamAccess(request);
			try {
				// Le pairing est créé DÉJÀ scopé à la team courante — à
				// l'authenticate, `authenticatePairing` lira `pairing.teamId`
				// pour créer la db_connection dans la bonne team, sans avoir
				// besoin de fallback.
				const result = await createPairing(
					fastify.db,
					request.body.cliPubkeyEd25519,
					request.body.cliConnectionName ?? null,
					Date.now(),
					request.team.id,
					request.body.dbFingerprint ?? null,
					request.body.dbSchemaChecksum ?? null
				);
				return {
					code: result.code,
					expiresAt: result.expiresAt.toISOString(),
					pollUrl: `/api/teams/${request.team.slug}/tunnels/pairings/${result.code}/status`
				};
			} catch (err) {
				request.log.error({ err }, "team pairing create failed");
				return reply.code(500).send({ message: "Erreur interne" });
			}
		}
	);

	// ─── GET /:slug/tunnels/pairings/:code/status ────────────────────
	instance.get(
		"/:slug/tunnels/pairings/:code/status",
		{
			preHandler: [requireTeamAccess],
			config: { rateLimit: RATE_LIMIT_STATUS },
			schema: {
				params: SlugAndCodeParams,
				response: {
					200: StatusPairingResponse,
					400: TunnelsErrorResponse
				}
			}
		},
		async (request, reply) => {
			assertTeamAccess(request);
			const params = request.params as SlugAndCodeParamsT;
			const canonical = normalizePairingCode(params.code);
			if (canonical == null) {
				return reply.code(400).send({ message: "Code invalide" });
			}
			return getPairingStatus(fastify.db, canonical, {
				userId: request.user.id,
				teamId: request.team.id
			});
		}
	);

	// ─── POST /:slug/tunnels/pairings/:code/approve ──────────────────
	instance.post(
		"/:slug/tunnels/pairings/:code/approve",
		{
			preHandler: [requireTeamAccess],
			schema: {
				params: SlugAndCodeParams,
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
			assertTeamAccess(request);

			if (!isTrustedOrigin(request.headers.origin)) {
				request.log.warn(
					{ origin: request.headers.origin, path: request.url },
					"team tunnels /approve refusé — Origin non autorisé"
				);
				return reply.code(403).send({ message: "Origin non autorisé" });
			}

			const params = request.params as SlugAndCodeParamsT;
			const canonical = normalizePairingCode(params.code);
			if (canonical == null) {
				return reply.code(400).send({ message: "Code invalide" });
			}

			// `teamIdOverride` = request.team.id — enforce que la
			// db_connection sera créée dans CETTE team, même si le pairing
			// avait un team_id différent (rare : l'user a scanné un code
			// depuis une autre team). Garantit l'invariant URL ↔ team.
			const result = await approvePairing(
				fastify.db,
				canonical,
				request.user.id,
				request.body.deviceName,
				undefined,
				request.team.id
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
}
