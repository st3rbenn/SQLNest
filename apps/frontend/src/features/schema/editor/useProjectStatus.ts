import type { TunnelProjectStatusData } from "@sqlnest/tunnel-protocol";
import { useQuery } from "@tanstack/react-query";

const API_BASE = window.CONTEXT.apiBaseUrl;

export function projectStatusQueryKey(
	teamSlug: string,
	connectionId: string
): readonly [string, string, string] {
	return ["project-status", teamSlug, connectionId] as const;
}

/**
 * Projet relié à la connexion côté CLI (ADR-037 D2) : relié ou non, ORM,
 * `apply`, table d'historique. Jamais le chemin du projet.
 */
export function useProjectStatus(teamSlug: string, connectionId: string) {
	return useQuery({
		queryKey: projectStatusQueryKey(teamSlug, connectionId),
		queryFn: async (): Promise<TunnelProjectStatusData> => {
			const url = `${API_BASE}/api/teams/${encodeURIComponent(teamSlug)}/db-connections/${encodeURIComponent(connectionId)}/project-status`;
			const res = await fetch(url, { credentials: "include" });
			const data = (await res.json().catch(() => ({}))) as
				| TunnelProjectStatusData
				| { message?: string };
			if (!res.ok) {
				throw new Error(
					("message" in data ? data.message : undefined) ??
						`Statut du projet illisible (HTTP ${res.status})`
				);
			}
			return data as TunnelProjectStatusData;
		},
		retry: false,
		refetchOnWindowFocus: false
	});
}
