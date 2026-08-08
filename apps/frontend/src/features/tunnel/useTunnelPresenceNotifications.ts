import { useEffect, useRef } from "react";
import { useDbConnections } from "../db-connections/useDbConnections";
import { notifyInfo, notifySuccess } from "../notifications/notify";
import { useCurrentTeamSlug } from "../teams/useCurrentTeam";

/**
 * Track les transitions `isOnline` sur les db_connection de la team
 * courante et émet une notification Mantine à chaque changement :
 *   - `false → true` : « Tunnel <name> connecté »
 *   - `true → false` : « Tunnel <name> déconnecté »
 *
 * Le poll `refetchInterval: 5s` de `useDbConnections` alimente la
 * détection — donc latence ~0-5s après l'événement réel côté backend.
 *
 * Design :
 *   - Skip la 1re passe pour éviter le spam au mount (l'user voit
 *     l'état initial dans la gallery, pas besoin de N notifs pour
 *     dire « apollon est en ligne » alors qu'il vient d'arriver).
 *   - Les nouvelles connections apparaissant après le mount initial
 *     (ex. fresh pair) sont trackées mais ne notify pas leur état
 *     initial — même raison.
 *   - État précédent stocké en ref pour éviter les re-renders.
 *
 * À monter UNE SEULE FOIS dans le tree (voir
 * `TunnelPresenceListener` dans `_authenticated.tsx`).
 */
export function useTunnelPresenceNotifications(): void {
	const teamSlug = useCurrentTeamSlug();
	const { data: connections } = useDbConnections(teamSlug);
	const previousStates = useRef<Map<string, boolean>>(new Map());
	const initialized = useRef(false);

	useEffect(() => {
		if (connections === undefined) return;

		if (!initialized.current) {
			for (const c of connections) {
				previousStates.current.set(c.id, c.isOnline);
			}
			initialized.current = true;
			return;
		}

		for (const c of connections) {
			const prev = previousStates.current.get(c.id);
			if (prev === undefined) {
				// Nouvelle connection découverte post-mount (ex. après pair) →
				// track sans notifier son état initial.
				previousStates.current.set(c.id, c.isOnline);
				continue;
			}
			if (prev === false && c.isOnline === true) {
				notifySuccess(`Tunnel ${c.name} connecté`);
			} else if (prev === true && c.isOnline === false) {
				notifyInfo(`Tunnel ${c.name} déconnecté`);
			}
			previousStates.current.set(c.id, c.isOnline);
		}

		// Cleanup : retire les entries des connections supprimées côté backend
		// (ex. après un `sqlnest revoke-connection`) pour éviter que la Map
		// grandisse à l'infini.
		const currentIds = new Set(connections.map((c) => c.id));
		for (const id of previousStates.current.keys()) {
			if (!currentIds.has(id)) previousStates.current.delete(id);
		}
	}, [connections]);
}
