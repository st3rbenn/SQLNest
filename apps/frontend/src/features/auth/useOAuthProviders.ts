import { useQuery } from "@tanstack/react-query";

export interface OAuthProvidersAvailability {
	readonly google: boolean;
	readonly github: boolean;
}

/**
 * Retourne les providers OAuth **configurés côté serveur** (env vars
 * `{GOOGLE,GITHUB}_CLIENT_{ID,SECRET}` non vides). Le frontend n'affiche
 * QUE les boutons pour les providers disponibles — évite qu'un user
 * clique et tombe dans une erreur Better Auth masquée par le flow
 * `window.location`.
 *
 * `staleTime: Infinity` — la config n'est pas censée changer sans
 * redémarrage backend, on ne veut pas polluer avec des refetch.
 * Fallback conservateur `{google:false, github:false}` si le backend
 * est HS : dans ce cas les boutons ne s'affichent pas du tout (mieux
 * que de proposer une redirection qui va échouer).
 */
export function useOAuthProviders(): OAuthProvidersAvailability {
	const query = useQuery({
		queryKey: ["auth", "oauth-providers"],
		queryFn: async (): Promise<OAuthProvidersAvailability> => {
			const res = await fetch(
				`${window.CONTEXT.apiBaseUrl}/api/oauth-providers`,
				{ credentials: "omit" }
			);
			if (!res.ok) {
				throw new Error(`GET /api/oauth-providers -> HTTP ${res.status}`);
			}
			return (await res.json()) as OAuthProvidersAvailability;
		},
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
		retry: false,
		refetchOnMount: false,
		refetchOnWindowFocus: false
	});
	return query.data ?? { google: false, github: false };
}
