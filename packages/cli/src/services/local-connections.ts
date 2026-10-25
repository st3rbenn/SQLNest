/**
 * Résolution des DSN Postgres locales — le CLI matérialise les queries
 * avec **ses propres** credentials, jamais transmis via WS/HTTP au backend.
 *
 * ─── Fichier `~/.sqlnest/local-connections.toml` ──────────────────────
 * ```toml
 * version = 1
 *
 * [[connections]]
 * name = "prod"
 * url  = "postgres://user:pass@host:5432/db"
 *
 * [[connections]]
 * name = "apollon"
 * url_from = { file = "/Users/me/apollon/.env", key = "DATABASE_URL" }
 *
 * [connections.project]
 * path  = "/Users/me/apollon"
 * orm   = "prisma"
 * apply = true
 * ```
 * Une entrée porte une `url` copiée, ou une référence `url_from` à une
 * variable d'un `.env`, relue au moment de servir (ADR-038 S4) ; `project`
 * est le projet relié (ADR-038 S5). Version 2 dès qu'une entrée utilise
 * `url_from` ou `project` (un ancien CLI refuse alors le fichier au lieu de
 * le lire de travers), 1 sinon.
 * Perms 0600 obligatoires (même politique que `config.toml`). Le fichier
 * peut ne pas exister — la résolution retombe sur les variables d'env.
 *
 * ─── Résolution DSN pour un tunnel `name` ─────────────────────────────
 * Ordre de priorité :
 *   1. `SQLNEST_PG_URL_<UPPER_NAME>` (ex `SQLNEST_PG_URL_PROD`) — override
 *      per-tunnel, utile en CI ou pour un swap ponctuel.
 *   2. `SQLNEST_PG_URL` — fallback single-tunnel (dev local, un seul CLI).
 *   3. Entrée matching dans `local-connections.toml`.
 *
 * `resolveLocalConnectionUrl(name)` throw explicitement si aucune source
 * n'est trouvée — le CLI peut alors expliquer au user comment configurer.
 *
 * ─── Règle sécu ancrée ────────────────────────────────────────────────
 * La DSN retournée par `resolveLocalConnectionUrl` doit être utilisée
 * UNIQUEMENT pour ouvrir la connexion `pg` locale — jamais loggée, jamais
 * incluse dans un payload sortant. Un test-guard (`local-connections.test.ts`)
 * vérifie que la DSN n'apparaît pas dans l'objet retourné par
 * `describeConnectionForDiagnostics`.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync
} from "node:fs";
import { platform } from "node:os";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { ORM_NAMES, type OrmName } from "../orm/types";
import { CONFIG_DIR_PERMS, getConfigDir, MAX_CONFIG_PERMS } from "./config";
import { parseConnectionString } from "./connection-strings";
import { parseDotenv } from "./dotenv";

export const LOCAL_CONNECTIONS_VERSION = 1 as const;
export const LOCAL_CONNECTIONS_FILENAME = "local-connections.toml";

/** Variable `key` du fichier `file` (un `.env`), relue au moment de servir. */
export interface LocalConnectionUrlRef {
	readonly file: string;
	readonly key: string;
}

/** Projet relié à une connexion (ADR-038 S5). */
export interface LocalConnectionProject {
	readonly path: string;
	readonly orm: OrmName;
	/** `false` : migration et modèle écrits, base non touchée (ADR-035 point 3). */
	readonly apply: boolean;
}

/** Une connexion : `url` copiée, ou `urlFrom` référence — l'une des deux. */
export interface LocalConnectionEntry {
	readonly name: string;
	readonly url?: string;
	readonly urlFrom?: LocalConnectionUrlRef;
	readonly project?: LocalConnectionProject;
}

export interface LocalConnectionsFile {
	readonly version: 1 | 2;
	readonly connections: readonly LocalConnectionEntry[];
}

/** Représentation SAFE pour logs/UI — ne contient PAS la DSN. */
export interface ConnectionDiagnostics {
	readonly name: string;
	readonly source:
		| "env-per-tunnel"
		| "env-fallback"
		| "local-file"
		| "env-file";
}

// Regex hoistées (règle Biome).
const NAME_UPPER_SANITIZE_RE = /[^A-Z0-9_]/g;

/** Chemin du fichier `local-connections.toml`. */
export function getLocalConnectionsPath(): string {
	return `${getConfigDir()}/${LOCAL_CONNECTIONS_FILENAME}`;
}

/**
 * Vérifie les perms du fichier — throw si trop permissif. Même logique
 * que `assertConfigPerms` de `config.ts` : `> 0600` = refus.
 */
export function assertLocalConnectionsPerms(path: string): void {
	if (platform() === "win32") return;
	const perms = statSync(path).mode & 0o777;
	if (perms > MAX_CONFIG_PERMS) {
		throw new Error(
			`~/.sqlnest/${LOCAL_CONNECTIONS_FILENAME} permissions ${perms
				.toString(8)
				.padStart(
					4,
					"0"
				)} > ${MAX_CONFIG_PERMS.toString(8).padStart(4, "0")}.\n` +
				`Fix : chmod 600 ${path}\n` +
				`Le CLI refuse un fichier de DSN lisible par d'autres users.`
		);
	}
}

/**
 * Charge le fichier `local-connections.toml`.
 *   - `null` si absent.
 *   - Throw si perms trop permissives, TOML malformé, ou version inconnue.
 */
export function loadLocalConnections(): LocalConnectionsFile | null {
	const path = getLocalConnectionsPath();
	if (!existsSync(path)) return null;

	assertLocalConnectionsPerms(path);

	const raw = readFileSync(path, "utf8");
	const parsed = parseToml(raw) as unknown;
	return validateLocalConnections(parsed);
}

/** Sérialise + write avec perms 0600. Crée le dossier si absent. */
export function saveLocalConnections(file: LocalConnectionsFile): void {
	const dir = getConfigDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: CONFIG_DIR_PERMS });
	}
	const path = getLocalConnectionsPath();
	const serialized = stringifyToml({
		version: fileVersion(file.connections),
		connections: file.connections.map((c) => ({
			name: c.name,
			...(c.url !== undefined ? { url: c.url } : {}),
			...(c.urlFrom !== undefined
				? { url_from: { file: c.urlFrom.file, key: c.urlFrom.key } }
				: {}),
			...(c.project !== undefined
				? {
						project: {
							path: c.project.path,
							orm: c.project.orm,
							apply: c.project.apply
						}
					}
				: {})
		}))
	});
	writeFileSync(path, serialized, { mode: MAX_CONFIG_PERMS });
	assertLocalConnectionsPerms(path);
}

/**
 * Ajoute (ou remplace, dedup par `name`) une entrée dans le fichier local.
 * Créé le fichier s'il n'existe pas. Perms 0600 posées à l'écriture — le
 * caller n'a pas à s'en soucier. La nouvelle entrée est ajoutée en QUEUE
 * (l'ordre existant est préservé pour les autres entrées). Remplacer
 * l'URL d'une connexion garde son projet relié, sauf s'il est fourni.
 */
export function addLocalConnection(entry: LocalConnectionEntry): void {
	const existing = loadLocalConnections();
	const base: LocalConnectionsFile = existing ?? {
		version: LOCAL_CONNECTIONS_VERSION,
		connections: []
	};
	const previous = base.connections.find((c) => c.name === entry.name);
	const project = entry.project ?? previous?.project;
	const next: LocalConnectionEntry[] = [
		...base.connections.filter((c) => c.name !== entry.name),
		{ ...entry, ...(project !== undefined ? { project } : {}) }
	];
	saveLocalConnections({
		version: LOCAL_CONNECTIONS_VERSION,
		connections: next
	});
}

/**
 * Retire l'entrée nommée `name` du fichier local. Throw explicitement si
 * le fichier n'existe pas ou si aucune entrée ne matche — la commande CLI
 * doit distinguer ces cas de l'idempotence.
 */
export function removeLocalConnection(name: string): void {
	const existing = loadLocalConnections();
	if (!existing) {
		throw new Error(
			`Aucun fichier ${LOCAL_CONNECTIONS_FILENAME} — rien à retirer.`
		);
	}
	const filtered = existing.connections.filter((c) => c.name !== name);
	if (filtered.length === existing.connections.length) {
		throw new Error(
			`Aucune entrée nommée « ${name} » dans ${LOCAL_CONNECTIONS_FILENAME}.`
		);
	}
	saveLocalConnections({
		version: LOCAL_CONNECTIONS_VERSION,
		connections: filtered
	});
}

/**
 * Résout la DSN Postgres pour un tunnel donné. Ordre de priorité :
 *   1. `SQLNEST_PG_URL_<UPPER_NAME>` (per-tunnel).
 *   2. `SQLNEST_PG_URL` (fallback single-tunnel).
 *   3. `local-connections.toml`.
 *
 * Throw `LocalConnectionNotFoundError` si aucune source ne matche — la
 * commande CLI caller peut alors afficher un message d'aide au user.
 */
export function resolveLocalConnectionUrl(
	tunnelName: string,
	env: NodeJS.ProcessEnv = process.env
): string {
	const perTunnelKey = `SQLNEST_PG_URL_${tunnelName
		.toUpperCase()
		.replace(NAME_UPPER_SANITIZE_RE, "_")}`;
	const perTunnel = env[perTunnelKey];
	if (perTunnel && perTunnel.length > 0) return perTunnel;

	const fallback = env.SQLNEST_PG_URL;
	if (fallback && fallback.length > 0) return fallback;

	const file = loadLocalConnections();
	const entry = file?.connections.find((c) => c.name === tunnelName);
	if (entry) return entryUrl(entry);

	throw new LocalConnectionNotFoundError(tunnelName, perTunnelKey);
}

/** Version du fichier : 2 dès qu'une entrée en utilise les champs. */
function fileVersion(connections: readonly LocalConnectionEntry[]): 1 | 2 {
	return connections.some(
		(c) => c.urlFrom !== undefined || c.project !== undefined
	)
		? 2
		: LOCAL_CONNECTIONS_VERSION;
}

/**
 * URL d'une entrée : copiée, ou relue dans le `.env` qu'elle référence. Une
 * valeur JDBC, ADO.NET, libpq ou au format SQL Server de Prisma est ramenée à
 * l'URL que l'engine sait ouvrir (ADR-038 S3).
 */
export function entryUrl(entry: LocalConnectionEntry): string {
	if (entry.url !== undefined) return entry.url;
	const ref = entry.urlFrom as LocalConnectionUrlRef;
	if (!existsSync(ref.file)) {
		throw new Error(
			`« ${entry.name} » lit ${ref.key} dans ${ref.file} : fichier introuvable.`
		);
	}
	const value = parseDotenv(readFileSync(ref.file, "utf8"), process.env)[
		ref.key
	];
	if (value === undefined || value === "") {
		throw new Error(
			`« ${entry.name} » lit ${ref.key} dans ${ref.file} : variable absente ou vide.`
		);
	}
	return parseConnectionString(value)?.url ?? value;
}

/**
 * Diagnostics SAFE — ne contient JAMAIS la DSN. Utilisé pour les logs +
 * l'output CLI (`sqlnest ping`).
 */
export function describeConnectionForDiagnostics(
	tunnelName: string,
	env: NodeJS.ProcessEnv = process.env
): ConnectionDiagnostics {
	const perTunnelKey = `SQLNEST_PG_URL_${tunnelName
		.toUpperCase()
		.replace(NAME_UPPER_SANITIZE_RE, "_")}`;
	if (env[perTunnelKey] && env[perTunnelKey].length > 0) {
		return { name: tunnelName, source: "env-per-tunnel" };
	}
	if (env.SQLNEST_PG_URL && env.SQLNEST_PG_URL.length > 0) {
		return { name: tunnelName, source: "env-fallback" };
	}
	const entry = loadLocalConnections()?.connections.find(
		(c) => c.name === tunnelName
	);
	return {
		name: tunnelName,
		source: entry?.urlFrom !== undefined ? "env-file" : "local-file"
	};
}

export class LocalConnectionNotFoundError extends Error {
	readonly tunnelName: string;
	readonly perTunnelEnvKey: string;

	constructor(tunnelName: string, perTunnelEnvKey: string) {
		super(
			`Aucune DSN Postgres trouvée pour le tunnel « ${tunnelName} ». ` +
				`Définis l'une des sources :\n` +
				`  - env: ${perTunnelEnvKey}=postgres://…\n` +
				`  - env: SQLNEST_PG_URL=postgres://… (fallback)\n` +
				`  - fichier: ~/.sqlnest/${LOCAL_CONNECTIONS_FILENAME} (perms 0600)`
		);
		this.name = "LocalConnectionNotFoundError";
		this.tunnelName = tunnelName;
		this.perTunnelEnvKey = perTunnelEnvKey;
	}
}

function validateLocalConnections(raw: unknown): LocalConnectionsFile {
	if (raw == null || typeof raw !== "object") {
		throw new Error(`${LOCAL_CONNECTIONS_FILENAME}: TOML invalide`);
	}
	const obj = raw as Record<string, unknown>;
	if (obj.version !== 1 && obj.version !== 2) {
		throw new Error(
			`${LOCAL_CONNECTIONS_FILENAME}: version ${String(obj.version)} inconnue (attendu 1 ou 2).`
		);
	}
	// `connections` absent est légitime : un user qui a supprimé toutes ses
	// entrées à la main garde le header `version = 1`. On traite comme un
	// tableau vide (`add-connection` pourra insérer normalement).
	const connectionsRaw = obj.connections ?? [];
	if (!Array.isArray(connectionsRaw)) {
		throw new Error(
			`${LOCAL_CONNECTIONS_FILENAME}: [[connections]] doit être un tableau.`
		);
	}
	const connections: LocalConnectionEntry[] = [];
	const seenNames = new Set<string>();
	for (const [i, c] of connectionsRaw.entries()) {
		if (c == null || typeof c !== "object") {
			throw new Error(
				`${LOCAL_CONNECTIONS_FILENAME}: connections[${i}] doit être un objet.`
			);
		}
		const entry = c as Record<string, unknown>;
		if (typeof entry.name !== "string" || entry.name.length === 0) {
			throw new Error(
				`${LOCAL_CONNECTIONS_FILENAME}: connections[${i}].name manquant.`
			);
		}
		const where = `${LOCAL_CONNECTIONS_FILENAME}: connections[${i}]`;
		const url =
			typeof entry.url === "string" && entry.url.length > 0
				? entry.url
				: undefined;
		const urlFrom = validateUrlRef(entry.url_from, where);
		if ((url === undefined) === (urlFrom === undefined)) {
			throw new Error(
				`${where} : une \`url\` ou un \`url_from\`, l'un des deux.`
			);
		}
		if (seenNames.has(entry.name)) {
			throw new Error(
				`${LOCAL_CONNECTIONS_FILENAME}: nom « ${entry.name} » en double.`
			);
		}
		seenNames.add(entry.name);
		const project = validateProject(entry.project, where);
		connections.push({
			name: entry.name,
			...(url !== undefined ? { url } : {}),
			...(urlFrom !== undefined ? { urlFrom } : {}),
			...(project !== undefined ? { project } : {})
		});
	}
	return { version: obj.version, connections };
}

function validateUrlRef(
	raw: unknown,
	where: string
): LocalConnectionUrlRef | undefined {
	if (raw === undefined) return undefined;
	const ref = raw as Record<string, unknown> | null;
	if (
		ref === null ||
		typeof ref !== "object" ||
		typeof ref.file !== "string" ||
		ref.file.length === 0 ||
		typeof ref.key !== "string" ||
		ref.key.length === 0
	) {
		throw new Error(`${where}.url_from : \`file\` et \`key\` attendus.`);
	}
	return { file: ref.file, key: ref.key };
}

function validateProject(
	raw: unknown,
	where: string
): LocalConnectionProject | undefined {
	if (raw === undefined) return undefined;
	const project = raw as Record<string, unknown> | null;
	if (
		project === null ||
		typeof project !== "object" ||
		typeof project.path !== "string" ||
		project.path.length === 0 ||
		!ORM_NAMES.includes(project.orm as OrmName)
	) {
		throw new Error(
			`${where}.project : \`path\` et \`orm\` (${ORM_NAMES.join(", ")}) attendus.`
		);
	}
	return {
		path: project.path,
		orm: project.orm as OrmName,
		apply: project.apply !== false
	};
}
