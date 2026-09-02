import { EngineConfigError } from "../errors";

/**
 * Configuration de connexion MSSQL **résolue** (chantier M/1) : tous les
 * champs remplis (defaults appliqués). Le `password` est un secret — ne
 * jamais le logger tel quel ; passer par {@link describeMssqlConfig}.
 *
 * TLS : deux boutons distincts, miroir du modèle TDS/tedious —
 *  - `encrypt` : chiffrement du flux (défaut **true**, standard moderne).
 *  - `trustServerCertificate` : accepte un cert non vérifiable (défaut
 *    **false**). Le docker dev (self-signed au boot) et la passe 2014
 *    (chaînes de certs Windows-flavor) passent par `?trustServerCertificate=true`
 *    — opt-in EXPLICITE, jamais de fail-open silencieux.
 */
export interface MssqlConnectionConfig {
	readonly engine: "mssql";
	readonly host: string;
	readonly port: number;
	readonly database: string;
	readonly user: string;
	readonly password: string;
	readonly encrypt: boolean;
	readonly trustServerCertificate: boolean;
	/**
	 * Schéma cible unique — miroir du `schema` PG (6c). Défaut `dbo`.
	 * L'introspection (M/2) filtrera dessus.
	 */
	readonly schema: string;
	readonly connectionTimeoutMillis: number;
}

/** Entrée par URL : `mssql://user:pass@host:port/db?encrypt=true&trustServerCertificate=true&schema=dbo`. */
export interface MssqlUrlInput {
	readonly url: string;
	readonly encrypt?: boolean;
	readonly trustServerCertificate?: boolean;
	readonly schema?: string;
	readonly connectionTimeoutMillis?: number;
}

/** Entrée par champs discrets. */
export interface MssqlFieldsInput {
	readonly host: string;
	readonly port?: number;
	readonly database: string;
	readonly user: string;
	readonly password?: string;
	readonly encrypt?: boolean;
	readonly trustServerCertificate?: boolean;
	readonly schema?: string;
	readonly connectionTimeoutMillis?: number;
}

export type MssqlConfigInput = MssqlUrlInput | MssqlFieldsInput;

const DEFAULT_PORT = 1433;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_SCHEMA = "dbo";
const DEFAULT_ENCRYPT = true;

/**
 * Identifiant de schéma simple — même restriction volontaire que PG (la
 * valeur sert de filtre d'introspection M/2, validée en amont). `dbo`
 * respecte cette forme.
 */
const SCHEMA_NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;

function validateSchemaName(schema: string): string {
	if (!SCHEMA_NAME_RE.test(schema)) {
		throw new EngineConfigError(
			`Schéma MSSQL invalide '${schema}' : attendu un identifiant simple (minuscules, chiffres, _, ≤63)`
		);
	}
	return schema;
}

function isUrlInput(input: MssqlConfigInput): input is MssqlUrlInput {
	return "url" in input && typeof input.url === "string";
}

function stripLeadingSlash(path: string): string {
	return path.startsWith("/") ? path.slice(1) : path;
}

/**
 * Décode un composant d'URL (`%XX`) en rejetant proprement un échappement
 * invalide. N'inclut **jamais** la valeur (donc le secret) dans l'erreur —
 * même politique que la config PG (fuite de password via cause chaînée).
 */
function safeDecode(value: string, what: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		throw new EngineConfigError(
			`URL MSSQL : ${what} contient un échappement %XX invalide`
		);
	}
}

/**
 * Parse un flag booléen d'URL. Lève sur une valeur inconnue plutôt que de
 * choisir silencieusement (fail-open TLS = la faille corrigée sur PG).
 */
function parseBoolParam(url: URL, name: string): boolean | undefined {
	const raw = url.searchParams.get(name);
	if (raw === null) return undefined;
	const normalized = raw.toLowerCase();
	if (normalized === "true" || normalized === "1") return true;
	if (normalized === "false" || normalized === "0") return false;
	throw new EngineConfigError(`URL MSSQL : valeur ${name} inconnue '${raw}'`);
}

interface ParsedUrl {
	readonly host: string;
	readonly port: number;
	readonly database: string;
	readonly user: string;
	readonly password: string;
	readonly encrypt: boolean | undefined;
	readonly trustServerCertificate: boolean | undefined;
	readonly schema: string | undefined;
}

function parseMssqlUrl(raw: string): ParsedUrl {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		// Pas de cause chaînée : le TypeError de `new URL` porte `input` =
		// l'URL brute (password inclus) qui fuiterait dans les logs.
		throw new EngineConfigError("URL MSSQL invalide (impossible à parser)");
	}

	if (url.protocol !== "mssql:" && url.protocol !== "sqlserver:") {
		throw new EngineConfigError(
			`Schéma d'URL MSSQL attendu 'mssql:'/'sqlserver:', reçu '${url.protocol}'`
		);
	}

	const host = url.hostname;
	if (host === "") {
		throw new EngineConfigError("URL MSSQL sans hôte");
	}

	const database = safeDecode(
		stripLeadingSlash(url.pathname),
		"base de données"
	);
	if (database === "") {
		throw new EngineConfigError("URL MSSQL sans base de données (chemin vide)");
	}

	const schemaParam = url.searchParams.get("schema");

	return {
		host,
		port: url.port === "" ? DEFAULT_PORT : Number.parseInt(url.port, 10),
		database,
		user: safeDecode(url.username, "utilisateur"),
		password: safeDecode(url.password, "mot de passe"),
		encrypt: parseBoolParam(url, "encrypt"),
		trustServerCertificate: parseBoolParam(url, "trustServerCertificate"),
		schema: schemaParam !== null && schemaParam !== "" ? schemaParam : undefined
	};
}

/**
 * Normalise une entrée (URL **ou** champs) en {@link MssqlConnectionConfig}
 * avec les défauts appliqués. Lève {@link EngineConfigError} si invalide.
 */
export function resolveMssqlConfig(
	input: MssqlConfigInput
): MssqlConnectionConfig {
	if (isUrlInput(input)) {
		const parsed = parseMssqlUrl(input.url);
		return {
			engine: "mssql",
			host: parsed.host,
			port: parsed.port,
			database: parsed.database,
			user: parsed.user,
			password: parsed.password,
			encrypt: input.encrypt ?? parsed.encrypt ?? DEFAULT_ENCRYPT,
			trustServerCertificate:
				input.trustServerCertificate ?? parsed.trustServerCertificate ?? false,
			schema: validateSchemaName(input.schema ?? parsed.schema ?? DEFAULT_SCHEMA),
			connectionTimeoutMillis:
				input.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS
		};
	}

	if (input.host === "") {
		throw new EngineConfigError("Config MSSQL : `host` vide");
	}
	if (input.database === "") {
		throw new EngineConfigError("Config MSSQL : `database` vide");
	}
	if (input.user === "") {
		throw new EngineConfigError("Config MSSQL : `user` vide");
	}

	return {
		engine: "mssql",
		host: input.host,
		port: input.port ?? DEFAULT_PORT,
		database: input.database,
		user: input.user,
		password: input.password ?? "",
		encrypt: input.encrypt ?? DEFAULT_ENCRYPT,
		trustServerCertificate: input.trustServerCertificate ?? false,
		schema: validateSchemaName(input.schema ?? DEFAULT_SCHEMA),
		connectionTimeoutMillis:
			input.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS
	};
}

/**
 * Représentation **sans secret** pour logs/UI : `mssql://user:***@host:port/db`.
 * Les flags TLS sont annexés seulement quand ils diffèrent des défauts —
 * diagnostic direct d'un connect refusé (cert non trusté / clair).
 */
export function describeMssqlConfig(cfg: MssqlConnectionConfig): string {
	const auth = cfg.user === "" ? "" : `${cfg.user}:***@`;
	const params: string[] = [];
	if (!cfg.encrypt) params.push("encrypt=false");
	if (cfg.trustServerCertificate) params.push("trustServerCertificate=true");
	if (cfg.schema !== DEFAULT_SCHEMA) params.push(`schema=${cfg.schema}`);
	const qs = params.length > 0 ? `?${params.join("&")}` : "";
	return `mssql://${auth}${cfg.host}:${cfg.port}/${cfg.database}${qs}`;
}
