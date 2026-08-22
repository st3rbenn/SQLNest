/**
 * `upsertDbConnectionByFingerprint` — pairing idempotent au niveau
 * `(team_id, cli_fingerprint)`.
 *
 * Problème résolu : avant, chaque `sqlnest connect` INSERT une nouvelle
 * `db_connection`, même si la keypair Ed25519 du CLI était identique.
 * Résultat : un user qui stop/relance son CLI se retrouvait avec un
 * DOUBLON, et le `canvas_state` rattaché à l'ancienne connection devenait
 * invisible.
 *
 * Contrat :
 *   - Si `(team_id, cli_fingerprint)` existe → UPDATE `active_since` /
 *     `last_seen_at`, garde le `name` existant, retourne le même `id`.
 *   - Sinon → INSERT normal. Pré-check du conflit `(team_id, name)` pour
 *     renvoyer une erreur explicite avant que la contrainte unique ne
 *     lève un `unique_violation` cryptique.
 *   - Le `userId` est stocké comme héritage historique (audit : "qui a
 *     pair-é ce CLI") ; l'AUTORISATION passe par team → owner (voir
 *     `requireTeamAccess`).
 *
 * Le `name` saisi par l'user au pairing est utilisé UNIQUEMENT à
 * l'INSERT. Pour un CLI déjà connu (fingerprint match dans cette team),
 * le nouveau name est SILENCIEUSEMENT IGNORÉ.
 *
 * Race window : le lookup + INSERT/UPDATE est appelé dans une transaction
 * externe (le caller wrap dans `db.transaction`). Deux pairings concurrents
 * avec la même pubkey pour la même team seraient serialisés par l'index
 * unique `(team_id, cli_fingerprint)` — la course perdante lève
 * `unique_violation` sur l'INSERT et le caller peut retry. Cas rarissime.
 */

import { schema as dbSchema } from "@sqlnest/db";
import { and, eq, ne, sql } from "drizzle-orm";
import type { DbOrTx } from "../canvas-state/db";
import { computeCliFingerprint } from "../tunnels/pairing/crypto";

export interface UpsertConnectionOptions {
	readonly userId: string;
	/** Team qui possédera la db_connection (team perso de l'user par
	 *  défaut, choix explicite au pairing à terme). Scope l'INSERT ET le
	 *  lookup idempotent (`(team_id, fingerprint)`). */
	readonly teamId: string;
	/** Pubkey Ed25519 du CLI — reçue en STRING (hex ou base64 selon le
	 *  flow). Utilisée avec `cliConnectionName` pour produire le fingerprint
	 *  effectif via `computeCliFingerprint`. */
	readonly cliPubkey: string;
	/** Nom de la DSN LOCALE au CLI. Utilisé UNIQUEMENT pour scoper le
	 *  fingerprint effectif — permet à un même install CLI de gérer N
	 *  db_connection distinctes côté serveur. `null` = CLI legacy,
	 *  fingerprint = SHA256(pubkey) seul. */
	readonly cliConnectionName: string | null;
	/** Name saisi par l'user au pairing (côté serveur — apparaît dans la
	 *  gallery). Utilisé UNIQUEMENT si nouvelle connection ; ignoré si un
	 *  fingerprint match. */
	readonly name: string;
	readonly engine: string;
	/**
	 * Fingerprint de l'INSTANCE DB (indépendant du CLI). Absent quand le
	 * CLI est legacy ou quand la DSN n'a pas encore été ouverte au moment
	 * de l'upsert. Si présent :
	 *  - stocké sur la db_connection créée/matchée (backfill si absent).
	 *  - Lookup prioritaire `(team, db_fingerprint)` pour switch
	 *    cross-device automatique.
	 */
	readonly dbFingerprint?: string | null;
	/**
	 * Checksum de la structure DB (voir schema.dbConnection). Même
	 * sémantique de backfill que dbFingerprint. Change à chaque migration
	 * DB → invalidation cache + alerte diff côté UI.
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
			/** `true` si la connection a été réutilisée via match db_fingerprint
			 *  (multi-CLI sur MÊME instance DB) — le CLI courant a un cli_fingerprint
			 *  DIFFÉRENT de celui de la connection primaire, mais on skip la création
			 *  d'une nouvelle row et on partage la même db_connection (chacun a son
			 *  propre tunnel_session avec son cli_fingerprint). Le caller peut créer
			 *  un tunnel_session avec le cli_fingerprint courant sur cette connection. */
			readonly reusedByDbFingerprint?: boolean;
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
		// signale que le tunnel est actif. Backfill dbFingerprint s'il est
		// fourni ET absent — les vieilles db_connection gagnent leur
		// fingerprint au premier connect d'un CLI récent.
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

	// 2. MULTI-CLI REUSE : si le CLI courant a un cli_fingerprint différent
	//    (Windows après Mac) MAIS on trouve une db_connection dans la team
	//    qui pointe vers la MÊME DB → RÉUTILISER cette connection. Un seul
	//    row db_connection par DB logique, plusieurs tunnel_session (1 par
	//    CLI) chacun avec son propre cli_fingerprint. Résout le pb "2×
	//    apollon dans la gallery".
	//
	//    Priorité :
	//      1) `(team, db_fingerprint)` — match INSTANCE stricte (backup/restore
	//         même cluster PG, system_identifier identique).
	//      2) `(team, db_schema_checksum)` — match cross-docker : 2 clusters
	//         PG distincts (system_id différents) mais MÊME dump → même schéma
	//         checksum. Cas typique : Mac docker A + Windows docker B avec le
	//         même seed apollon-db.
	//    Le lookup exclut le cli_fingerprint courant (sinon on match soi-même,
	//    le path idempotent étape 1 traite ce cas).
	const findReuseCandidate = async (): Promise<
		{ id: string } | undefined
	> => {
		if (opts.dbFingerprint !== undefined && opts.dbFingerprint !== null) {
			const rows = await tx
				.select({ id: dbSchema.dbConnection.id })
				.from(dbSchema.dbConnection)
				.where(
					and(
						eq(dbSchema.dbConnection.teamId, opts.teamId),
						eq(dbSchema.dbConnection.dbFingerprint, opts.dbFingerprint),
						ne(dbSchema.dbConnection.cliFingerprint, fingerprint)
					)
				)
				.limit(1);
			if (rows[0]) return rows[0];
		}
		if (
			opts.dbSchemaChecksum !== undefined &&
			opts.dbSchemaChecksum !== null
		) {
			const rows = await tx
				.select({ id: dbSchema.dbConnection.id })
				.from(dbSchema.dbConnection)
				.where(
					and(
						eq(dbSchema.dbConnection.teamId, opts.teamId),
						eq(dbSchema.dbConnection.dbSchemaChecksum, opts.dbSchemaChecksum),
						ne(dbSchema.dbConnection.cliFingerprint, fingerprint)
					)
				)
				.limit(1);
			if (rows[0]) return rows[0];
		}
		return undefined;
	};
	const reuseCandidate = await findReuseCandidate();
	if (reuseCandidate !== undefined) {
		// Bump activity + backfill fp/checksum sur la connection réutilisée
		// (le lookup peut avoir matché via checksum → on rétablit le fp
		// courant si absent OU l'update est no-op idempotent si déjà set).
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
			.where(eq(dbSchema.dbConnection.id, reuseCandidate.id));
		return {
			ok: true,
			connectionId: reuseCandidate.id,
			wasCreated: false,
			reusedByDbFingerprint: true
		};
	}

	// 3. Pas d'existant + pas de match db_fingerprint : check collision
	//    `(team_id, name)` explicitement avant l'INSERT — renvoie un
	//    `name_conflict` propre plutôt qu'un unique_violation Postgres cryptique.
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

	// 4. INSERT normal. Le canvas partagé natif via (user, team,
	//    db_fingerprint) + historique de checksums — la nouvelle
	//    db_connection résout automatiquement au bon canvas au premier
	//    GET/PUT via `resolveCanvasByConnection`. Rien à cloner ici.
	const inserted = await tx
		.insert(dbSchema.dbConnection)
		.values({
			userId: opts.userId,
			teamId: opts.teamId,
			name: opts.name,
			cliFingerprint: fingerprint,
			engine: opts.engine,
			// Peut être undefined (Drizzle → col NULL) pour les CLIs legacy
			// ou quand la DSN n'a pas encore été ouverte au pairing.
			...(opts.dbFingerprint !== undefined && opts.dbFingerprint !== null
				? { dbFingerprint: opts.dbFingerprint }
				: {}),
			// Idem — nullable, backfill au premier heartbeat qui l'envoie.
			...(opts.dbSchemaChecksum !== undefined &&
			opts.dbSchemaChecksum !== null
				? { dbSchemaChecksum: opts.dbSchemaChecksum }
				: {})
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
