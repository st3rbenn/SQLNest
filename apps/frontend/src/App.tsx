import "@sqlnest/design-system/dist/design-system.css";
import { showNotification, updateNotification } from "@sqlnest/design-system";
import { useEffect } from "react";
import { useHealthCheck } from "./features/healthcheck/useHealthCheck";

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

	return <h1>SQLNest</h1>;
}

export default App;
