import { useLocalStorage } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { fetchChecksumHistory } from "./checksumHistoryClient";

/**
 * Compte d'événements checksum non vus depuis la dernière visite du node
 * `schema_events` d'un canvas. Le tracker vit en localStorage par
 * `connectionId` — pas de sync serveur : la sémantique « vu par cet œil,
 * sur ce device » suffit pour un badge de notification.
 *
 * Retourne :
 * - `count` : nombre d'événements avec `seenAt > lastSeenAt`. Cap à 50+
 *   (taille du batch fetché). L'user qui déplie la preview lit tout,
 *   pas besoin de compter au-delà.
 * - `markSeen()` : stamp maintenant. À appeler quand l'user ouvre la
 *   preview inline (setExpanded(true)) — le badge disparaît alors.
 *
 * Fetch gated par `enabled` externe (typiquement `connectionId` défini).
 */
export function useUnseenSchemaEvents(
	connectionId: string | null,
	teamSlug: string | null
): {
	readonly count: number;
	readonly capped: boolean;
	readonly markSeen: () => void;
} {
	const storageKey = connectionId
		? `sqlnest:schemaEvents:lastSeenAt:${connectionId}`
		: "sqlnest:schemaEvents:lastSeenAt:_null";
	const [lastSeenAt, setLastSeenAt] = useLocalStorage<string>({
		key: storageKey,
		// Première visite = aucun événement compté (l'user vient d'arriver
		// sur ce canvas, on ne le harcèle pas avec un badge pour un backlog
		// existant).
		defaultValue: new Date().toISOString(),
		getInitialValueInEffect: false
	});

	const query = useQuery({
		queryKey: ["schema-events-unseen", teamSlug, connectionId, lastSeenAt],
		enabled: connectionId !== null && teamSlug !== null,
		queryFn: async () => {
			if (connectionId === null || teamSlug === null)
				return { count: 0, capped: false };
			const page = await fetchChecksumHistory(connectionId, teamSlug, {
				limit: 50
			});
			const entries = page?.entries ?? [];
			const since = Date.parse(lastSeenAt);
			// Timestamps mal formés dans localStorage → conservateur : rien
			// n'est nouveau (évite un badge parasite après un roll de
			// localStorage buggé).
			if (Number.isNaN(since)) return { count: 0, capped: false };
			const unseen = entries.filter((e) => Date.parse(e.seenAt) > since);
			return {
				count: unseen.length,
				// Batch plein d'unseen = plafond atteint, indicateur "50+".
				capped: unseen.length >= 50
			};
		},
		// Refetch quand la page revient au premier plan — l'user peut avoir
		// laissé le canvas ouvert et voulu revenir voir l'activité.
		refetchOnWindowFocus: true,
		staleTime: 30_000
	});

	const markSeen = useCallback(() => {
		setLastSeenAt(new Date().toISOString());
	}, [setLastSeenAt]);

	return {
		count: query.data?.count ?? 0,
		capped: query.data?.capped ?? false,
		markSeen
	};
}
