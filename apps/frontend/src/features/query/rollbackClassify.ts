/**
 * rollbackClassify — classifie une SnqlRuntimeError en distinguant
 * rollback transactionnel vs erreur classique ([[ADR-023]] E/6, D12).
 *
 * Objectif : distinguer visuellement dans le status bar :
 *  - `rollback_error` — un stmt a échoué et la tx a été annulée en cascade
 *    (deadlock, serialization, contrainte violée en tx explicite). Danger
 *    color + label "Transaction annulée — cause: <msg>".
 *  - `rollback_user` — rollback explicite (savepoint qui roll back, ROLLBACK
 *    manuel). Couleur neutre + label "Rollback".
 *  - `ordinary` — erreur classique hors tx (syntaxe, permissions, table
 *    absente). Rendu existant (rouge, ErrorBlock riche).
 *
 * ─── Sources de vérité ────────────────────────────────────────────────
 *  - Postgres : SQLSTATE class 40 (Transaction Rollback) + 25xxx sous-set
 *    (in_failed_sql_transaction, no_active_sql_transaction).
 *  - Mongo : pas de SQLSTATE, on match sur codes numériques du driver
 *    (WriteConflict=112, TransactionAborted=251, NoSuchTransaction=251) +
 *    fallback sur le label textuel dans le message ("transient-transaction-
 *    error", "WriteConflict"). Cette liste est incomplète — audit driver
 *    obligatoire E/8 ([[ADR-023]] Risque 3).
 *
 * ─── Backend minimalism ──────────────────────────────────────────────
 * ZÉRO extension du shape SnqlRuntimeError / PgErrorInfo côté tunnel. On
 * lit UNIQUEMENT ce qui est déjà exposé : `pgError.code`, `err.message`.
 * Si le driver renvoie un code non-reconnu, on retombe sur `ordinary` —
 * l'utilisateur voit l'erreur brute (safe fallback, pas de miscat).
 */

import type { SnqlRuntimeError } from "./useRunQuery";

export type RollbackKind = "rollback_error" | "rollback_user" | "ordinary";

/** SQLSTATE PG classe 40 (Transaction Rollback) — tous mappés en
 * `rollback_error` : la tx a été annulée à cause d'un problème runtime
 * (deadlock, serialization anomaly, contrainte différée violée). */
const PG_ROLLBACK_ERROR_CODES = new Set<string>([
	"40000", // transaction_rollback (générique)
	"40001", // serialization_failure
	"40002", // transaction_integrity_constraint_violation
	"40003", // statement_completion_unknown
	"40P01" // deadlock_detected
]);

/** SQLSTATE PG classe 25 sous-set — states de tx invalides qui remontent
 * comme un rollback pending côté user (in_failed_sql_transaction = "vous
 * avez déjà planté, la tx est annulée, ROLLBACK avant de continuer"). */
const PG_ROLLBACK_USER_CODES = new Set<string>([
	"25P01", // no_active_sql_transaction (ROLLBACK sans BEGIN)
	"25P02", // in_failed_sql_transaction (tx en état failed, tout est annulé)
	"25P03" // idle_in_transaction_session_timeout
]);

/** Codes numériques Mongo qui remontent un rollback tx multi-doc. Liste
 * v1 non-exhaustive — audit driver mongodb E/8 ([[ADR-023]] Risque 3). */
const MONGO_ROLLBACK_ERROR_CODES = new Set<number>([
	112, // WriteConflict — collision entre 2 tx concurrentes
	251, // TransactionAborted / NoSuchTransaction
	244, // TransactionCommitted
	263 // OperationNotSupportedInTransaction
]);

/** Substrings à matcher dans le message quand aucun code structuré n'est
 * disponible (Mongo sans errorLabels côté remontée tunnel). Fragile mais
 * couvre le cas commun où le driver stringifie l'erreur au CLI. */
const MONGO_ROLLBACK_ERROR_LABELS = [
	"WriteConflict",
	"TransactionAborted",
	"NoSuchTransaction",
	"transient-transaction-error"
];

/**
 * Renvoie la nature du rollback (ou ordinary si l'erreur n'en est pas un).
 * Ne throw jamais, safe fallback sur `ordinary`.
 */
export function classifyRuntimeError(err: SnqlRuntimeError): RollbackKind {
	// Priorité 1 : SQLSTATE PG structuré via pgError.code.
	const pgCode = err.pgError?.code;
	if (pgCode !== undefined) {
		if (PG_ROLLBACK_ERROR_CODES.has(pgCode)) return "rollback_error";
		if (PG_ROLLBACK_USER_CODES.has(pgCode)) return "rollback_user";
		// SQLSTATE classe 40 non-listée → rollback_error par défaut (toute
		// classe 40 = "Transaction Rollback" par spec PG).
		if (pgCode.startsWith("40")) return "rollback_error";
	}

	// Priorité 2 : Mongo — code numérique éventuellement embarqué dans le
	// message ou dans pgError.detail (pas de champ dédié Mongo côté shape
	// actuel — voir E/8 pour enrichissement). On sniff via regex fragile.
	const message = err.message ?? "";
	const detail = err.pgError?.detail ?? "";
	const combined = `${message}\n${detail}`;

	for (const label of MONGO_ROLLBACK_ERROR_LABELS) {
		if (combined.includes(label)) return "rollback_error";
	}

	// Certains messages Mongo commencent par un code numérique "code: 112"
	// ou "MongoError: code 251". Extraction best-effort.
	const codeMatch = combined.match(/(?:code|MongoError)[:\s]+(\d+)/i);
	if (codeMatch?.[1] !== undefined) {
		const n = Number.parseInt(codeMatch[1], 10);
		if (Number.isFinite(n) && MONGO_ROLLBACK_ERROR_CODES.has(n)) {
			return "rollback_error";
		}
	}

	return "ordinary";
}
