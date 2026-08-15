/**
 * `upsertDbConnectionByFingerprint` — pairing idempotent au niveau
 * `(team_id, cli_fingerprint)` (C.21.2, avant : `(user_id, ...)`).
 *
 * ─── Problème résolu (C.6) ────────────────────────────────────────────
 * Avant : chaque `sqlnest connect` INSERT une nouvelle `db_connection`,
 * même si la keypair Ed25519 du CLI était identique. Résultat : un user
 * qui stop/relance son CLI se retrouvait avec un DOUBLON, et le
 * `canvas_state` rattaché à l'ancienne connection devenait invisible.
 *
 * ─── Contrat (C.21.2 : scope team) ────────────────────────────────────
 *   - Si `(team_id, cli_fingerprint)` existe → UPDATE `active_since` /
 *     `last_seen_at`, garde le `name` existant, retourne le même `id`.
 *   - Sinon → INSERT normal. Pré-check du conflit `(team_id, name)` pour
 *     renvoyer une erreur explicite avant que la contrainte unique ne
 *     lève un `unique_violation` cryptique.
 *   - Le `userId` est stocké comme héritage historique (audit : "qui a
 *     pair-é ce CLI") ; l'AUTORISATION passe par team → owner (voir
 *     `requireTeamAccess`, C.21.3).
 *
 * Le `name` saisi par l'user au pairing est utilisé UNIQUEMENT à
 * l'INSERT. Pour un CLI déjà connu (fingerprint match dans cette team),
 * le nouveau name est SILENCIEUSEMENT IGNORÉ (compromis UX : le user
 * peut renommer sa connection via un futur dashboard).
 *
 * ─── Race window ──────────────────────────────────────────────────────
 * Le lookup + INSERT/UPDATE est appelé dans une transaction externe (le
 * caller wrap dans `db.transaction`). Deux pairings concurrents avec la
 * même pubkey pour la même team seraient serialisés par l'index unique
 * `(team_id, cli_fingerprint)` — la course perdante lève
 * `unique_violation` sur l'INSERT et le caller peut retry. Pratique :
 * cas rarissime.
 */

import { schema as dbSchema } from "@sqlnest/db";
import { and, eq, ne, sql } from "drizzle-orm";
import type { DbOrTx } from "../canvas-state/db";
import { computeCliFingerprint } from "../tunnels/pairing/crypto";

export interface UpsertConnectionOptions {
	readonly userId: string;
	/** Team qui possédera la db_connection (V1 = team perso de l'user,
	 *  V2 = choix explicite au pairing). Scope l'INSERT ET le lookup
	 *  idempotent (`(team_id, fingerprint)`). */
	readonly teamId: string;
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
	/**
	 * T4/1 : fingerprint de l'INSTANCE DB (indépendant du CLI). Absent
	 * quand le CLI est legacy (<= T3) ou quand la DSN n'a pas encore été
	 * ouverte au moment de l'upsert. Si présent :
	 *  - stocké sur la db_connection créée/matchée (backfill si absent).
	 *  - v2 : lookup prioritaire `(team, db_fingerprint)` pour switch
	 *    cross-device automatique. V1 : juste backfill.
	 */
	readonly dbFingerprint?: string | null;
	/**
	 * T4/2 : checksum de la structure DB (voir schema.dbConnection). Même
	 * sémantique de backfill que dbFingerprint. Change à chaque migration
	 * DB → invalidation cache + alerte diff côté UI (v2).
	 */
	readonly dbSchemaChecksum?: string | null;
}

export type UpsertConnectionResult =
	| {
			readonly ok: true;
			readonly connectionId: string;
			/** `true` si la connection a été créée, `false` si on a réutilisé une
			 *  connection existante (fingerprint match). */
			readonly wasCreated: boolean;
			/**
			 * T4/3 : cross-device auto — cette db_connection a été créée en
			 * clonant le canvas d'une db_connection existante qui pointait vers
			 * la MÊME instance DB (même `db_fingerprint`, cli_fingerprint
			 * différent). Absent = pas de clone (nouveau pair vierge OU
			 * fingerprint match idempotent).
			 */
			readonly clonedFrom?: {
				readonly connectionId: string;
				readonly name: string;
			};
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

	// 1. Lookup fingerprint existant pour cette team.
	const existing = await tx
		.select({ id: dbSchema.dbConnection.id })
		.from(dbSchema.dbConnection)
		.where(
			and(
				eq(dbSchema.dbConnection.teamId, opts.teamId),
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
		// signale que le tunnel est actif. T4/1 : backfill dbFingerprint
		// s'il est fourni ET absent — les vieilles db_connection gagnent
		// leur fingerprint au premier connect du CLI T4-aware.
		const patch: {
			activeSince: ReturnType<typeof sql>;
			lastSeenAt: ReturnType<typeof sql>;
			dbFingerprint?: string;
			dbSchemaChecksum?: string;
		} = {
			activeSince: sql`now()`,
			lastSeenAt: sql`now()`
		};
		if (opts.dbFingerprint !== undefined && opts.dbFingerprint !== null) {
			patch.dbFingerprint = opts.dbFingerprint;
		}
		if (
			opts.dbSchemaChecksum !== undefined &&
			opts.dbSchemaChecksum !== null
		) {
			patch.dbSchemaChecksum = opts.dbSchemaChecksum;
		}
		await tx
			.update(dbSchema.dbConnection)
			.set(patch)
			.where(eq(dbSchema.dbConnection.id, row.id));
		return { ok: true, connectionId: row.id, wasCreated: false };
	}

	// 2. Pas d'existant : check collision `(team_id, name)` explicitement
	//    avant l'INSERT — renvoie un `name_conflict` propre plutôt qu'un
	//    unique_violation Postgres cryptique.
	const nameCollision = await tx
		.select({ id: dbSchema.dbConnection.id })
		.from(dbSchema.dbConnection)
		.where(
			and(
				eq(dbSchema.dbConnection.teamId, opts.teamId),
				eq(dbSchema.dbConnection.name, opts.name)
			)
		)
		.limit(1);
	if (nameCollision.length > 0) {
		return { ok: false, reason: "name_conflict" };
	}

	// 2.5. T4/3 — cross-device auto : si le CLI envoie un dbFingerprint et
	//     qu'une db_connection existante dans la même team match ce fingerprint
	//     (avec un cli_fingerprint DIFFÉRENT — sinon on serait tombé sur le
	//     match idempotent à l'étape 1), on va cloner son canvas vers la
	//     nouvelle db_connection. UX : Windows retrouve le canvas layouté sur
	//     Mac sans re-tout-remettre-en-place manuellement.
	//
	//     Cohabitation : les 2 db_connections restent distinctes (chacune son
	//     tunnel, son cli_fingerprint). Elles divergent ensuite si l'user
	//     modifie le canvas sur un seul device (pas de sync temps réel v1).
	let sourceForClone:
		| { id: string; name: string; lastPreviewSnapshot: unknown }
		| null = null;
	if (opts.dbFingerprint !== undefined && opts.dbFingerprint !== null) {
		const matches = await tx
			.select({
				id: dbSchema.dbConnection.id,
				name: dbSchema.dbConnection.name,
				lastPreviewSnapshot: dbSchema.dbConnection.lastPreviewSnapshot
			})
			.from(dbSchema.dbConnection)
			.where(
				and(
					eq(dbSchema.dbConnection.teamId, opts.teamId),
					eq(dbSchema.dbConnection.dbFingerprint, opts.dbFingerprint),
					ne(dbSchema.dbConnection.cliFingerprint, fingerprint)
				)
			)
			.orderBy(dbSchema.dbConnection.createdAt)
			.limit(1);
		if (matches.length > 0 && matches[0]) {
			sourceForClone = matches[0];
		}
	}

	// 3. INSERT normal.
	const inserted = await tx
		.insert(dbSchema.dbConnection)
		.values({
			userId: opts.userId,
			teamId: opts.teamId,
			name: opts.name,
			cliFingerprint: fingerprint,
			engine: opts.engine,
			// T4/1 : peut être undefined (Drizzle → col NULL) pour les CLIs
			// legacy ou quand la DSN n'a pas encore été ouverte au pairing.
			...(opts.dbFingerprint !== undefined && opts.dbFingerprint !== null
				? { dbFingerprint: opts.dbFingerprint }
				: {}),
			// T4/2 : idem — nullable, backfill au premier heartbeat qui l'envoie.
			...(opts.dbSchemaChecksum !== undefined &&
			opts.dbSchemaChecksum !== null
				? { dbSchemaChecksum: opts.dbSchemaChecksum }
				: {}),
			// T4/3 : reprend le snapshot de la source pour que la mini-preview
			// canvas s'affiche IMMÉDIATEMENT sur le 2e device — sinon l'user
			// verrait la gallery vide pendant que le CLI Windows introspect.
			...(sourceForClone !== null && sourceForClone.lastPreviewSnapshot !== null
				? { lastPreviewSnapshot: sourceForClone.lastPreviewSnapshot }
				: {})
		})
		.returning({ id: dbSchema.dbConnection.id });

	const row = inserted[0];
	if (!row) {
		throw new Error(
			"upsertDbConnectionByFingerprint: INSERT db_connection n'a rien renvoyé"
		);
	}

	// 4. T4/3 — clone canvas_state depuis la source. INSERT explicite (pas
	//    de UPSERT) : la nouvelle db_connection ne peut pas déjà avoir un
	//    canvas (elle vient d'être créée à l'étape 3). La contrainte unique
	//    `(user_id, connection_id)` n'est jamais violée.
	if (sourceForClone !== null) {
		const canvasRows = await tx
			.select({ payload: dbSchema.canvasState.payload })
			.from(dbSchema.canvasState)
			.where(
				and(
					eq(dbSchema.canvasState.userId, opts.userId),
					eq(dbSchema.canvasState.connectionId, sourceForClone.id)
				)
			)
			.limit(1);
		if (canvasRows.length > 0 && canvasRows[0]) {
			await tx.insert(dbSchema.canvasState).values({
				userId: opts.userId,
				connectionId: row.id,
				payload: canvasRows[0].payload
			});
		}
		return {
			ok: true,
			connectionId: row.id,
			wasCreated: true,
			clonedFrom: { connectionId: sourceForClone.id, name: sourceForClone.name }
		};
	}

	return { ok: true, connectionId: row.id, wasCreated: true };
}
