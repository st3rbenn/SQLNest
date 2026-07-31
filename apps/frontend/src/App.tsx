import { showNotification, updateNotification } from "@sqlnest/design-system";
import { Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { useHealthCheck } from "./features/healthcheck/useHealthCheck";

/**
 * Shell minimal : plus de header/navigation top (le canvas Schéma prend
 * tout le viewport, à la Figma). Le side-effect healthcheck reste — il
 * informe l'utilisateur via `notifications` de l'état de la connexion API.
 * La navigation entre pages passera par le breadcrumb futur (cf. memory
 * `todo-canvas-breadcrumbs`) et la palette Cmd+K.
 */
function App() {
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

	return <Outlet />;
}

export default App;
