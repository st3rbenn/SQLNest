import { useMutation } from "@tanstack/react-query";

const API_BASE = window.CONTEXT.apiBaseUrl;

export interface QueryResult {
	readonly columns: readonly { readonly name: string }[];
	readonly rows: readonly Record<string, unknown>[];
	readonly rowCount: number;
	/** `true` = écriture (lignes affectées) ; distingue d'une lecture à 0 ligne. */
	readonly written: boolean;
}

export interface RunQueryInput {
	readonly connectionId: string;
	readonly source: string;
}

async function runQueryRequest(input: RunQueryInput): Promise<QueryResult> {
	const res = await fetch(
		`${API_BASE}/api/db-connections/${encodeURIComponent(input.connectionId)}/query`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			credentials: "include",
			body: JSON.stringify({ source: input.source })
		}
	);
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
