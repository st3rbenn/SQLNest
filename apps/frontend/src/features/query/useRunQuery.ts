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
}

async function runQueryRequest(input: RunQueryInput): Promise<QueryResult> {
	const res = await fetch(`${API_BASE}/query`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input)
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
