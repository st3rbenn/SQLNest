/**
 * `upsertDbConnectionByFingerprint` — pairing idempotent au niveau
 * `(user_id, cli_fingerprint)`.
 *
 * ─── Problème résolu (C.6) ────────────────────────────────────────────
 * Avant : chaque `sqlnest connect` INSERT une nouvelle `db_connection`,
 * même si la keypair Ed25519 du CLI était identique. Résultat : un user
 * qui stop/relance son CLI se retrouvait avec un DOUBLON, et le
 * `canvas_state` rattaché à l'ancienne connection devenait invisible.
 *
 * Nouveau contrat :
 *   - Si `(user_id, cli_fingerprint)` existe → UPDATE `active_since` /
 *     `last_seen_at`, garde le `name` existant, retourne le même `id`.
 *   - Sinon → INSERT normal. Pré-check du conflit `(user_id, name)` pour
 *     renvoyer une erreur explicite avant que la contrainte unique ne
 *     lève un `unique_violation` cryptique.
 *
 * Le `name` saisi par l'user au pairing est utilisé UNIQUEMENT à
 * l'INSERT. Pour un CLI déjà connu, le nouveau name est SILENCIEUSEMENT
 * IGNORÉ (compromis UX : le user peut renommer sa connection via un
 * futur dashboard). Aucun risque de fuite : les 2 unique index
 * (user, name) ET (user, fingerprint) restent cohérents.
 *
 * ─── Race window ──────────────────────────────────────────────────────
 * Le lookup + INSERT/UPDATE est appelé dans une transaction externe (le
 * caller wrap dans `db.transaction`). Deux pairings concurrents avec la
 * MÊME pubkey seraient serialisés par le SELECT ... FOR UPDATE si on
 * l'ajoutait — mais avec l'index unique `(user_id, cli_fingerprint)` en
 * place, la course perdante lève `unique_violation` sur l'INSERT et le
 * caller peut retry. Pratique : cas rarissime (l'user ne lance pas 2
 * `sqlnest connect` en parallèle depuis le même device).
 */

import { schema as dbSchema } from "@sqlnest/db";
import { and, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "../canvas-state/db";
import { computeCliFingerprint } from "../tunnels/pairing/crypto";

export interface UpsertConnectionOptions {
	readonly userId: string;
	/** Pubkey Ed25519 du CLI — reçue en STRING (hex ou base64 selon le
	 *  flow). Utilisée avec `cliConnectionName` pour produire le fingerprint
	 *  effectif via `computeCliFingerprint`. */
	readonly cliPubkey: string;
	/** Nom de la DSN LOCALE au CLI (C.13). Utilisé UNIQUEMENT pour scoper
	 *  le fingerprint effectif — permet à un même install CLI de gérer N
	 *  db_connection distinctes côté serveur. `null` = CLI legacy pré-C.13,
	 *  fingerprint = SHA256(pubkey) seul. */
	readonly cliConnectionName: string | null;
	/** Name saisi par l'user au pairing (côté serveur — apparaît dans la
	 *  gallery). Utilisé UNIQUEMENT si nouvelle connection ; ignoré si un
	 *  fingerprint match. */
	readonly name: string;
	readonly engine: string;
}

export type UpsertConnectionResult =
	| {
			readonly ok: true;
			readonly connectionId: string;
			/** `true` si la connection a été créée, `false` si on a réutilisé une
			 *  connection existante (fingerprint match). */
			readonly wasCreated: boolean;
	  }
	| {
			readonly ok: false;
			readonly reason: "name_conflict";
	  };

export async function upsertDbConnectionByFingerprint(
	tx: DbOrTx,
	opts: UpsertConnectionOptions
): Promise<UpsertConnectionResult> {
	const fingerprint = computeCliFingerprint(
		opts.cliPubkey,
		opts.cliConnectionName
	);

	// 1. Lookup fingerprint existant pour cet user.
	const existing = await tx
		.select({ id: dbSchema.dbConnection.id })
		.from(dbSchema.dbConnection)
		.where(
			and(
				eq(dbSchema.dbConnection.userId, opts.userId),
				eq(dbSchema.dbConnection.cliFingerprint, fingerprint)
			)
		)
		.limit(1);

	if (existing.length > 0) {
		const row = existing[0];
		if (!row) {
			throw new Error(
				"upsertDbConnectionByFingerprint: existing.length > 0 mais row null"
			);
		}
		// UPDATE activeSince + lastSeenAt — le user vient de re-pair, on
		// signale que le tunnel est actif.
		await tx
			.update(dbSchema.dbConnection)
			.set({
				activeSince: sql`now()`,
				lastSeenAt: sql`now()`
			})
			.where(eq(dbSchema.dbConnection.id, row.id));
		return { ok: true, connectionId: row.id, wasCreated: false };
	}

	// 2. Pas d'existant : check collision `(user_id, name)` explicitement
	//    avant l'INSERT — renvoie un `name_conflict` propre plutôt qu'un
	//    unique_violation Postgres cryptique.
	const nameCollision = await tx
		.select({ id: dbSchema.dbConnection.id })
		.from(dbSchema.dbConnection)
		.where(
			and(
				eq(dbSchema.dbConnection.userId, opts.userId),
				eq(dbSchema.dbConnection.name, opts.name)
			)
		)
		.limit(1);
	if (nameCollision.length > 0) {
		return { ok: false, reason: "name_conflict" };
	}

	// 3. INSERT normal.
	const inserted = await tx
		.insert(dbSchema.dbConnection)
		.values({
			userId: opts.userId,
			name: opts.name,
			cliFingerprint: fingerprint,
			engine: opts.engine
		})
		.returning({ id: dbSchema.dbConnection.id });

	const row = inserted[0];
	if (!row) {
		throw new Error(
			"upsertDbConnectionByFingerprint: INSERT db_connection n'a rien renvoyé"
		);
	}
	return { ok: true, connectionId: row.id, wasCreated: true };
}
