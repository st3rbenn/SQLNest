import { useInfiniteQuery } from "@tanstack/react-query";
import { fetchChecksumHistory } from "./checksumHistoryClient";

/**
 * Charge l'historique des checksums d'un canvas par pages, cursor keyset.
 * `enabled: false` tant que connectionId absent — évite un fetch parasite au
 * mount avant que la connection soit résolue.
 */
export function useChecksumHistory(
	connectionId: string | null,
	teamSlug: string | null,
	options: { readonly enabled?: boolean } = {}
) {
	return useInfiniteQuery({
		queryKey: ["checksum-history", teamSlug, connectionId],
		enabled: connectionId !== null && options.enabled !== false,
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) => {
			if (connectionId === null) throw new Error("connectionId required");
			return fetchChecksumHistory(connectionId, teamSlug, {
				...(pageParam !== undefined ? { cursor: pageParam } : {}),
				limit: 50
			});
		},
		getNextPageParam: (last) => last?.nextCursor ?? undefined,
		staleTime: 30_000
	});
}
