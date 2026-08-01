import { QueryClient } from "@tanstack/react-query";

/**
 * QueryClient partagé de l'app.
 *
 * `staleTime: 60_000` par défaut — la session (via `sessionQueryOptions`) reste
 * fraîche 60s sans refetch, ce qui évite un ping /api/auth/get-session à chaque
 * navigation entre routes protégées. `refetchOnWindowFocus: false` — on ne veut
 * pas d'un flash de re-fetch au premier focus sur l'onglet ; les mutations
 * ciblées (signIn/signOut) invalideront explicitement `['auth', 'session']`.
 *
 * Ce client est **aussi** injecté dans `router.context` (cf. `main.tsx`) pour
 * que les guards `beforeLoad` puissent appeler `context.queryClient.ensureQueryData(...)`.
 */
export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 60_000,
			refetchOnWindowFocus: false
		}
	}
});
