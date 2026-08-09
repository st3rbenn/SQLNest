/**
 * Placeholder pour la vue Graph du résultat SNQL — implémentation V2
 * (voir plan). Affiché quand l'user toggle sur "Graph" pour montrer que
 * l'onglet existe et communiquer la roadmap, sans bloquer l'accès.
 */

import { IconChartBar } from "@tabler/icons-react";
import type { CSSProperties } from "react";

const containerStyle: CSSProperties = {
	flex: 1,
	minHeight: 0,
	display: "flex",
	flexDirection: "column",
	alignItems: "center",
	justifyContent: "center",
	background: "var(--sqlnest-canvas-bg)",
	border: "1px solid var(--sqlnest-border-subtle)",
	borderRadius: 8,
	padding: 32,
	gap: 12,
	color: "var(--sqlnest-text-tertiary)",
	textAlign: "center"
};

const titleStyle: CSSProperties = {
	fontSize: 13,
	fontWeight: 600,
	color: "var(--sqlnest-text-secondary)",
	margin: 0
};

const subStyle: CSSProperties = {
	fontSize: 11.5,
	margin: 0,
	maxWidth: 340,
	lineHeight: 1.5
};

export function ResultsGraphPlaceholder(): React.ReactNode {
	return (
		<div style={containerStyle}>
			<IconChartBar size={32} stroke={1.4} />
			<h3 style={titleStyle}>Graph — bientôt disponible</h3>
			<p style={subStyle}>
				Visualisation graphique des résultats (bar chart, line, scatter) — en
				attendant, la vue Table te donne toutes les données brutes.
			</p>
		</div>
	);
}
