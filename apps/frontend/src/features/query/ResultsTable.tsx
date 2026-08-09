/**
 * Table de résultats virtualisée pour la console SNQL. Différent du
 * `ResultTable` du DS qui ne prend qu'un `columns: string[]` — ici on
 * accepte le shape enrichi `{name, type, nullable}` pour afficher le
 * `TypePill` dans les headers. Virtualisation via @tanstack/react-virtual
 * (row height fixe 28px) pour rester fluide au-delà de 1000 lignes.
 *
 * Sticky header via `position: sticky` sur le `<thead>` (pattern éprouvé
 * — le container `overflow: auto` fait le scroll, la header reste en
 * haut).
 */

import { TypePill } from "@sqlnest/design-system";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { CSSProperties } from "react";
import { useRef } from "react";
import type { QueryResultColumn } from "./useRunQuery";

const ROW_HEIGHT = 28;

const containerStyle: CSSProperties = {
	flex: 1,
	minHeight: 0,
	overflow: "auto",
	background: "var(--sqlnest-canvas-bg)",
	border: "1px solid var(--sqlnest-border-subtle)",
	borderRadius: 8
};

const tableStyle: CSSProperties = {
	width: "100%",
	borderCollapse: "separate",
	borderSpacing: 0,
	fontSize: 12,
	fontFamily: "var(--mantine-font-family-monospace)",
	color: "var(--sqlnest-text-primary)"
};

const theadStyle: CSSProperties = {
	position: "sticky",
	top: 0,
	zIndex: 1,
	background: "var(--sqlnest-surface-hover)"
};

const thStyle: CSSProperties = {
	textAlign: "left",
	padding: "6px 10px",
	fontSize: 10.5,
	fontWeight: 600,
	letterSpacing: 0.5,
	textTransform: "uppercase",
	color: "var(--sqlnest-text-title)",
	borderBottom: "1px solid var(--sqlnest-border)",
	whiteSpace: "nowrap"
};

const thContentStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 6
};

const tdStyle: CSSProperties = {
	padding: "5px 10px",
	borderBottom: "1px solid var(--sqlnest-border-subtle)",
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap",
	maxWidth: 400
};

const emptyStyle: CSSProperties = {
	padding: "32px",
	textAlign: "center",
	color: "var(--sqlnest-text-tertiary)",
	fontSize: 12,
	fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif"
};

function renderCell(v: unknown): string {
	if (v === null || v === undefined) return "—";
	if (typeof v === "bigint") return String(v);
	if (typeof v === "object") return JSON.stringify(v);
	return String(v);
}

export function ResultsTable({
	columns,
	rows,
	emptyMessage = "Aucune ligne"
}: {
	readonly columns: readonly QueryResultColumn[];
	readonly rows: readonly Record<string, unknown>[];
	readonly emptyMessage?: string;
}): React.ReactNode {
	const parentRef = useRef<HTMLDivElement>(null);
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => parentRef.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 8
	});

	if (rows.length === 0) {
		return (
			<div style={containerStyle}>
				<div style={emptyStyle}>{emptyMessage}</div>
			</div>
		);
	}

	const virtualRows = virtualizer.getVirtualItems();
	const totalSize = virtualizer.getTotalSize();
	const paddingTop = virtualRows[0]?.start ?? 0;
	const paddingBottom = totalSize - (virtualRows.at(-1)?.end ?? 0);

	return (
		<div ref={parentRef} style={containerStyle}>
			<table style={tableStyle}>
				<thead style={theadStyle}>
					<tr>
						{columns.map((col) => (
							<th key={col.name} style={thStyle}>
								<span style={thContentStyle}>
									<span>{col.name}</span>
									{col.type !== "unknown" ? (
										<TypePill type={col.type} nullable={col.nullable} />
									) : null}
								</span>
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{paddingTop > 0 ? (
						<tr>
							<td colSpan={columns.length} style={{ height: paddingTop }} />
						</tr>
					) : null}
					{virtualRows.map((virt) => {
						const row = rows[virt.index];
						if (row === undefined) return null;
						return (
							<tr key={virt.index} style={{ height: ROW_HEIGHT }}>
								{columns.map((col) => (
									<td
										key={col.name}
										style={tdStyle}
										title={renderCell(row[col.name])}
									>
										{renderCell(row[col.name])}
									</td>
								))}
							</tr>
						);
					})}
					{paddingBottom > 0 ? (
						<tr>
							<td colSpan={columns.length} style={{ height: paddingBottom }} />
						</tr>
					) : null}
				</tbody>
			</table>
		</div>
	);
}
