import type { CSSProperties } from "react";

const veil: CSSProperties = {
	position: "absolute",
	inset: 0,
	background: "var(--sqlnest-canvas-bg)"
};

/**
 * Fonds opaques posés sur le canvas tant qu'il n'est pas montrable :
 * - layout en cours de calcul : le canvas apparaît d'un coup, sans texte
 *   d'attente ;
 * - état serveur pas encore appliqué : sans ce fond, on verrait l'état
 *   local puis un saut à l'arrivée du serveur.
 */
export function CanvasVeil({
	layoutPending,
	syncing
}: {
	readonly layoutPending: boolean;
	readonly syncing: boolean;
}) {
	return (
		<>
			{layoutPending ? (
				<div style={{ ...veil, pointerEvents: "none", zIndex: 3 }} />
			) : null}
			{syncing ? <div style={{ ...veil, zIndex: 100 }} /> : null}
		</>
	);
}

const showAll: CSSProperties = {
	border: "1px solid var(--sqlnest-border)",
	background: "var(--sqlnest-surface)",
	color: "var(--sqlnest-accent)",
	fontWeight: 600,
	fontSize: "var(--sqlnest-font-size-12)",
	padding: "6px 12px",
	borderRadius: "var(--sqlnest-radius-8)",
	cursor: "pointer",
	boxShadow: "0 2px 8px rgba(0,0,0,0.32)"
};

/** Lève le focus d'une table : le reste du canvas n'est plus estompé. */
export function ShowAllButton({ onClick }: { readonly onClick: () => void }) {
	return (
		<button type="button" onClick={onClick} style={showAll}>
			↺ tout afficher
		</button>
	);
}
