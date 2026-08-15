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
 * name = "staging"
 * url  = "postgres://…"
 * ```
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
import { CONFIG_DIR_PERMS, getConfigDir, MAX_CONFIG_PERMS } from "./config";

export const LOCAL_CONNECTIONS_VERSION = 1 as const;
export const LOCAL_CONNECTIONS_FILENAME = "local-connections.toml";

export interface LocalConnectionEntry {
	readonly name: string;
	readonly url: string;
}

export interface LocalConnectionsFile {
	readonly version: typeof LOCAL_CONNECTIONS_VERSION;
	readonly connections: readonly LocalConnectionEntry[];
}

/** Représentation SAFE pour logs/UI — ne contient PAS la DSN. */
export interface ConnectionDiagnostics {
	readonly name: string;
	readonly source: "env-per-tunnel" | "env-fallback" | "local-file";
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
		version: file.version,
		connections: file.connections.map((c) => ({ name: c.name, url: c.url }))
	});
	writeFileSync(path, serialized, { mode: MAX_CONFIG_PERMS });
	assertLocalConnectionsPerms(path);
}

/**
 * Ajoute (ou remplace, dedup par `name`) une entrée dans le fichier local.
 * Créé le fichier avec version=1 s'il n'existe pas. Perms 0600 posées à
 * l'écriture — le caller n'a pas à s'en soucier. La nouvelle entrée est
 * ajoutée en QUEUE (l'ordre existant est préservé pour les autres entrées).
 */
export function addLocalConnection(entry: LocalConnectionEntry): void {
	const existing = loadLocalConnections();
	const base: LocalConnectionsFile = existing ?? {
		version: LOCAL_CONNECTIONS_VERSION,
		connections: []
	};
	const next: LocalConnectionEntry[] = [
		...base.connections.filter((c) => c.name !== entry.name),
		entry
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
	if (entry) return entry.url;

	throw new LocalConnectionNotFoundError(tunnelName, perTunnelKey);
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
	return { name: tunnelName, source: "local-file" };
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
	if (obj.version !== LOCAL_CONNECTIONS_VERSION) {
		throw new Error(
			`${LOCAL_CONNECTIONS_FILENAME}: version ${String(obj.version)} inconnue (attendu ${LOCAL_CONNECTIONS_VERSION}).`
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
		if (typeof entry.url !== "string" || entry.url.length === 0) {
			throw new Error(
				`${LOCAL_CONNECTIONS_FILENAME}: connections[${i}].url manquant.`
			);
		}
		if (seenNames.has(entry.name)) {
			throw new Error(
				`${LOCAL_CONNECTIONS_FILENAME}: nom « ${entry.name} » en double.`
			);
		}
		seenNames.add(entry.name);
		connections.push({ name: entry.name, url: entry.url });
	}
	return { version: LOCAL_CONNECTIONS_VERSION, connections };
}
