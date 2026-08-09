/**
 * Vue JSON du résultat SNQL — pré-formaté (`JSON.stringify(rows, null, 2)`)
 * dans un `<pre>` scrollable, monospace, tokens dark. V1 minimale : pas
 * de collapse tree ni de coloration syntaxique (à ajouter en V2 si un
 * signal d'usage confirme le besoin).
 */

import type { CSSProperties } from "react";

const containerStyle: CSSProperties = {
	flex: 1,
	minHeight: 0,
	overflow: "auto",
	background: "var(--sqlnest-canvas-bg)",
	border: "1px solid var(--sqlnest-border-subtle)",
	borderRadius: 8,
	padding: "10px 14px"
};

const preStyle: CSSProperties = {
	margin: 0,
	fontSize: 12,
	fontFamily: "var(--mantine-font-family-monospace)",
	color: "var(--sqlnest-text-primary)",
	whiteSpace: "pre",
	lineHeight: 1.5
};

const emptyStyle: CSSProperties = {
	padding: "32px",
	textAlign: "center",
	color: "var(--sqlnest-text-tertiary)",
	fontSize: 12
};

export function ResultsJsonView({
	rows,
	emptyMessage = "Aucune ligne"
}: {
	readonly rows: readonly Record<string, unknown>[];
	readonly emptyMessage?: string;
}): React.ReactNode {
	if (rows.length === 0) {
		return (
			<div style={containerStyle}>
				<div style={emptyStyle}>{emptyMessage}</div>
			</div>
		);
	}

	const serialized = JSON.stringify(rows, jsonReplacer, 2);
	return (
		<div style={containerStyle}>
			<pre style={preStyle}>{serialized}</pre>
		</div>
	);
}

/**
 * `bigint` n'est pas sérialisable par défaut par JSON.stringify — on le
 * ramène en string pour éviter le crash. Idem `undefined` → null visible.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
	if (typeof value === "bigint") return value.toString();
	if (value === undefined) return null;
	return value;
}
