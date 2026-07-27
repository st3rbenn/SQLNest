/**
 * Erreurs typées de la couche connexion. Chaque erreur porte un `code` stable
 * (destiné à l'UI / aux logs) et n'expose **jamais** de secret dans son message.
 */

export type EngineErrorCode =
	| "unknown_engine"
	| "invalid_config"
	| "connection_failed"
	| "connection_closed";

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
