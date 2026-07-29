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
	/**
	 * Schéma cible unique : l'introspection le lit et le `search_path` de la
	 * connexion y est épinglé (introspection et exécution voient le même espace
	 * de noms). Défaut `public`. Pointer une base distante hors `public` (ex.
	 * `rnacen` de RNAcentral) = passer `?schema=rnacen` dans l'URL.
	 */
	readonly schema: string;
	readonly poolMax: number;
	readonly connectionTimeoutMillis: number;
}

/** Entrée par URL : `postgres://user:pass@host:port/db?sslmode=require&schema=public`. */
export interface PostgresUrlInput {
	readonly url: string;
	readonly ssl?: boolean;
	readonly schema?: string;
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
	readonly schema?: string;
	readonly poolMax?: number;
	readonly connectionTimeoutMillis?: number;
}

export type PostgresConfigInput = PostgresUrlInput | PostgresFieldsInput;

const DEFAULT_PORT = 5432;
const DEFAULT_POOL_MAX = 10;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_SCHEMA = "public";

/**
 * Identifiant de schéma **simple** : minuscules/chiffres/`_`, ≤63 (limite pg).
 * On restreint volontairement (v1) : la valeur entre dans la chaîne de connexion
 * `options` (non paramétrable, donc validée en amont) ET dans un `search_path`
 * **non quoté** — autoriser des majuscules créerait un décalage de casse
 * (pg les replierait) entre l'introspection (`= $1`, sensible à la casse) et le
 * `search_path`. `public`/`rnacen` respectent cette forme.
 */
const SCHEMA_NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Valide un nom de schéma. Lève {@link EngineConfigError} s'il n'est pas un
 * identifiant simple. Le nom (non secret) est inclus dans le message pour aider
 * au diagnostic.
 */
function validateSchemaName(schema: string): string {
	if (!SCHEMA_NAME_RE.test(schema)) {
		throw new EngineConfigError(
			`Schéma Postgres invalide '${schema}' : attendu un identifiant simple (minuscules, chiffres, _, ≤63)`
		);
	}
	return schema;
}

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
	readonly schema: string | undefined;
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

	// `?schema=` vide (`?schema=`) est traité comme absent → défaut appliqué plus haut.
	const schemaParam = url.searchParams.get("schema");

	return {
		host,
		port: url.port === "" ? DEFAULT_PORT : Number.parseInt(url.port, 10),
		database,
		user: safeDecode(url.username, "utilisateur"),
		password: safeDecode(url.password, "mot de passe"),
		ssl: resolveUrlSsl(url),
		schema: schemaParam !== null && schemaParam !== "" ? schemaParam : undefined
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
			// Précédence : surcharge explicite > `?schema=` de l'URL > défaut.
			schema: validateSchemaName(
				input.schema ?? parsed.schema ?? DEFAULT_SCHEMA
			),
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
		schema: validateSchemaName(input.schema ?? DEFAULT_SCHEMA),
		poolMax: input.poolMax ?? DEFAULT_POOL_MAX,
		connectionTimeoutMillis:
			input.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS
	};
}

/**
 * Représentation **sans secret** d'une config, pour logs/UI :
 * `postgres://user:***@host:port/db`. Le mot de passe n'est jamais inclus. Le
 * schéma cible est annexé (`?schema=…`) uniquement s'il diffère du défaut, pour
 * diagnostiquer un « 0 collection » dû à une base hors `public`.
 */
export function describePostgresConfig(cfg: PostgresConnectionConfig): string {
	const auth = cfg.user === "" ? "" : `${cfg.user}:***@`;
	const schema = cfg.schema === DEFAULT_SCHEMA ? "" : `?schema=${cfg.schema}`;
	return `postgres://${auth}${cfg.host}:${cfg.port}/${cfg.database}${schema}`;
}
