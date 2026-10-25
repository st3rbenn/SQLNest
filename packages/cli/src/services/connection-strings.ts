/**
 * Chaînes de connexion (ADR-038 S3) : une URL, une chaîne JDBC, ADO.NET ou
 * libpq, ramenée à l'URL que l'engine sait ouvrir. `describeConnection` ne
 * rend jamais le mot de passe.
 */

export type DbEngine = "postgres" | "mongodb" | "mssql";

export interface ParsedConnection {
	readonly engine: DbEngine;
	/** URL normalisée, secret compris — à ne jamais afficher ni envoyer. */
	readonly url: string;
	/** Premier hôte, en minuscules. */
	readonly host: string;
	readonly port: number | undefined;
	readonly database: string | undefined;
	readonly user: string | undefined;
}

const DEFAULT_PORT: Readonly<Record<DbEngine, number>> = {
	postgres: 5432,
	mongodb: 27017,
	mssql: 1433
};

const URL_SCHEME_RE =
	/^(postgres|postgresql|mongodb|mongodb\+srv|mssql|sqlserver):\/\//i;
const JDBC_PG_RE = /^jdbc:postgresql:\/\//i;
const JDBC_MSSQL_RE = /^jdbc:sqlserver:\/\//i;
const ADO_SERVER_RE =
	/(^|;)\s*(server|data source|address|addr|network address)\s*=/i;
const LIBPQ_RE = /(^|\s)(host|hostaddr|dbname)\s*=/i;
const LOCAL_HOSTS = new Set([
	"localhost",
	"127.0.0.1",
	"::1",
	"[::1]",
	"(local)",
	"."
]);
const NAME_UNSAFE_RE = /[^a-z0-9_-]+/g;
const PATH_START_RE = /[/?]/;
const TCP_PREFIX_RE = /^tcp:/i;
const LEADING_SEPARATORS_RE = /^[\s;]+/;
const IPV6_HOST_RE = /^(\[[^\]]+\])(?::(\d+))?$/;
const PORT_TEXT_RE = /^\d{1,5}$/;
const EDGE_DASHES_RE = /^-+|-+$/g;

export function parseConnectionString(
	raw: string
): ParsedConnection | undefined {
	const input = stripQuotes(raw.trim());
	if (input === "") return undefined;
	if (JDBC_PG_RE.test(input)) return parseJdbcPostgres(input);
	if (JDBC_MSSQL_RE.test(input)) return parseJdbcSqlServer(input);
	if (URL_SCHEME_RE.test(input)) return parseUrlForm(input);
	if (input.includes(";") && ADO_SERVER_RE.test(input))
		return parseAdoNet(input);
	if (LIBPQ_RE.test(input)) return parseLibpq(input);
	return undefined;
}

/** `user@hôte:port/base`, sans mot de passe. */
export function describeConnection(c: ParsedConnection): string {
	const user = c.user !== undefined ? `${c.user}@` : "";
	const port = c.port !== undefined ? `:${c.port}` : "";
	const database = c.database !== undefined ? `/${c.database}` : "";
	return `${user}${c.host}${port}${database}`;
}

/** `hôte:port/base`, port par défaut du moteur comblé, sans utilisateur. */
export function describeLocation(c: ParsedConnection): string {
	return `${c.host}:${c.port ?? DEFAULT_PORT[c.engine]}/${c.database ?? "<unset>"}`;
}

/**
 * Identité d'une base pour reconnaître deux chaînes qui visent la même :
 * moteur, hôte (localhost et ses alias confondus), port (défaut du moteur),
 * base.
 */
export function connectionIdentity(c: ParsedConnection): string {
	const host = LOCAL_HOSTS.has(c.host) ? "localhost" : c.host;
	const port = c.port ?? DEFAULT_PORT[c.engine];
	return `${c.engine}|${host}|${port}|${(c.database ?? "").toLowerCase()}`;
}

/** Nom proposé d'après la base (ou l'hôte), unique parmi `taken`. */
export function suggestConnectionName(
	c: ParsedConnection,
	taken: readonly string[]
): string {
	const base =
		(c.database ?? c.host)
			.toLowerCase()
			.replace(NAME_UNSAFE_RE, "-")
			.replace(EDGE_DASHES_RE, "")
			.slice(0, 40) || c.engine;
	if (!taken.includes(base)) return base;
	for (let i = 2; ; i += 1) {
		const candidate = `${base}-${i}`;
		if (!taken.includes(candidate)) return candidate;
	}
}

// ─── Formes reconnues ────────────────────────────────────────────────

function parseUrlForm(input: string): ParsedConnection | undefined {
	const match = URL_SCHEME_RE.exec(input);
	if (match === null) return undefined;
	const scheme = (match[1] as string).toLowerCase();
	const engine: DbEngine = scheme.startsWith("postgres")
		? "postgres"
		: scheme.startsWith("mongodb")
			? "mongodb"
			: "mssql";
	const rest = input.slice(match[0].length);
	// L'utilisateur s'arrête au dernier `@` avant la query : un `@` encodé
	// manquant dans le mot de passe ne coupe pas l'hôte.
	const queryAt = rest.indexOf("?");
	const at = rest.lastIndexOf("@", queryAt >= 0 ? queryAt : rest.length);
	const afterAuth = at >= 0 ? rest.slice(at + 1) : rest;
	const pathStart = afterAuth.search(PATH_START_RE);
	const hostPart = pathStart >= 0 ? afterAuth.slice(0, pathStart) : afterAuth;
	if (hostPart === "") return undefined;
	const { host, port } = splitHostPort(hostPart.split(",")[0] as string);
	if (host === "") return undefined;
	const path = pathStart >= 0 ? afterAuth.slice(pathStart) : "";
	const database = path.startsWith("/")
		? decode(path.slice(1).split("?")[0] as string) || undefined
		: undefined;
	const userinfo = at >= 0 ? rest.slice(0, at) : "";
	const user =
		userinfo !== ""
			? decode(userinfo.split(":")[0] as string) || undefined
			: undefined;
	return { engine, url: input, host, port, database, user };
}

/** `jdbc:postgresql://hôte:port/base?user=…&password=…&sslmode=…`. */
function parseJdbcPostgres(input: string): ParsedConnection | undefined {
	const parsed = parseUrlForm(`postgres://${input.replace(JDBC_PG_RE, "")}`);
	if (parsed === undefined) return undefined;
	const queryAt = parsed.url.indexOf("?");
	const params = new URLSearchParams(
		queryAt >= 0 ? parsed.url.slice(queryAt + 1) : ""
	);
	const user = params.get("user") ?? parsed.user;
	const password = params.get("password") ?? undefined;
	params.delete("user");
	params.delete("password");
	return build("postgres", {
		host: parsed.host,
		port: parsed.port,
		database: parsed.database,
		user: user ?? undefined,
		password,
		params: Object.fromEntries(params)
	});
}

/** `jdbc:sqlserver://hôte[\instance][:port];databaseName=…;user=…;password=…`. */
function parseJdbcSqlServer(input: string): ParsedConnection | undefined {
	const body = input.replace(JDBC_MSSQL_RE, "");
	const firstSemicolon = body.indexOf(";");
	const serverPart = firstSemicolon >= 0 ? body.slice(0, firstSemicolon) : body;
	const values = parsePairs(
		firstSemicolon >= 0 ? body.slice(firstSemicolon + 1) : ""
	);
	const server = serverPart !== "" ? serverPart : (values.servername ?? "");
	// `hôte[\instance][:port]` : le port suit l'instance.
	const { host: hostAndInstance, port: inlinePort } = splitHostPort(server);
	const host = hostAndInstance.split("\\")[0] as string;
	if (host === "") return undefined;
	const port = inlinePort ?? toPort(values.portnumber ?? values.port);
	return build("mssql", {
		host,
		port,
		database: values.databasename ?? values.database,
		user: values.user ?? values.username,
		password: values.password,
		params: sqlServerParams(values)
	});
}

/** `Server=tcp:hôte,1433;Database=…;User Id=…;Password=…;TrustServerCertificate=True`. */
function parseAdoNet(input: string): ParsedConnection | undefined {
	const values = parsePairs(input);
	const rawServer =
		values.server ??
		values["data source"] ??
		values.address ??
		values.addr ??
		values["network address"] ??
		"";
	const server = rawServer.replace(TCP_PREFIX_RE, "");
	const [hostAndInstance = "", portText] = server.split(",");
	const host = (hostAndInstance.split("\\")[0] as string).trim().toLowerCase();
	if (host === "") return undefined;
	return build("mssql", {
		host: host === "." || host === "(local)" ? "localhost" : host,
		port: toPort(portText),
		database: values.database ?? values["initial catalog"],
		user: values["user id"] ?? values.uid ?? values.user ?? values.username,
		password: values.password ?? values.pwd,
		params: sqlServerParams(values)
	});
}

/** `host=… port=… dbname=… user=… password=… sslmode=…` (valeurs entre quotes simples admises). */
function parseLibpq(input: string): ParsedConnection | undefined {
	const values: Record<string, string> = {};
	const tokenRe = /([a-z_]+)\s*=\s*('((?:\\.|[^'\\])*)'|\S*)/gi;
	for (const m of input.matchAll(tokenRe)) {
		const key = (m[1] as string).toLowerCase();
		const quoted = m[3];
		values[key] =
			quoted !== undefined ? quoted.replace(/\\(.)/g, "$1") : (m[2] as string);
	}
	const host = (values.host ?? values.hostaddr ?? "").toLowerCase();
	if (host === "") return undefined;
	return build("postgres", {
		host,
		port: toPort(values.port),
		database: values.dbname,
		user: values.user,
		password: values.password,
		params: values.sslmode !== undefined ? { sslmode: values.sslmode } : {}
	});
}

// ─── Outils ──────────────────────────────────────────────────────────

function build(
	engine: DbEngine,
	parts: {
		readonly host: string;
		readonly port: number | undefined;
		readonly database: string | undefined;
		readonly user: string | undefined;
		readonly password: string | undefined;
		readonly params: Readonly<Record<string, string>>;
	}
): ParsedConnection {
	const auth =
		parts.user !== undefined && parts.user !== ""
			? `${encodeURIComponent(parts.user)}${
					parts.password !== undefined
						? `:${encodeURIComponent(parts.password)}`
						: ""
				}@`
			: "";
	const port = parts.port !== undefined ? `:${parts.port}` : "";
	const path =
		parts.database !== undefined && parts.database !== ""
			? `/${encodeURIComponent(parts.database)}`
			: "";
	const query = new URLSearchParams(parts.params).toString();
	return {
		engine,
		url: `${engine}://${auth}${parts.host}${port}${path}${query !== "" ? `?${query}` : ""}`,
		host: parts.host,
		port: parts.port,
		database: parts.database !== "" ? parts.database : undefined,
		user: parts.user !== "" ? parts.user : undefined
	};
}

/** `encrypt` / `trustServerCertificate` d'une chaîne SQL Server, en paramètres d'URL. */
function sqlServerParams(
	values: Readonly<Record<string, string>>
): Record<string, string> {
	const params: Record<string, string> = {};
	for (const [key, param] of [
		["encrypt", "encrypt"],
		["trustservercertificate", "trustServerCertificate"]
	] as const) {
		const value = values[key]?.toLowerCase();
		if (value === "true" || value === "yes") params[param] = "true";
		if (value === "false" || value === "no") params[param] = "false";
	}
	return params;
}

/**
 * Paires `clé=valeur;…` (clés en minuscules). Une valeur entre guillemets
 * (ADO.NET, guillemet doublé = guillemet) ou entre accolades (JDBC) peut
 * contenir `;`.
 */
function parsePairs(input: string): Record<string, string> {
	const values: Record<string, string> = {};
	let i = 0;
	while (i < input.length) {
		const eq = input.indexOf("=", i);
		if (eq < 0) break;
		const key = input
			.slice(i, eq)
			.replace(LEADING_SEPARATORS_RE, "")
			.trim()
			.toLowerCase();
		let j = eq + 1;
		while (input[j] === " ") j += 1;
		const open = input[j];
		let value: string;
		if (open === '"' || open === "'" || open === "{") {
			const close = open === "{" ? "}" : open;
			let k = j + 1;
			let text = "";
			while (k < input.length) {
				if (input[k] === close && close !== "}" && input[k + 1] === close) {
					text += close;
					k += 2;
					continue;
				}
				if (input[k] === close) break;
				text += input[k];
				k += 1;
			}
			value = text;
			const next = input.indexOf(";", k);
			i = next >= 0 ? next + 1 : input.length;
		} else {
			const next = input.indexOf(";", j);
			value = (next >= 0 ? input.slice(j, next) : input.slice(j)).trim();
			i = next >= 0 ? next + 1 : input.length;
		}
		if (key !== "") values[key] = value;
	}
	return values;
}

function splitHostPort(hostPort: string): {
	host: string;
	port: number | undefined;
} {
	const trimmed = hostPort.trim();
	const ipv6 = IPV6_HOST_RE.exec(trimmed);
	if (ipv6 !== null) {
		return { host: (ipv6[1] as string).toLowerCase(), port: toPort(ipv6[2]) };
	}
	const colon = trimmed.lastIndexOf(":");
	if (colon > 0) {
		return {
			host: trimmed.slice(0, colon).toLowerCase(),
			port: toPort(trimmed.slice(colon + 1))
		};
	}
	return { host: trimmed.toLowerCase(), port: undefined };
}

function toPort(text: string | undefined): number | undefined {
	if (text === undefined || !PORT_TEXT_RE.test(text.trim())) return undefined;
	const port = Number(text.trim());
	return port >= 1 && port <= 65535 ? port : undefined;
}

function stripQuotes(value: string): string {
	return value.length >= 2 &&
		((value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'")))
		? value.slice(1, -1)
		: value;
}

function decode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
