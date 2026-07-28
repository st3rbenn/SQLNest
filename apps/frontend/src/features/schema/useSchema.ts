import { useQuery } from "@tanstack/react-query";
import type { SchemaModel } from "./schema-model";

const API_BASE = window.CONTEXT.apiBaseUrl;

/**
 * Erreur d'introspection portant le `status` HTTP : permet à l'UI de distinguer
 * un **4xx** (schéma mal formé, entrée à corriger) d'un **5xx / réseau** (base
 * injoignable). `status: 0` = échec réseau (pas de réponse).
 */
export class SchemaRequestError extends Error {
	readonly status: number;
	constructor(status: number, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SchemaRequestError";
		this.status = status;
	}
}

async function fetchSchema(
	engine: string,
	schema?: string
): Promise<SchemaModel> {
	const params = new URLSearchParams({ engine });
	// Schéma cible Postgres — omis si vide (le backend applique `public`).
	if (schema) {
		params.set("schema", schema);
	}
	let res: Response;
	try {
		res = await fetch(`${API_BASE}/schema?${params.toString()}`);
	} catch (cause) {
		throw new SchemaRequestError(0, "Base injoignable", { cause });
	}
	if (!res.ok) {
		throw new SchemaRequestError(
			res.status,
			`Introspection échouée (HTTP ${res.status})`
		);
	}
	return (await res.json()) as SchemaModel;
}

/**
 * Introspecte le schéma du moteur via la route backend `/schema`. `schema`
 * (Postgres) cible un schéma hors `public` ; il fait partie de la clé de cache
 * pour re-fetch au changement.
 */
export function useSchema(engine: "postgres" | "mongodb", schema?: string) {
	return useQuery({
		queryKey: ["schema", engine, schema ?? ""],
		queryFn: () => fetchSchema(engine, schema),
		retry: false,
		refetchOnWindowFocus: false
	});
}
