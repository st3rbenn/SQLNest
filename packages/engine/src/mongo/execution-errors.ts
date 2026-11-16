import { EngineExecutionError } from "../errors";

/**
 * Messages des erreurs d'exécution MongoDB.
 */

/**
 * Message d'erreur d'écriture. Pour un `insert`, `insertMany` est **ordonné**
 * (comme il n'y a pas de transaction sur un Mongo standalone) : un échec en cours
 * de lot laisse les documents précédents insérés — contrairement à Postgres,
 * atomique. On expose donc le compteur partiel pour que l'utilisateur sache
 * combien de documents ont atterri (et ne re-lance pas à l'aveugle en dupliquant).
 */
export function writeErrorMessage(op: string, cause: unknown): string {
	const detail = describeMongoExecutionError(cause);
	if (op === "insert") {
		const inserted = (cause as { result?: { insertedCount?: number } }).result
			?.insertedCount;
		if (typeof inserted === "number" && inserted > 0) {
			return `Écriture MongoDB échouée après ${inserted} document(s) inséré(s) (insert non atomique) — ${detail}`;
		}
	}
	return `Écriture MongoDB échouée — ${detail}`;
}

/**
 * Enrobe une erreur d'enforcement FK transactionnel. Un
 * `TransactionNotSupported` (code 20) = mongod standalone → message guidant
 * (réconciliation doctrine : cascade atomique exige un replica set, comme
 * l'infra de référence SQLNest `mongod --replSet rs0`). Une `EngineExecutionError`
 * (refus FK typé) passe telle quelle.
 */
export function fkTransactionError(collection: string, cause: unknown): Error {
	if (cause instanceof EngineExecutionError) return cause;
	const code = (cause as { code?: unknown } | null)?.code;
	if (code === 20 || code === 263) {
		return new EngineExecutionError(
			`L'enforcement FK sur '${collection}' exige des transactions Mongo — active un replica set (même single-node : \`mongod --replSet rs0\` + rs.initiate(), cf. l'infra de référence SQLNest). ${describeMongoExecutionError(cause)}`,
			{ cause }
		);
	}
	return new EngineExecutionError(
		`Enforcement FK MongoDB échoué sur '${collection}' — ${describeMongoExecutionError(cause)}`,
		{ cause }
	);
}

/**
 * Compose un message utilisable côté UI à partir d'une erreur du driver Mongo.
 * On garde le message natif (ex. `no such collection`, `unknown top-level operator`)
 * et on annote le `codeName` / `code` du driver s'ils sont là.
 */
/**
 * Abort de nettoyage tx : codes attendus (à avaler silencieusement) vs codes
 * réseau/timeout (à logger + enrichir l'erreur finale). Les codes attendus
 * signalent que le serveur a déjà avorté la tx :
 *  - `NoSuchTransaction` (251) : session sans tx active (déjà avortée).
 *  - `TransactionNotFound` : idem, variante d'autres versions driver.
 *  - `WriteConflict` (112) : auto-abort après conflit optimistic locking.
 *  - Label `TransientTransactionError` : label driver générique tx retryable.
 */
export function isExpectedAbortError(cause: unknown): boolean {
	if (!(cause instanceof Error)) return false;
	const props = cause as {
		code?: number | string;
		codeName?: string;
		errorLabels?: readonly string[];
	};
	if (
		props.codeName === "NoSuchTransaction" ||
		props.codeName === "TransactionNotFound" ||
		props.codeName === "WriteConflict"
	) {
		return true;
	}
	if (props.code === 251 || props.code === 112) {
		return true;
	}
	if (
		Array.isArray(props.errorLabels) &&
		props.errorLabels.includes("TransientTransactionError")
	) {
		return true;
	}
	return false;
}

export function describeMongoExecutionError(cause: unknown): string {
	if (!(cause instanceof Error)) {
		return "cause inconnue";
	}
	const props = cause as {
		message: string;
		code?: number | string;
		codeName?: string;
	};
	const parts: string[] = [props.message];
	if (typeof props.codeName === "string" && props.codeName.length > 0) {
		parts.push(props.codeName);
	} else if (props.code !== undefined) {
		parts.push(`code ${props.code}`);
	}
	return parts.join(" — ");
}
