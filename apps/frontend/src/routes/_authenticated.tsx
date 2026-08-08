import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { sessionQueryOptions } from "../features/auth/sessionQuery";
import { UserMenu } from "../features/auth/UserMenu";

/**
 * Layout pathless des pages **authentifiées** — gallery `/`, canvas
 * `/canvas/$connId`, query `/canvas/$connId/query`, `/pair`.
 *
 * Guard : `beforeLoad` charge la session via le `queryClient` du router
 * context (F2) — `ensureQueryData` hit le cache si frais (staleTime 60s),
 * sinon fetch. Si `data === null` (anonyme), on redirige vers `/login` en
 * conservant l'URL d'origine dans `search.redirect` (F8 la relit après
 * connexion pour renvoyer l'utilisateur d'où il vient).
 *
 * `UserMenu` : bouton flottant top-right monté ICI (donc uniquement sur
 * pages authentifiées). Caché sur `/` par le composant lui-même.
 *
 * La `db_connection` active est portée par le PATH (`$connId` du canvas)
 * — pas de search param `?conn=` global. Chaque route enfant qui a besoin
 * du connId le lit via `Route.useParams()`.
 *
 * Note : ce layout n'appelle PAS `useHealthCheck` — la notification "API
 * OK" en boucle 10s était intrusive (feedback user 2026-08-02). Un état
 * "backend down" est déjà couvert par les erreurs des queries de contenu
 * (canvas-state, schema introspection) qui affichent leur propre message.
 */
export const Route = createFileRoute("/_authenticated")({
	beforeLoad: async ({ context, location }) => {
		const session = await context.queryClient.ensureQueryData(
			sessionQueryOptions()
		);
		if (session === null) {
			throw redirect({
				to: "/login",
				search: { redirect: location.href }
			});
		}
	},
	component: AuthenticatedLayout
});

function AuthenticatedLayout() {
	return (
		<>
			<Outlet />
			<UserMenu />
		</>
	);
}
