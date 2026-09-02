import { useQuery } from "@tanstack/react-query";
import type { SchemaModel } from "./schema-model";

const API_BASE = window.CONTEXT.apiBaseUrl;

/**
 * Erreur d'introspection portant le `status` HTTP : permet à l'UI de distinguer
 * un **4xx** (connection invalide, auth expirée) d'un **5xx / réseau** (CLI
 * offline, timeout tunnel, base injoignable). `status: 0` = échec réseau
 * avant réponse.
 */
export class SchemaRequestError extends Error {
	readonly status: number;
	constructor(status: number, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SchemaRequestError";
		this.status = status;
	}
}

export async function fetchSchema(
	connectionId: string,
	teamSlug: string
): Promise<SchemaModel> {
	const url = `${API_BASE}/api/teams/${encodeURIComponent(teamSlug)}/db-connections/${encodeURIComponent(connectionId)}/schema`;
	let res: Response;
	try {
		res = await fetch(url, { credentials: "include" });
	} catch (cause) {
		throw new SchemaRequestError(0, "Backend injoignable", { cause });
	}
	if (!res.ok) {
		const data = (await res.json().catch(() => ({}))) as { message?: string };
		// Le message backend est déjà utile ("Aucun CLI n'est actuellement
		// connecté…", "Le CLI n'a pas répondu dans les temps (30s)…", "Erreur
		// côté CLI: …") — on le propage tel quel.
		throw new SchemaRequestError(
			res.status,
			data.message ?? `Introspection échouée (HTTP ${res.status})`
		);
	}
	return (await res.json()) as SchemaModel;
}

/**
 * Introspecte le schéma via le proxy tunnel
 * `/api/teams/:slug/db-connections/:id/schema`. `connectionId = null`
 * désactive le hook (aucune connection sélectionnée par l'UI) ;
 * `teamSlug = null` aussi (team pas encore chargée — le fetch attend le
 * slug plutôt que d'appeler une route qui n'existe pas).
 */
export function useSchema(
	connectionId: string | null,
	teamSlug: string | null
) {
	return useQuery({
		queryKey: ["schema", teamSlug, connectionId],
		queryFn: () => {
			if (connectionId === null || teamSlug === null) {
				throw new SchemaRequestError(0, "Aucune connection sélectionnée");
			}
			return fetchSchema(connectionId, teamSlug);
		},
		enabled: connectionId !== null && teamSlug !== null,
		retry: false,
		refetchOnWindowFocus: false
	});
}
