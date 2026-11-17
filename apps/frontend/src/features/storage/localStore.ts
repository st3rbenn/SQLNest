/**
 * Stockage local du navigateur : une convention de clés
 * (`sqlnest:<tranche>[:<connexion>[:<suffixe>]]`), des accès qui ne lèvent
 * jamais (quota, navigation privée, JSON abîmé), et le ménage des clés
 * mortes (anciens noms, identifiants invalides, connexions disparues).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isConnectionId(value: unknown): value is string {
	return typeof value === "string" && UUID.test(value);
}

/** Clés sans connexion. */
export const storageKeys = {
	recentConnections: "sqlnest:recent-connections",
	connectionRegistry: "sqlnest:connections",
	leftDrawerWidth: "sqlnest:leftDrawer:width",
	canvasConsoleSource: "sqlnest:canvas-console:source",
	canvasConsoleHeight: "sqlnest:canvas-console:height",
	canvasConsoleHistory: "sqlnest:canvas-console:history",
	gallerySort: "sqlnest:gallery:sort",
	galleryView: "sqlnest:gallery:view",
	consoleEditorHeight: "sqlnest:console:editor-height",
	consoleResultsView: "sqlnest:console:results-view",
	consoleResultsPageSize: "sqlnest:console:results-page-size"
} as const;

const CONNECTION_SLICES = [
	"console-nodes",
	"console-open",
	"console-tabs",
	"canvas-console:history",
	"schemaEvents:lastSeenAt",
	"systemNode:enums",
	"systemNode:schemaEvents"
] as const;
export type ConnectionSlice = (typeof CONNECTION_SLICES)[number];

/** Une connexion absente ou invalide n'ouvre pas de clé à son nom. */
const NO_CONNECTION = "_null";

export function connectionKey(
	slice: ConnectionSlice,
	connectionId: string | null | undefined,
	suffix?: string
): string {
	if (!isConnectionId(connectionId)) return `sqlnest:${slice}:${NO_CONNECTION}`;
	const base = `sqlnest:${slice}:${connectionId}`;
	return suffix !== undefined && suffix !== "" ? `${base}:${suffix}` : base;
}

const SCHEMA_SLICES = ["positions", "sizes", "frames", "edge-anchors"] as const;
export type SchemaSlice = (typeof SCHEMA_SLICES)[number];

/**
 * Clé d'une tranche du canvas hors connexion, par signature du schéma
 * (moteur + tables triées) : deux bases de même forme partagent leur
 * disposition, une base de forme différente repart de zéro.
 */
export function schemaSliceKey(
	slice: SchemaSlice,
	schema: {
		readonly engine: string;
		readonly collections: readonly { readonly name: string }[];
	}
): string {
	const names = schema.collections
		.map((c) => c.name)
		.sort()
		.join(",");
	return `sqlnest:${slice}:${schema.engine}:${names}`;
}

function store(): Storage | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage;
	} catch {
		return null;
	}
}

export function readText(key: string): string | null {
	try {
		return store()?.getItem(key) ?? null;
	} catch {
		return null;
	}
}

export function writeText(key: string, value: string): void {
	try {
		store()?.setItem(key, value);
	} catch {
		// Quota ou navigation privée : la préférence est perdue, rien de plus.
	}
}

/** `undefined` : clé absente ou contenu illisible. */
export function readJson(key: string): unknown {
	const raw = readText(key);
	if (raw === null) return undefined;
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return undefined;
	}
}

export function writeJson(key: string, value: unknown): void {
	writeText(key, JSON.stringify(value));
}

export function removeKey(key: string): void {
	try {
		store()?.removeItem(key);
	} catch {
		// Stockage indisponible : rien à retirer.
	}
}

function allKeys(): string[] {
	try {
		const s = store();
		return s === null ? [] : Object.keys(s);
	} catch {
		return [];
	}
}

/** Connexion visée par une clé, `undefined` si la clé n'en vise aucune. */
function connectionOf(key: string): string | undefined {
	for (const slice of CONNECTION_SLICES) {
		const prefix = `sqlnest:${slice}:`;
		if (key.startsWith(prefix)) {
			return key.slice(prefix.length).split(":")[0];
		}
	}
	return undefined;
}

const LEGACY_GLOBAL: Readonly<Record<string, string>> = {
	"sqlnest.gallery.sort": storageKeys.gallerySort,
	"sqlnest.gallery.view": storageKeys.galleryView,
	"sqlnest.console.editorHeight": storageKeys.consoleEditorHeight,
	"sqlnest.console.results.view": storageKeys.consoleResultsView,
	"sqlnest.console.results.pageSize": storageKeys.consoleResultsPageSize
};
const LEGACY_TABS = "sqlnest.console.tabs.";
const UUID_LENGTH = 36;

function legacyTarget(key: string): string | null {
	const global = LEGACY_GLOBAL[key];
	if (global !== undefined) return global;
	if (!key.startsWith(LEGACY_TABS)) return null;
	const rest = key.slice(LEGACY_TABS.length);
	const id = rest.slice(0, UUID_LENGTH);
	const tail = rest.slice(UUID_LENGTH);
	if (!isConnectionId(id) || (tail !== "" && !tail.startsWith("."))) {
		return null;
	}
	return connectionKey("console-tabs", id, tail.slice(1));
}

/**
 * Anciennes clés `sqlnest.…` : leur contenu passe sous le nom actuel, sans
 * écraser une valeur déjà écrite sous ce nom. Une ancienne clé sans
 * équivalent (identifiant tronqué) est retirée.
 */
export function migrateLegacyKeys(): void {
	for (const key of allKeys()) {
		if (!key.startsWith("sqlnest.")) continue;
		const target = legacyTarget(key);
		if (target !== null && readText(target) === null) {
			const value = readText(key);
			if (value !== null) writeText(target, value);
		}
		removeKey(key);
	}
}

/** Clés ouvertes pour un identifiant de connexion qui n'en est pas un. */
export function purgeInvalidConnectionKeys(): void {
	for (const key of allKeys()) {
		const id = connectionOf(key);
		if (id !== undefined && id !== NO_CONNECTION && !isConnectionId(id)) {
			removeKey(key);
		}
	}
}

/** Tout ce que le navigateur garde pour une connexion. */
export function purgeConnection(connectionId: string): void {
	for (const key of allKeys()) {
		if (connectionOf(key) === connectionId) removeKey(key);
	}
	const recents = readJson(storageKeys.recentConnections);
	if (Array.isArray(recents) && recents.includes(connectionId)) {
		writeJson(
			storageKeys.recentConnections,
			recents.filter((id) => id !== connectionId)
		);
	}
}

function readRegistry(): Record<string, string> {
	const raw = readJson(storageKeys.connectionRegistry);
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	return Object.fromEntries(
		Object.entries(raw).filter(
			(entry): entry is [string, string] =>
				isConnectionId(entry[0]) && typeof entry[1] === "string"
		)
	);
}

/**
 * Aligne le registre connexion → équipe sur la liste des connexions d'une
 * équipe, et purge celles que l'équipe n'a plus. Une clé ne dit pas à
 * quelle équipe sa connexion appartient : seule une connexion déjà vue dans
 * cette équipe peut être déclarée disparue. Rend les connexions purgées.
 */
export function syncConnectionRegistry(
	teamSlug: string,
	liveIds: readonly string[]
): readonly string[] {
	const registry = readRegistry();
	const live = new Set(liveIds.filter(isConnectionId));
	const gone = Object.keys(registry).filter(
		(id) => registry[id] === teamSlug && !live.has(id)
	);
	const next: Record<string, string> = {};
	for (const [id, team] of Object.entries(registry)) {
		if (!gone.includes(id)) next[id] = team;
	}
	for (const id of live) next[id] = teamSlug;
	for (const id of gone) purgeConnection(id);
	if (JSON.stringify(next) !== JSON.stringify(registry)) {
		writeJson(storageKeys.connectionRegistry, next);
	}
	return gone;
}

/**
 * Tranches du canvas écrites hors connexion. Connecté, l'état vit sur le
 * serveur : ces clés ne feraient que réinjecter un état périmé à la
 * prochaine déconnexion.
 */
export function purgeSchemaSlices(): void {
	const prefixes = SCHEMA_SLICES.map((slice) => `sqlnest:${slice}:`);
	for (const key of allKeys()) {
		if (prefixes.some((prefix) => key.startsWith(prefix))) removeKey(key);
	}
}

/** Au démarrage, avant le premier rendu : aucune lecture ne voit d'ancienne clé. */
export function initLocalStore(): void {
	migrateLegacyKeys();
	purgeInvalidConnectionKeys();
}
