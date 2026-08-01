import { showNotification, updateNotification } from "@sqlnest/design-system";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { useEffect } from "react";
import { sessionQueryOptions } from "../features/auth/sessionQuery";
import { UserMenu } from "../features/auth/UserMenu";
import { useHealthCheck } from "../features/healthcheck/useHealthCheck";

/**
 * Layout pathless des pages **authentifiées** (canvas Schéma `/`, `/query`,
 * futures pages `/canvases`, `/settings`, …).
 *
 * Guard : `beforeLoad` charge la session via le `queryClient` du router
 * context (F2) — `ensureQueryData` hit le cache si frais (staleTime 60s),
 * sinon fetch. Si `data === null` (anonyme), on redirige vers `/login` en
 * conservant l'URL d'origine dans `search.redirect` (F8 la relit après
 * connexion pour renvoyer l'utilisateur d'où il vient).
 *
 * F10 — healthcheck : le side-effect de notification "API OK / KO" vit
 * MAINTENANT ici (et non plus dans `App.tsx`) — il n'a plus de sens sur
 * les pages `_auth` (login/signup/…), qui affichent leur propre UI de
 * connexion et n'ont rien à faire d'un ping API récurrent.
 *
 * F11 — `UserMenu` : bouton flottant top-right monté ICI (donc uniquement
 * sur pages authentifiées).
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
	const { data, error, isLoading } = useHealthCheck();

	useEffect(() => {
		if (isLoading) {
			showNotification({
				id: "health-check",
				title: "Vérification API",
				message: `Connexion à l'API en cours... (${new Date().toLocaleTimeString()})`,
				color: "blue",
				loading: true,
				autoClose: false,
				closeButtonProps: { style: { display: "none" } }
			});
		} else if (error) {
			updateNotification({
				id: "health-check",
				title: "Erreur API",
				message: `Impossible de joindre l'API à ${new Date().toLocaleTimeString()}`,
				color: "red",
				autoClose: 5000,
				loading: false
			});
		} else if (data) {
			updateNotification({
				id: "health-check",
				title: "API OK",
				message: `Connexion à l'API réussie à ${new Date().toLocaleTimeString()}`,
				color: "green",
				autoClose: 5000,
				loading: false
			});
		}
	}, [isLoading, error, data]);

	return (
		<>
			<Outlet />
			<UserMenu />
		</>
	);
}
