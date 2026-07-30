import { AppShell, showNotification, updateNotification } from "@sqlnest/design-system";
import { Group, Text } from "@mantine/core";
import { Link, Outlet } from "@tanstack/react-router";
import { type CSSProperties, useEffect } from "react";
import { useHealthCheck } from "./features/healthcheck/useHealthCheck";

const linkBase: CSSProperties = {
	textDecoration: "none",
	color: "var(--mantine-color-slate-5)",
	fontWeight: 600,
	fontSize: 14
};

const linkActive: CSSProperties = { color: "var(--mantine-color-brand-6)" };

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

	const header = (
		<Group gap="lg" px="lg" w="100%">
			<Text fw={700}>🦅 SQLNest</Text>
			<Link
				to="/"
				style={linkBase}
				activeProps={{ style: linkActive }}
				activeOptions={{ exact: true }}
			>
				Schéma
			</Link>
			<Link
				to="/query"
				style={linkBase}
				activeProps={{ style: linkActive }}
			>
				Requête
			</Link>
		</Group>
	);

	return (
		<AppShell header={header}>
			<Outlet />
		</AppShell>
	);
}

export default App;
