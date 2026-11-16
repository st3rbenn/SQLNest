import { Handle, type Node, type NodeProps, Position } from "@sqlnest/canvas";
import { IconTerminal2, IconX } from "@tabler/icons-react";
import { type CSSProperties, useContext } from "react";
import { useConsoleQuery } from "../../query/consoleQueriesStore";
import { ConsoleLinksContext } from "./ConsoleLinksContext";
import { RESULT_OWNER_HANDLE } from "./QueryLinkEdge";

export interface ResultNodeData {
	/** Console d'où vient le résultat. */
	readonly consoleId: string;
	readonly queryKey: string;
	readonly title: string;
	/** Requête courante de la console : différente de celle exécutée, le
	 * résultat est périmé. */
	readonly source: string;
	readonly onClose: () => void;
	readonly [key: string]: unknown;
}

export type ResultNodeType = Node<ResultNodeData, "result">;

/** Lignes montrées dans le frame ; le reste se lit dans la console. */
const MAX_ROWS = 12;

const shellStyle: CSSProperties = {
	width: "fit-content",
	minWidth: 240,
	maxWidth: 720,
	background: "var(--sqlnest-surface)",
	border: "2px solid var(--sqlnest-accent)",
	borderRadius: "var(--sqlnest-radius-10)",
	boxShadow: "var(--sqlnest-shadow-floating)",
	overflow: "hidden",
	color: "var(--sqlnest-text-primary)",
	fontFamily: "ui-sans-serif, system-ui, sans-serif"
};

const headerStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 8,
	padding: "10px 12px",
	borderBottom: "1px solid var(--sqlnest-border)",
	background: "var(--sqlnest-accent-soft)"
};

const titleStyle: CSSProperties = {
	flex: 1,
	minWidth: 0,
	fontWeight: 700,
	fontSize: "var(--sqlnest-font-size-13)",
	whiteSpace: "nowrap",
	overflow: "hidden",
	textOverflow: "ellipsis"
};

const badgeStyle = (tone: "accent" | "warning"): CSSProperties => ({
	padding: "1px 5px",
	borderRadius: "var(--sqlnest-radius-4)",
	background: `var(--sqlnest-${tone}-soft)`,
	color: `var(--sqlnest-${tone})`,
	fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif",
	fontSize: "var(--sqlnest-font-size-10)",
	fontWeight: 700,
	letterSpacing: 0.3,
	whiteSpace: "nowrap",
	textTransform: "uppercase"
});

const closeStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	justifyContent: "center",
	width: 20,
	height: 20,
	padding: 0,
	border: 0,
	borderRadius: "var(--sqlnest-radius-4)",
	background: "transparent",
	color: "var(--sqlnest-text-secondary)",
	cursor: "pointer"
};

const cellStyle: CSSProperties = {
	minWidth: 72,
	height: 20,
	padding: "0 12px",
	fontSize: "var(--sqlnest-font-size-12)",
	lineHeight: "20px",
	whiteSpace: "nowrap",
	overflow: "hidden",
	textOverflow: "ellipsis"
};

const monoStyle: CSSProperties = {
	fontFamily: "var(--mantine-font-family-monospace)"
};

function rowsLabel(count: number): string {
	return `${count} ligne${count > 1 ? "s" : ""}`;
}

function show(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

/**
 * Résultat d'une console, posé sur le canvas au format d'une table : en-tête,
 * colonnes typées, premières lignes. Il se lit dans le store de requêtes,
 * comme la console : les deux restent d'accord sans se parler.
 */
export function ResultNode({
	data
}: NodeProps<ResultNodeType>): React.ReactNode {
	const state = useConsoleQuery(data.queryKey);
	const links = useContext(ConsoleLinksContext);
	const result = state.data;
	if (result === undefined) return null;
	const folded = links !== null && !links.openIds.has(data.consoleId);
	const stale =
		state.lastSource !== undefined &&
		state.lastSource.trim() !== data.source.trim();
	const shown = result.rows.slice(0, MAX_ROWS);
	const hidden = Math.max(result.rowCount, result.rows.length) - shown.length;
	return (
		<div style={shellStyle}>
			<Handle
				id={RESULT_OWNER_HANDLE}
				type="target"
				position={Position.Top}
				isConnectable={false}
				style={{ opacity: 0, border: "none" }}
			/>
			<div style={headerStyle}>
				<span style={titleStyle}>{data.title}</span>
				{stale ? <span style={badgeStyle("warning")}>Périmé</span> : null}
				<span style={badgeStyle("accent")}>{rowsLabel(result.rowCount)}</span>
				{folded ? (
					<button
						type="button"
						className="nodrag nopan"
						style={closeStyle}
						aria-label="Ouvrir la console"
						onClick={(e) => {
							e.stopPropagation();
							links.open(data.consoleId, "inPlace");
						}}
					>
						<IconTerminal2 size={13} stroke={2} aria-hidden />
					</button>
				) : null}
				<button
					type="button"
					className="nodrag nopan"
					style={closeStyle}
					aria-label="Fermer le résultat"
					onClick={(e) => {
						e.stopPropagation();
						data.onClose();
					}}
				>
					<IconX size={13} stroke={2} aria-hidden />
				</button>
			</div>
			<div
				style={{
					display: "grid",
					gridTemplateColumns: `repeat(${result.columns.length}, fit-content(220px))`,
					padding: "4px 0"
				}}
			>
				{result.columns.map((col) => (
					<div
						key={col.name}
						style={{
							...cellStyle,
							display: "flex",
							alignItems: "center",
							gap: 6,
							marginBottom: 4,
							borderBottom: "1px solid var(--sqlnest-border-subtle)",
							height: 24
						}}
					>
						<span style={{ fontWeight: 600 }}>{col.name}</span>
						<span
							style={{
								...monoStyle,
								color: "var(--sqlnest-text-tertiary)",
								fontSize: "var(--sqlnest-font-size-11)"
							}}
						>
							{col.type}
							{col.nullable ? " ?" : ""}
						</span>
					</div>
				))}
				{shown.flatMap((row, i) =>
					result.columns.map((col) => {
						const value = row[col.name];
						return (
							<div
								// Les lignes d'un résultat n'ont pas d'identité : leur rang en tient lieu.
								key={`${i}:${col.name}`}
								style={{
									...cellStyle,
									...monoStyle,
									color:
										value === null || value === undefined
											? "var(--sqlnest-text-tertiary)"
											: "var(--sqlnest-text-secondary)"
								}}
							>
								{show(value)}
							</div>
						);
					})
				)}
			</div>
			{hidden > 0 ? (
				<div
					style={{
						padding: "0 12px 6px",
						color: "var(--sqlnest-text-tertiary)",
						fontSize: "var(--sqlnest-font-size-12)"
					}}
				>
					+{rowsLabel(hidden)}…
				</div>
			) : null}
		</div>
	);
}
