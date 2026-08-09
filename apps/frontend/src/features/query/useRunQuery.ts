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

export interface RunQueryInput {
	readonly connectionId: string;
	readonly source: string;
	/** C.21.5 : si présent, appelle la route team-scoped ; sinon la
	 *  route legacy (transitionnel, supprimée en C.21.7). */
	readonly teamSlug?: string | null;
}

async function runQueryRequest(input: RunQueryInput): Promise<QueryResult> {
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
	};
	if (!res.ok) {
		throw new Error(data.message ?? `Erreur HTTP ${res.status}`);
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
