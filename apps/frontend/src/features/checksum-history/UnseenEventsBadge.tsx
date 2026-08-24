import type { CSSProperties } from "react";

/**
 * Badge pastille « N » d'événements checksum non vus, overlay top-right
 * du node système `schema_events`. Rendu absolu depuis le shell du node
 * (parent doit être `position: relative`). Disparaît quand l'user ouvre
 * la preview inline (`useUnseenSchemaEvents.markSeen`).
 *
 * `capped=true` → affiche « 50+ » (le fetch cape à 50 rows).
 */

const style: CSSProperties = {
	position: "absolute",
	top: -8,
	right: -8,
	minWidth: 20,
	height: 20,
	padding: "0 6px",
	display: "inline-flex",
	alignItems: "center",
	justifyContent: "center",
	borderRadius: 10,
	background: "var(--sqlnest-danger)",
	color: "#fff",
	fontSize: 11,
	fontWeight: 700,
	fontFamily: "ui-sans-serif, system-ui, sans-serif",
	letterSpacing: 0.2,
	boxShadow: "0 1px 3px rgba(0,0,0,0.5)",
	// Interdit d'intercepter le drag/click du node — la pastille est
	// décorative, l'action est le bouton « Voir les événements ».
	pointerEvents: "none",
	// Reste stable au zoom canvas (RF re-transform le node, pas la pastille
	// qui suit la taille CSS du parent).
	zIndex: 2
};

export function UnseenEventsBadge({
	count,
	capped
}: {
	readonly count: number;
	readonly capped: boolean;
}): React.ReactNode {
	if (count <= 0) return null;
	const label = capped ? "50+" : String(count);
	return (
		<output
			aria-label={`${label} événement${count > 1 ? "s" : ""} non vu${count > 1 ? "s" : ""}`}
			style={style}
		>
			{label}
		</output>
	);
}
