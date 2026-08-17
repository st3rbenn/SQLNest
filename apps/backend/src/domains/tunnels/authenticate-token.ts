/**
 * `authenticateTunnelWithToken` — flow CI/scripts : le CLI présente un
 * API token (`sn_...`) + sa clé pub Ed25519, on lui ouvre un tunnel sans
 * passer par le device flow interactif.
 *
 * ─── Différences avec `authenticatePairing` (device flow) ──────────────
 *   - Auth : Bearer `sn_...` (api_token) au lieu de signature Ed25519 du
 *     code de pairing.
 *   - Pas de row `tunnel_pairing` — pas de code, pas de consume.
 *   - Le `deviceName` vient du body de la route (pas d'un approve UI).
 *
 * Sécurité :
 *   - Le token clair a 256 bits d'entropie — non-forgeable.
 *   - La pubkey Ed25519 fournie ici sera utilisée pour signer les futures
 *     frames WS (Bloc 7) — le token seul ne suffit pas à parler au
 *     tunnel une fois établi, il faut aussi la privkey correspondante.
 *   - Le token révoqué (`revoked_at != null`) est rejeté par
 *     `authenticateBearer` (WHERE `revoked_at IS NULL`).
 *
 * Effets :
 *   1. Valide le Bearer → userId + bump `last_used_at` (via
 *      `authenticateBearer`).
 *   2. INSERT `db_connection` (échoue en 409 si `(userId, deviceName)`
 *      existe déjà).
 *   3. INSERT `tunnel_session` avec token clair `tn_...`, hash SHA-256.
 *
 * Différence avec device flow : deux transactions distinctes (une pour
 * authenticateBearer, une pour créer conn + session). L'écart temporel
 * est acceptable — un token révoqué juste après l'auth donne un tunnel
 * ephémère qui expirera naturellement, pas une escalade de privilèges.
 */

import { schema as dbSchema } from "@sqlnest/db";
import { authenticateBearer } from "../api-tokens/authenticate-bearer";
import { upsertDbConnectionByFingerprint } from "../db-connections/upsert";
import { createPersonalTeam } from "../teams/create";
import { getDefaultTeamOfUser } from "../teams/get";
import type { DbOrTx } from "./db";
import { TUNNEL_SESSION_TTL_MS } from "./pairing/authenticate";
import {
	computeCliFingerprint,
	generateSessionToken,
	hashSha256Hex
} from "./pairing/crypto";

/** Engine par défaut — aligné sur `authenticatePairing` device flow. */
const DEFAULT_ENGINE = "postgres";

export type AuthenticateTokenFailureReason = "invalid_token" | "name_conflict";

export type AuthenticateTokenResult =
	| {
			readonly ok: true;
			readonly token: string;
			readonly tunnelId: string;
			readonly connectionId: string;
			readonly expiresAt: Date;
	  }
	| {
			readonly ok: false;
			readonly reason: AuthenticateTokenFailureReason;
	  };

export async function authenticateTunnelWithToken(
	db: DbOrTx,
	clearBearerToken: string,
	cliPubkeyEd25519: string,
	deviceName: string,
	cliConnectionName: string | null = null,
	nowMs: number = Date.now(),
	dbFingerprint: string | null = null
): Promise<AuthenticateTokenResult> {
	// Étape 1 — valider le Bearer et bumper last_used_at.
	const auth = await authenticateBearer(db, clearBearerToken, nowMs);
	if (auth == null) return { ok: false, reason: "invalid_token" as const };

	// Étape 2 — upsert db_connection (pairing idempotent C.6/C.13/C.21.2
	// sur fingerprint scopé par team) + INSERT tunnel_session, dans une
	// transaction atomique.
	//
	// C.21.2 : la team qui possédera la db_connection = la team perso de
	// l'user (V1). Lazy-créée si absente (filet cohérent avec le device
	// flow). En C.21.4/V2, un token pourra être scopé à une team précise.
	return db.transaction(async (tx) => {
		let teamId: string;
		const defaultTeam = await getDefaultTeamOfUser(tx, auth.userId);
		if (defaultTeam) {
			teamId = defaultTeam.id;
		} else {
			const created = await createPersonalTeam(tx, auth.userId);
			teamId = created.teamId;
		}

		const upsert = await upsertDbConnectionByFingerprint(tx, {
			userId: auth.userId,
			teamId,
			cliPubkey: cliPubkeyEd25519,
			cliConnectionName,
			name: deviceName,
			engine: DEFAULT_ENGINE,
			// T4/1 Step 6 — voir authenticatePairing pour la sémantique.
			dbFingerprint
		});
		if (!upsert.ok) {
			return { ok: false as const, reason: upsert.reason };
		}
		const conn = { id: upsert.connectionId };

		const token = generateSessionToken();
		const expiresAt = new Date(nowMs + TUNNEL_SESSION_TTL_MS);
		// T4/5 : session porte son propre cli_fingerprint (le CLI qui l'a
		// ouverte). En CI mode, c'est le pubkey du body.
		const cliFingerprintForSession = computeCliFingerprint(
			cliPubkeyEd25519,
			cliConnectionName
		);
		const insertedSession = await tx
			.insert(dbSchema.tunnelSession)
			.values({
				connectionId: conn.id,
				hash: hashSha256Hex(token),
				expiresAt,
				cliFingerprint: cliFingerprintForSession
			})
			.returning({ id: dbSchema.tunnelSession.id });

		const sess = insertedSession[0];
		if (!sess) {
			throw new Error(
				"authenticateTunnelWithToken: INSERT tunnel_session n'a rien renvoyé"
			);
		}

		return {
			ok: true as const,
			token,
			tunnelId: sess.id,
			connectionId: conn.id,
			expiresAt
		};
	});
}
