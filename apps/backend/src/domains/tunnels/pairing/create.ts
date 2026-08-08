/**
 * `createPairing` — INSERT tunnel_pairing (état `pending`).
 *
 * Le CLI appelle cette action au démarrage de `sqlnest connect`. Le backend
 * n'a AUCUNE session utilisateur à ce moment (le CLI n'est pas encore lié
 * à un compte). C'est donc une route publique — le rate-limit par IP
 * (Bloc 2, routes) empêche l'énumération.
 *
 * TTL 5 minutes (`PAIRING_TTL_MS`) — assez pour ouvrir un onglet, se
 * connecter à SQLNest si nécessaire, et saisir le code. Assez court pour
 * qu'un code volé (screenshot laissé sur écran) ne soit exploitable que
 * quelques minutes.
 */

import { schema as dbSchema } from "@sqlnest/db";
import type { DbOrTx } from "../db";
import {
	formatPairingCode,
	generatePairingCode,
	PAIRING_CODE_LENGTH
} from "./crypto";

/** Durée de vie d'un pairing pending, en ms. 5 minutes. */
export const PAIRING_TTL_MS = 5 * 60 * 1000;

export interface CreatePairingResult {
	/** Format affichage `XXXX-XXXX` — le CLI l'imprime tel quel. */
	readonly code: string;
	readonly expiresAt: Date;
}

export interface CreatePairingOptions {
	/** Nom de la DSN locale au CLI (C.13). NULL = CLI legacy pré-C.13. */
	cliConnectionName?: string | null;
	/** Team dans laquelle la db_connection sera créée à l'authenticate
	 *  (C.21.4). Renseignée par les routes team-scoped depuis le browser.
	 *  NULL = pairing initié par le flow global public (CLI → POST
	 *  /api/tunnels/pairings sans savoir la team) → l'authenticate
	 *  fallback à la team perso de l'user. */
	teamId?: string | null;
	nowMs?: number;
}

/**
 * INSERT un pairing pending et retourne le code affichable.
 *
 * ─── Retry ─────────────────────────────────────────────────────────────
 * L'alphabet Crockford 8 chars donne 40 bits d'entropie — collision
 * extrêmement improbable (moins de 1e-8 pour 10k codes actifs à un
 * instant t, avec TTL 5 min). Pas de retry sur duplicate key : si ça
 * survient, l'erreur remonte et le CLI retry naturellement. Coder un
 * retry serait de la complexité pour un cas quasi-jamais rencontré.
 */
export async function createPairing(
	db: DbOrTx,
	cliPubkeyEd25519: string,
	cliConnectionName: string | null = null,
	nowMs: number = Date.now(),
	teamId: string | null = null
): Promise<CreatePairingResult> {
	const canonical = generatePairingCode();
	// Sanity — devrait être garanti par `generatePairingCode`, cette
	// double-check protège contre une régression silencieuse (si un jour
	// on refactor le générateur).
	if (canonical.length !== PAIRING_CODE_LENGTH) {
		throw new Error("generatePairingCode: longueur inattendue");
	}
	const expiresAt = new Date(nowMs + PAIRING_TTL_MS);

	await db.insert(dbSchema.tunnelPairing).values({
		code: canonical,
		cliPubkeyEd25519,
		cliConnectionName,
		teamId,
		expiresAt
	});

	return {
		code: formatPairingCode(canonical),
		expiresAt
	};
}
