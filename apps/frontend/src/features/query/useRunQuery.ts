import { useMutation } from "@tanstack/react-query";
import { fetchChecksumHistory } from "../checksum-history/checksumHistoryClient";
import { SCHEMA_EVENTS_NAME } from "../checksum-history/schemaEventsCollection";

const API_BASE = window.CONTEXT.apiBaseUrl;

/**
 * Classification d'une source SNQL vs. la table système `schema_events`.
 * Basée sur un lexer léger (regex) — les casse-limites (ident quoté, source
 * multiline, string literal contenant "schema_events") sont acceptables v1
 * car la fausse positive fait juste échouer la query sur la vraie DB user
 * avec un message clair "table introuvable" — pas de silent write détourné.
 */
export function classifySchemaEventsUsage(source: string): {
	readonly kind: "none" | "read" | "write";
} {
	// Verbes de lecture — cible tout de suite après le verbe.
	const readMatch = /^\s*(?:find|get)\s+([a-zA-Z_][\w]*)/i.exec(source);
	if (readMatch && readMatch[1] === SCHEMA_EVENTS_NAME) {
		return { kind: "read" };
	}
	// Verbes d'écriture — target après `into` (add), après verbe (update/remove/edit).
	const writeVerbs = /^\s*(?:add|create|edit|update|remove|delete)\b/i.test(source);
	if (writeVerbs) {
		const targetInto = /\binto\s+([a-zA-Z_][\w]*)/i.exec(source);
		if (targetInto && targetInto[1] === SCHEMA_EVENTS_NAME) {
			return { kind: "write" };
		}
		const targetFrom = /\bfrom\s+([a-zA-Z_][\w]*)/i.exec(source);
		if (targetFrom && targetFrom[1] === SCHEMA_EVENTS_NAME) {
			return { kind: "write" };
		}
		const targetDirect =
			/^\s*(?:update|edit)\s+([a-zA-Z_][\w]*)/i.exec(source);
		if (targetDirect && targetDirect[1] === SCHEMA_EVENTS_NAME) {
			return { kind: "write" };
		}
	}
	return { kind: "none" };
}

/**
 * Convertit une page d'historique en `QueryResult` compatible avec le rendu
 * de la console. Les colonnes sont hard-codées (shape stable de la table
 * système), les rows viennent tel quel de l'API SQLNest.
 */
function schemaEventsToQueryResult(
	entries: ReadonlyArray<{
		id: string;
		dbSchemaChecksum: string;
		dbConnectionId: string | null;
		seenAt: string;
	}>
): QueryResult {
	return {
		columns: [
			{ name: "id", type: "string", nullable: false },
			{ name: "seen_at", type: "date", nullable: false },
			{ name: "checksum", type: "string", nullable: false },
			{ name: "db_connection_id", type: "string", nullable: true }
		],
		rows: entries.map((e) => ({
			id: e.id,
			seen_at: e.seenAt,
			checksum: e.dbSchemaChecksum,
			db_connection_id: e.dbConnectionId
		})),
		rowCount: entries.length,
		written: false
	};
}

/**
 * Type SNQL d'une colonne — aligné sur `SnqlType` de
 * `packages/snql/src/schema/model.ts`. Dupliqué ici pour ne pas ajouter
 * `@sqlnest/snql` en dep du frontend (types uniquement de toute façon).
 */
export type SnqlColumnType =
	| "string"
	| "int"
	| "bigint"
	| "float"
	| "decimal"
	| "bool"
	| "date"
	| "json"
	| "array"
	| "uuid"
	| "enum"
	| "unknown";

export interface QueryResultColumn {
	readonly name: string;
	readonly type: SnqlColumnType;
	readonly nullable: boolean;
}

export interface QueryResult {
	readonly columns: readonly QueryResultColumn[];
	readonly rows: readonly Record<string, unknown>[];
	readonly rowCount: number;
	/** `true` = écriture (lignes affectées) ; distingue d'une lecture à 0 ligne. */
	readonly written: boolean;
}

/**
 * Span source SNQL sérialisé `[start, length]` — aligné sur `SerializedSpan`
 * dans `packages/snql/src/codegen/mapper.ts`. Dupliqué ici pour ne pas
 * dépendre de `@sqlnest/snql` côté frontend (types uniquement).
 */
export type SerializedSpan = readonly [start: number, length: number];

/**
 * Détail structuré d'une erreur Postgres — aligné sur `PgErrorInfo` dans
 * `packages/engine/src/errors.ts` et sur le schéma Zod `PgErrorInfoSchema`
 * du backend. `params` + `paramSpans` sont alignés positionnellement sur
 * les `$1..$N` du SQL généré : `paramSpans[i]` (si présent) pointe sur le
 * token SNQL source de `params[i]`.
 */
export interface PgErrorInfo {
	readonly message: string;
	readonly code?: string;
	readonly position?: number;
	readonly detail?: string;
	readonly hint?: string;
	readonly column?: string;
	readonly table?: string;
	readonly constraint?: string;
	readonly params?: readonly unknown[];
	readonly paramSpans?: readonly (SerializedSpan | undefined)[];
	/** Phase 3c : spans des rows d'un INSERT batch — cible la row fautive. */
	readonly rowSpans?: readonly (SerializedSpan | undefined)[];
	/**
	 * Phase 3b-lite : spans par nom d'ident (col/table/alias). Résout
	 * `column "X" does not exist` → toutes les positions de X dans la source.
	 */
	readonly identSpans?: Readonly<Record<string, readonly SerializedSpan[]>>;
}

/**
 * Erreur runtime remontée par le hook `useRunQuery` — enrichit `Error` avec
 * l'éventuel `pgError` structuré (Phase 3a). Sans `pgError` : erreur transport
 * ou HTTP non-`pg` (503 pas de tunnel, 500 interne, etc.).
 */
export class SnqlRuntimeError extends Error {
	readonly pgError?: PgErrorInfo;
	constructor(message: string, pgError?: PgErrorInfo) {
		super(message);
		this.name = "SnqlRuntimeError";
		if (pgError !== undefined) this.pgError = pgError;
	}
}

export interface RunQueryInput {
	readonly connectionId: string;
	readonly source: string;
	/** Si présent, appelle la route team-scoped ; sinon la route legacy
	 *  (transitionnel). */
	readonly teamSlug?: string | null;
}

export async function runQueryRequest(input: RunQueryInput): Promise<QueryResult> {
	// Table système `schema_events` — interceptée avant l'appel proxy. Les
	// events vivent dans le backend SQLNest (`canvas_checksum_event`), jamais
	// dans la DB user, donc l'exécution ne doit JAMAIS descendre au tunnel.
	const systemUsage = classifySchemaEventsUsage(input.source);
	if (systemUsage.kind === "write") {
		throw new SnqlRuntimeError(
			"Table système 'schema_events' en lecture seule — écriture refusée."
		);
	}
	if (systemUsage.kind === "read") {
		const page = await fetchChecksumHistory(
			input.connectionId,
			input.teamSlug ?? null,
			// v1 : les stages SNQL (where/pick/sort/limit) ne sont pas encore
			// poussés vers l'API — la table système renvoie les 50 derniers
			// events bruts. Un utilisateur qui a besoin de filtrer peut ajouter
			// un stage supplémentaire côté DS, à défaut d'un vrai lower.
			{ limit: 50 }
		);
		if (page === null) {
			throw new SnqlRuntimeError(
				"Canvas introuvable pour cette connexion — impossible de lire schema_events."
			);
		}
		return schemaEventsToQueryResult(page.entries);
	}

	const url = input.teamSlug
		? `${API_BASE}/api/teams/${encodeURIComponent(input.teamSlug)}/db-connections/${encodeURIComponent(input.connectionId)}/query`
		: `${API_BASE}/api/db-connections/${encodeURIComponent(input.connectionId)}/query`;
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		credentials: "include",
		body: JSON.stringify({ source: input.source })
	});
	const data = (await res.json().catch(() => ({}))) as QueryResult & {
		message?: string;
		pgError?: PgErrorInfo;
	};
	if (!res.ok) {
		throw new SnqlRuntimeError(
			data.message ?? `Erreur HTTP ${res.status}`,
			data.pgError
		);
	}
	return data;
}

/**
 * Exécute une requête SNQL via le proxy tunnel
 * `POST /api/db-connections/:id/query`. Le moteur (postgres / mongodb) est
 * porté par la connection elle-même — plus besoin de le passer ici.
 */
export function useRunQuery() {
	return useMutation({ mutationFn: runQueryRequest });
}
