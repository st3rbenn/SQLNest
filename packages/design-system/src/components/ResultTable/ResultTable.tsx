import type { CSSProperties } from "react";

export interface ResultTableProps {
	readonly columns: readonly string[];
	readonly rows: readonly Record<string, unknown>[];
	/** Contrainte de hauteur du wrapper scrollable. Number → px. */
	readonly maxHeight?: number | string;
	/** Message affiché quand rows est vide (défaut : « Aucune ligne »). */
	readonly emptyMessage?: string;
}

/**
 * Tableau de résultats de requête — thead sticky, cellules monospace-friendly,
 * gestion des valeurs null / bigint / objets. Vide → message centré.
 *
 * Le wrapper est le seul scroll container : le sticky `<th>` s'y attache et
 * reste visible pendant le scroll vertical d'un gros résultat. Ne pas empiler
 * un `overflow: auto` au-dessus, sinon le header défile hors écran.
 */
export function ResultTable({
	columns,
	rows,
	maxHeight,
	emptyMessage = "Aucune ligne"
}: ResultTableProps) {
	if (rows.length === 0) {
		return (
			<div
				role="status"
				style={{
					...emptyStyle,
					...(maxHeight !== undefined ? { maxHeight } : {})
				}}
			>
				{emptyMessage}
			</div>
		);
	}

	return (
		<div
			style={{
				...wrapperStyle,
				...(maxHeight !== undefined ? { maxHeight } : {})
			}}
		>
			<table style={tableStyle}>
				<thead>
					<tr>
						{columns.map((name) => (
							<th key={name} style={thStyle}>
								{name}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((row, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: rows n'ont pas d'id stable
						<tr key={i}>
							{columns.map((name) => (
								<td key={name} style={tdStyle}>
									{renderCell(row[name])}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function renderCell(value: unknown): string {
	if (value === null || value === undefined) return "—";
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

const wrapperStyle: CSSProperties = {
	overflow: "auto",
	border: "1px solid var(--sqlnest-border)",
	borderRadius: 6,
	background: "var(--sqlnest-surface)"
};

const tableStyle: CSSProperties = {
	borderCollapse: "collapse",
	width: "100%",
	fontFamily: "var(--mantine-font-family-monospace)",
	fontSize: 12
};

const thStyle: CSSProperties = {
	textAlign: "left",
	padding: "6px 10px",
	background: "var(--sqlnest-surface-hover)",
	borderBottom: "1px solid var(--sqlnest-border)",
	fontWeight: 650,
	color: "var(--sqlnest-text-primary)",
	whiteSpace: "nowrap",
	position: "sticky",
	top: 0,
	zIndex: 1
};

const tdStyle: CSSProperties = {
	padding: "5px 10px",
	borderTop: "1px solid var(--sqlnest-border-subtle)",
	color: "var(--sqlnest-text-secondary)",
	whiteSpace: "nowrap"
};

const emptyStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	padding: "24px 16px",
	color: "var(--sqlnest-text-tertiary)",
	fontSize: 12,
	border: "1px solid var(--sqlnest-border)",
	borderRadius: 6,
	background: "var(--sqlnest-surface)"
};
