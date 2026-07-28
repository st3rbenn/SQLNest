import { useQuery } from "@tanstack/react-query";
import type { SchemaModel } from "./schema-model";

const API_BASE = window.CONTEXT.apiBaseUrl;

async function fetchSchema(engine: string): Promise<SchemaModel> {
	const res = await fetch(`${API_BASE}/schema?engine=${engine}`);
	if (!res.ok) {
		throw new Error(`Introspection échouée (HTTP ${res.status})`);
	}
	return (await res.json()) as SchemaModel;
}

/** Introspecte le schéma du moteur via la route backend `/schema`. */
export function useSchema(engine: "postgres" | "mongodb") {
	return useQuery({
		queryKey: ["schema", engine],
		queryFn: () => fetchSchema(engine),
		retry: false,
		refetchOnWindowFocus: false
	});
}
