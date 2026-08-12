/**
 * Erreurs typées de la couche connexion. Chaque erreur porte un `code` stable
 * (destiné à l'UI / aux logs) et n'expose **jamais** de secret dans son message.
 */

import type { SerializedSpan } from "@sqlnest/snql";

/**
 * Détail structuré d'une erreur Postgres remontée au client. Contrairement à la
 * string composite historique (`message — SQLSTATE — hint`), garde chaque champ
 * séparé pour que le frontend puisse rendre un panneau riche : chip cliquable
 * `$N = value`, jump-to-span dans l'éditeur, hint dans un tooltip, etc.
 *
 * `params` + `paramSpans` (Phase 3a) sont **alignés positionnellement** avec
 * les placeholders `$1..$N` du SQL généré. Le frontend résout `$N` du message
 * pg vers la valeur bindée + le token source SNQL à souligner.
 */
export interface PgErrorInfo {
	readonly message: string;
	readonly code?: string;
	/** Byte offset 1-indexé dans le SQL généré (à joindre au sourceMap en 3b). */
	readonly position?: number;
	readonly detail?: string;
	readonly hint?: string;
	readonly column?: string;
	readonly table?: string;
	readonly constraint?: string;
	readonly params?: readonly unknown[];
	readonly paramSpans?: readonly (SerializedSpan | undefined)[];
	/**
	 * Phase 3c : spans source des rows d'un INSERT batch. Utilisé pour cibler
	 * la row fautive sur unique/FK violation (SQLSTATE class 23xxx). `undefined`
	 * ou vide pour toute erreur non-INSERT.
	 */
	readonly rowSpans?: readonly (SerializedSpan | undefined)[];
	/**
	 * Phase 3b-lite : spans par nom d'ident (col/table/alias). Résout
	 * `column "X" does not exist` → toutes les occurrences de X dans le
	 * source SNQL. Vide si aucun ident collecté.
	 */
	readonly identSpans?: Readonly<Record<string, readonly SerializedSpan[]>>;
}

export type EngineErrorCode =
	| "unknown_engine"
	| "invalid_config"
	| "connection_failed"
	| "connection_closed"
	| "execution_failed"
	| "introspection_failed";

export class EngineError extends Error {
	readonly code: EngineErrorCode;

	constructor(
		message: string,
		code: EngineErrorCode,
		options?: { readonly cause?: unknown }
	) {
		super(
			message,
			options?.cause === undefined ? undefined : { cause: options.cause }
		);
		this.name = "EngineError";
		this.code = code;
	}
}

/** Moteur demandé absent du registre. */
export class UnknownEngineError extends EngineError {
	constructor(engine: string) {
		super(`Moteur inconnu '${engine}'`, "unknown_engine");
		this.name = "UnknownEngineError";
	}
}

/** Configuration de connexion invalide (URL malformée, champ manquant…). */
export class EngineConfigError extends EngineError {
	constructor(message: string, options?: { readonly cause?: unknown }) {
		super(message, "invalid_config", options);
		this.name = "EngineConfigError";
	}
}

/** Échec d'établissement / de vérification d'une connexion (réseau, auth…). */
export class EngineConnectionError extends EngineError {
	constructor(message: string, options?: { readonly cause?: unknown }) {
		super(message, "connection_failed", options);
		this.name = "EngineConnectionError";
	}
}

/** Opération tentée sur une connexion déjà fermée. */
export class ConnectionClosedError extends EngineError {
	constructor(engine: string) {
		super(`Connexion ${engine} déjà fermée`, "connection_closed");
		this.name = "ConnectionClosedError";
	}
}

/** Échec de l'exécution d'une requête native (SQL invalide, contrainte…). */
export class EngineExecutionError extends EngineError {
	/**
	 * Détail structuré de l'erreur Postgres (Phase 3a). `undefined` quand la
	 * cause n'est pas une erreur `pg` (ex. adapter mis-configuré, cause non-Error).
	 */
	readonly pgError?: PgErrorInfo;

	constructor(
		message: string,
		options?: { readonly cause?: unknown; readonly pgError?: PgErrorInfo }
	) {
		super(message, "execution_failed", options);
		this.name = "EngineExecutionError";
		if (options?.pgError !== undefined) {
			this.pgError = options.pgError;
		}
	}
}

/** Échec de la lecture du schéma (introspection). */
export class EngineIntrospectionError extends EngineError {
	constructor(message: string, options?: { readonly cause?: unknown }) {
		super(message, "introspection_failed", options);
		this.name = "EngineIntrospectionError";
	}
}
