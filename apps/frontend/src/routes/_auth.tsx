import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import {
	type SessionData,
	sessionQueryOptions
} from "../features/auth/sessionQuery";

/**
 * Layout pathless des pages **non-authentifiées** (login, signup, forgot,
 * reset, verify).
 *
 * Contrat visuel : fond canvas dark (cohérent avec le canvas principal),
 * une seule carte centrée verticalement + horizontalement, 420px max. Le
 * logo texte fait office de header en v1 — un `<img>` viendra plus tard.
 *
 * Les pages enfant rendent leur propre form + footer link (« Pas de compte ? »
 * → /signup, etc.). Ce layout ne contient PAS de switch de moteur ni de
 * healthcheck — ces bruits sont réservés aux pages authentifiées (F10).
 */
export const Route = createFileRoute("/_auth")({
	// Guard symétrique de `_authenticated` : un user connecté qui bookmark
	// `/login` (ou revient dessus par erreur) est redirigé vers son canvas.
	// On ne veut pas afficher un formulaire de login à quelqu'un qui a déjà
	// une session valide — c'est déroutant et ça facilite les erreurs
	// (double-submit, écrasement de session).
	//
	// Fail-open sur erreur réseau : si `ensureQueryData` throw (backend HS,
	// endpoint session en 500…) on affiche quand même le formulaire — sinon
	// une panne backend rendrait /login inaccessible et bloquerait le seul
	// point d'entrée pour se reconnecter.
	beforeLoad: async ({ context }) => {
		let session: SessionData = null;
		try {
			session = await context.queryClient.ensureQueryData(
				sessionQueryOptions()
			);
		} catch {
			// Anonyme par défaut si session indéterminable.
			session = null;
		}
		if (session) {
			throw redirect({ to: "/" });
		}
	},
	component: AuthLayout
});

const wrapperStyle: CSSProperties = {
	minHeight: "100vh",
	background: "var(--sqlnest-canvas-bg)",
	display: "flex",
	flexDirection: "column",
	alignItems: "center",
	justifyContent: "center",
	padding: "32px 16px"
};

const cardStyle: CSSProperties = {
	width: "100%",
	maxWidth: 420,
	background: "var(--sqlnest-surface)",
	border: "1px solid var(--sqlnest-border)",
	borderRadius: 12,
	// `clamp(min, preferred, max)` : sur un écran mobile étroit le padding
	// fixe 32px mangeait ~60% de la largeur ; sur desktop on garde 32px pour
	// respirer.
	padding: "clamp(20px, 6vw, 32px)",
	boxShadow: "0 8px 24px rgba(0, 0, 0, 0.35)"
};

const logoStyle: CSSProperties = {
	fontSize: 22,
	fontWeight: 700,
	color: "var(--sqlnest-text-primary)",
	textAlign: "center",
	margin: "0 0 24px",
	letterSpacing: "-0.01em"
};

function AuthLayout() {
	return (
		<div style={wrapperStyle}>
			<div style={cardStyle}>
				<h1 style={logoStyle}>SQLNest</h1>
				<Outlet />
			</div>
		</div>
	);
}
