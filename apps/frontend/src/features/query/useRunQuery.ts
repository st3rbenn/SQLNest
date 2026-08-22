import { useMutation } from "@tanstack/react-query";

const API_BASE = window.CONTEXT.apiBaseUrl;

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
