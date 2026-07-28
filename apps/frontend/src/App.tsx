import "@sqlnest/design-system/dist/design-system.css";
import { showNotification, updateNotification } from "@sqlnest/design-system";
import { Link, Outlet } from "@tanstack/react-router";
import { type CSSProperties, useEffect } from "react";
import { useHealthCheck } from "./features/healthcheck/useHealthCheck";

const navStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 20,
	padding: "12px 28px",
	borderBottom: "1px solid #e2e8f0",
	fontFamily: "ui-sans-serif, system-ui, sans-serif"
};

const linkStyle: CSSProperties = {
	textDecoration: "none",
	color: "#64748b",
	fontWeight: 600,
	fontSize: 14
};

const activeLinkStyle: CSSProperties = { color: "#2563eb" };

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

	return (
		<>
			<nav style={navStyle}>
				<span style={{ fontWeight: 700, color: "#0f172a" }}>🦅 SQLNest</span>
				<Link
					to="/"
					style={linkStyle}
					activeProps={{ style: activeLinkStyle }}
					activeOptions={{ exact: true }}
				>
					Schéma
				</Link>
				<Link
					to="/query"
					style={linkStyle}
					activeProps={{ style: activeLinkStyle }}
				>
					Requête
				</Link>
			</nav>
			<Outlet />
		</>
	);
}

export default App;
