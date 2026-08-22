/**
 * Hook TanStack — liste des teams de l'user (owner). Utilisé par
 * `TeamSelector` (sidebar dropdown).
 */

import { useQuery } from "@tanstack/react-query";
import { fetchMyTeams, type TeamSummary } from "./teamsClient";

export function useMyTeams() {
	return useQuery<readonly TeamSummary[]>({
		queryKey: ["teams", "me"],
		queryFn: fetchMyTeams,
		staleTime: 60_000,
		refetchOnWindowFocus: false
	});
}
