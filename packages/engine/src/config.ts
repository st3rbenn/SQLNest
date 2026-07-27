import { EngineConfigError } from "./errors";

/**
 * Configuration de connexion Postgres **résolue** : tous les champs remplis
 * (defaults appliqués). Le `password` est un secret — ne jamais le logger tel
 * quel ; passer par {@link describePostgresConfig} pour un affichage sûr.
 */
export interface PostgresConnectionConfig {
	readonly engine: "postgres";
	readonly host: string;
	readonly port: number;
	readonly database: string;
	readonly user: string;
	readonly password: string;
	readonly ssl: boolean;
	readonly poolMax: number;
	readonly connectionTimeoutMillis: number;
}

/** Entrée par URL : `postgres://user:pass@host:port/db?sslmode=require`. */
export interface PostgresUrlInput {
	readonly url: string;
	readonly ssl?: boolean;
	readonly poolMax?: number;
	readonly connectionTimeoutMillis?: number;
}

/** Entrée par champs discrets. */
export interface PostgresFieldsInput {
	readonly host: string;
	readonly port?: number;
	readonly database: string;
	readonly user: string;
	readonly password?: string;
	readonly ssl?: boolean;
	readonly poolMax?: number;
	readonly connectionTimeoutMillis?: number;
}

export type PostgresConfigInput = PostgresUrlInput | PostgresFieldsInput;

const DEFAULT_PORT = 5432;
const DEFAULT_POOL_MAX = 10;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

/** Valeurs `sslmode` (libpq) qui activent TLS. */
const SSL_MODES_TLS = new Set([
	"require",
	"verify-ca",
	"verify-full",
	"prefer"
]);
/** Valeurs `sslmode` (libpq) qui désactivent TLS. */
const SSL_MODES_PLAINTEXT = new Set(["disable", "allow"]);

function isUrlInput(input: PostgresConfigInput): input is PostgresUrlInput {
	return "url" in input && typeof input.url === "string";
}

interface ParsedUrl {
	readonly host: string;
	readonly port: number;
	readonly database: string;
	readonly user: string;
	readonly password: string;
	readonly ssl: boolean | undefined;
}

function stripLeadingSlash(path: string): string {
	return path.startsWith("/") ? path.slice(1) : path;
}

/**
 * Décode un composant d'URL (`%XX`) en rejetant proprement un échappement
 * invalide. N'inclut **jamais** la valeur (donc le secret) dans l'erreur.
 */
function safeDecode(value: string, what: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		throw new EngineConfigError(
			`URL Postgres : ${what} contient un échappement %XX invalide`
		);
	}
}

/**
 * TLS depuis l'URL : `sslmode` (prioritaire) puis le flag `ssl`. Lève sur une
 * valeur inconnue plutôt que de désactiver TLS silencieusement (fail-open).
 */
function resolveUrlSsl(url: URL): boolean | undefined {
	const sslmode = url.searchParams.get("sslmode");
	if (sslmode !== null) {
		if (SSL_MODES_TLS.has(sslmode)) {
			return true;
		}
		if (SSL_MODES_PLAINTEXT.has(sslmode)) {
			return false;
		}
		throw new EngineConfigError(`URL Postgres : sslmode inconnu '${sslmode}'`);
	}

	const sslFlag = url.searchParams.get("ssl");
	if (sslFlag !== null) {
		const normalized = sslFlag.toLowerCase();
		if (normalized === "true" || normalized === "1") {
			return true;
		}
		if (normalized === "false" || normalized === "0") {
			return false;
		}
		throw new EngineConfigError(
			`URL Postgres : valeur ssl inconnue '${sslFlag}'`
		);
	}

	return undefined;
}

function parsePostgresUrl(raw: string): ParsedUrl {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		// On n'attache PAS la cause : le TypeError de `new URL` porte une
		// propriété `input` = l'URL brute (password inclus) qui fuiterait dans
		// les logs via la chaîne de cause. Le message reste générique, sans secret.
		throw new EngineConfigError("URL Postgres invalide (impossible à parser)");
	}

	if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
		throw new EngineConfigError(
			`Schéma d'URL Postgres attendu 'postgres:'/'postgresql:', reçu '${url.protocol}'`
		);
	}

	const host = url.hostname;
	if (host === "") {
		throw new EngineConfigError("URL Postgres sans hôte");
	}

	const database = safeDecode(
		stripLeadingSlash(url.pathname),
		"base de données"
	);
	if (database === "") {
		throw new EngineConfigError(
			"URL Postgres sans base de données (chemin vide)"
		);
	}

	return {
		host,
		port: url.port === "" ? DEFAULT_PORT : Number.parseInt(url.port, 10),
		database,
		user: safeDecode(url.username, "utilisateur"),
		password: safeDecode(url.password, "mot de passe"),
		ssl: resolveUrlSsl(url)
	};
}

/**
 * Normalise une entrée (URL **ou** champs) en {@link PostgresConnectionConfig}
 * avec les valeurs par défaut appliquées. Lève {@link EngineConfigError} si
 * l'entrée est invalide.
 */
export function resolvePostgresConfig(
	input: PostgresConfigInput
): PostgresConnectionConfig {
	if (isUrlInput(input)) {
		const parsed = parsePostgresUrl(input.url);
		return {
			engine: "postgres",
			host: parsed.host,
			port: parsed.port,
			database: parsed.database,
			user: parsed.user,
			password: parsed.password,
			ssl: input.ssl ?? parsed.ssl ?? false,
			poolMax: input.poolMax ?? DEFAULT_POOL_MAX,
			connectionTimeoutMillis:
				input.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS
		};
	}

	if (input.host === "") {
		throw new EngineConfigError("Config Postgres : `host` vide");
	}
	if (input.database === "") {
		throw new EngineConfigError("Config Postgres : `database` vide");
	}
	if (input.user === "") {
		throw new EngineConfigError("Config Postgres : `user` vide");
	}

	return {
		engine: "postgres",
		host: input.host,
		port: input.port ?? DEFAULT_PORT,
		database: input.database,
		user: input.user,
		password: input.password ?? "",
		ssl: input.ssl ?? false,
		poolMax: input.poolMax ?? DEFAULT_POOL_MAX,
		connectionTimeoutMillis:
			input.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS
	};
}

/**
 * Représentation **sans secret** d'une config, pour logs/UI :
 * `postgres://user:***@host:port/db`. Le mot de passe n'est jamais inclus.
 */
export function describePostgresConfig(cfg: PostgresConnectionConfig): string {
	const auth = cfg.user === "" ? "" : `${cfg.user}:***@`;
	return `postgres://${auth}${cfg.host}:${cfg.port}/${cfg.database}`;
}
