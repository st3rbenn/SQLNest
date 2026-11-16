import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { syncConnectionRegistry } from "../storage/localStore";
import { fetchDbConnections } from "./useDbConnections";

/**
 * Purge du stockage local des connexions que l'équipe n'a plus. Lit la
 * liste déjà tenue à jour par `useDbConnections` (même clé de requête, sans
 * ajouter d'intervalle) ; une liste en erreur ne purge rien.
 */
export function useConnectionRegistrySync(teamSlug: string): void {
	const { data } = useQuery({
		queryKey: ["db-connections", teamSlug],
		queryFn: () => fetchDbConnections(teamSlug),
		retry: false,
		refetchOnWindowFocus: false
	});
	const ids = data
		?.map((c) => c.id)
		.sort()
		.join(",");
	useEffect(() => {
		if (ids === undefined) return;
		syncConnectionRegistry(teamSlug, ids === "" ? [] : ids.split(","));
	}, [teamSlug, ids]);
}
