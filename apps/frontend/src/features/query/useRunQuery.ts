import { useMutation } from "@tanstack/react-query";

const API_BASE = window.CONTEXT.apiBaseUrl;

export interface QueryResult {
	readonly columns: readonly { readonly name: string }[];
	readonly rows: readonly Record<string, unknown>[];
	readonly rowCount: number;
}

export interface RunQueryInput {
	readonly engine: "postgres" | "mongodb";
	readonly source: string;
	/** Schéma cible Postgres (défaut `public`) ; omis si vide. */
	readonly schema?: string;
}

async function runQueryRequest(input: RunQueryInput): Promise<QueryResult> {
	// N'envoie `schema` que s'il est renseigné (le backend applique `public`).
	const body = input.schema
		? input
		: { engine: input.engine, source: input.source };
	const res = await fetch(`${API_BASE}/query`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body)
	});
	const data = (await res.json()) as QueryResult & { message?: string };
	if (!res.ok) {
		throw new Error(data.message ?? `Erreur HTTP ${res.status}`);
	}
	return data;
}

/** Exécute une requête SNQL via la route backend `/query`. */
export function useRunQuery() {
	return useMutation({ mutationFn: runQueryRequest });
}
