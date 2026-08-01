import { queryOptions, useQuery } from "@tanstack/react-query";
import { authClient } from "./authClient";

/**
 * Forme retournée par `authClient.getSession()`.
 *
 * Better Auth renvoie `{ data, error }` : `data` est `{ session, user }` quand
 * l'utilisateur est authentifié, `null` sinon (anonyme). On propage `null` tel
 * quel — l'absence de session **n'est pas une erreur**, c'est un état légitime
 * pour les pages publiques (`/login`, `/signup`, …). Un vrai `error` (réseau,
 * 500) doit lui remonter en `error` React Query — on `throw` alors dans queryFn.
 */
export type SessionData = Awaited<
	ReturnType<typeof authClient.getSession>
>["data"];

export const AUTH_SESSION_QUERY_KEY = ["auth", "session"] as const;

/**
 * queryOptions partagées pour la session courante.
 *
 * Utilisé à la fois par :
 * - `beforeLoad` du layout `_authenticated` (via `context.queryClient.ensureQueryData`)
 * - `useCurrentUser()` dans les composants qui doivent réagir aux changements
 *   (UserMenu, guards conditionnels côté UI, …)
 *
 * `staleTime: 0` malgré le default 60s du queryClient — trade-off perf/sécurité
 * assumé : 1 requête HEAD-like par navigation vs session révoquée non détectée
 * pendant 60s. Sans ça, `ensureQueryData` dans `beforeLoad` sert le cache
 * pendant 60s même si le backend a révoqué la session (compromission, logout
 * côté admin) → un user "logged-out" peut naviguer entre pages protégées
 * sans être bloqué. Le compromis coût/bénéfice penche fort côté sécurité
 * pour une app data-sensitive.
 */
export function sessionQueryOptions() {
	return queryOptions({
		queryKey: AUTH_SESSION_QUERY_KEY,
		queryFn: async (): Promise<SessionData> => {
			const { data, error } = await authClient.getSession();
			if (error) {
				// Un vrai échec HTTP/réseau — on laisse React Query gérer.
				throw new Error(error.message ?? "Impossible de récupérer la session.");
			}
			// `data === null` = anonyme, valeur légitime.
			return data ?? null;
		},
		staleTime: 0
	});
}

/**
 * Hook de lecture — s'abonne aux invalidations de `['auth', 'session']`.
 * Les mutations `signIn` / `signOut` devront invalider cette clé pour
 * déclencher un refresh immédiat de l'UI (UserMenu, guards).
 */
export function useCurrentUser() {
	return useQuery(sessionQueryOptions());
}
