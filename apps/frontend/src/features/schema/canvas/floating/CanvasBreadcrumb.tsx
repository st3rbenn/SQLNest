import type { CSSProperties } from "react";

/**
 * Fil d'ariane top-left du canvas : `{dbName} · {Engine} · N tables`.
 * Rendu inline dans le HUD flottant (drawer fermé) ou embedded dans le
 * header du DrawerPane (drawer ouvert). Rôle : centraliser l'identité
 * DB en une lecture unique — évite d'aller chercher l'engine/collections
 * dans des panneaux séparés.
 */

const separator = " · ";
const containerStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	color: "var(--sqlnest-text-primary)",
	fontSize: 13,
	fontWeight: 500,
	whiteSpace: "nowrap",
	minWidth: 0,
	overflow: "hidden"
};
const nameStyle: CSSProperties = {
	overflow: "hidden",
	textOverflow: "ellipsis"
};
const metaStyle: CSSProperties = {
	color: "var(--sqlnest-text-tertiary)",
	fontWeight: 400,
	flexShrink: 0
};

/** Formatage engine → label affichable (source cœur = lowercase). */
function formatEngine(engine: string): string {
	switch (engine) {
		case "postgres":
			return "Postgres";
		case "mongodb":
			return "MongoDB";
		default:
			return engine;
	}
}

export function CanvasBreadcrumb({
	dbName,
	engine,
	tablesCount,
	maxNameWidth = 200
}: {
	readonly dbName: string;
	readonly engine: string;
	readonly tablesCount: number;
	/** Cap largeur du nom seul (chiffre de tables + engine restent lisibles). */
	readonly maxNameWidth?: number;
}): React.ReactNode {
	const noun = tablesCount === 1 ? "table" : "tables";
	return (
		<span style={containerStyle} aria-label={`${dbName}, ${formatEngine(engine)}, ${tablesCount} ${noun}`}>
			<span style={{ ...nameStyle, maxWidth: maxNameWidth }}>{dbName}</span>
			<span style={metaStyle}>{separator}</span>
			<span style={metaStyle}>{formatEngine(engine)}</span>
			<span style={metaStyle}>{separator}</span>
			<span style={metaStyle}>
				{tablesCount} {noun}
			</span>
		</span>
	);
}
