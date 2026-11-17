import {
	Handle,
	type Node,
	type NodeProps,
	NodeResizer,
	Position
} from "@sqlnest/canvas";
import { IconTerminal2, IconX } from "@tabler/icons-react";
import { type CSSProperties, useContext, useRef } from "react";
import { useConsoleQuery } from "../../query/consoleQueriesStore";
import type { QueryResult } from "../../query/useRunQuery";
import { useContentWheel } from "../nodes/contentWheel";
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
	/** Le frame a reçu une taille à la main : il la garde et son corps
	 * défile. Sinon il prend celle de son contenu, bornée. */
	readonly resized: boolean;
	readonly onClose: () => void;
	readonly [key: string]: unknown;
}

export type ResultNodeType = Node<ResultNodeData, "result">;

/** Lignes rendues dans le frame : au-delà, le DOM pèserait pour rien. */
const MAX_ROWS = 200;
/** Lignes visibles sans défiler tant que le frame n'a pas été redimensionné. */
const DEFAULT_VISIBLE_ROWS = 12;
const ROW_HEIGHT = 20;
const HEAD_HEIGHT = 28;
const MIN_WIDTH = 220;
const MIN_HEIGHT = 96;

const shellStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	boxSizing: "border-box",
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
	height: 20,
	padding: "0 12px",
	fontSize: "var(--sqlnest-font-size-12)",
	lineHeight: "20px",
	whiteSpace: "nowrap",
	overflow: "hidden",
	textOverflow: "ellipsis"
};

/** Corps défilant : barres fines, aux couleurs du canvas. */
const bodyStyle: CSSProperties = {
	flex: 1,
	minHeight: 0,
	overflow: "auto",
	scrollbarWidth: "thin",
	scrollbarColor: "var(--sqlnest-border) transparent",
	userSelect: "text",
	cursor: "auto"
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

/** Largeur moyenne d'un caractère : valeurs (chasse fixe, 12 px), nom de
 * colonne (gras, 12 px), type (chasse fixe, 11 px). */
const CHAR_WIDTH = 7.3;
const NAME_CHAR_WIDTH = 7.6;
const TYPE_CHAR_WIDTH = 6.7;
/** Bandeau du frame : titre, badges, bordure. */
const TITLE_HEIGHT = 41;
const CELL_PADDING = 24;

/**
 * Largeur de chaque colonne, en px. Calculée plutôt que laissée au contenu :
 * l'en-tête des colonnes vit hors de la zone qui défile, lui et les lignes
 * s'alignent parce qu'ils partagent ces largeurs.
 */
export function columnWidths(result: QueryResult): number[] {
	const sample = result.rows.slice(0, MAX_ROWS);
	return result.columns.map((col) => {
		const head =
			col.name.length * NAME_CHAR_WIDTH +
			(col.type.length + (col.nullable ? 2 : 0)) * TYPE_CHAR_WIDTH +
			6;
		const longest = sample.reduce(
			(max, row) => Math.max(max, show(row[col.name]).length),
			0
		);
		const content = Math.max(head, longest * CHAR_WIDTH) + CELL_PADDING;
		return Math.round(Math.min(220, Math.max(72, content)));
	});
}

/** Largeur du frame tant qu'il n'a pas été redimensionné. */
function naturalWidth(widths: readonly number[]): number {
	const columns = widths.reduce((total, w) => total + w, 0);
	return Math.min(720, Math.max(240, columns + 4));
}

/**
 * Taille que prend le frame d'un résultat à son apparition : de quoi lui
 * chercher une place libre sur le canvas avant même qu'il soit mesuré.
 */
export function estimateResultSize(result: QueryResult): {
	width: number;
	height: number;
} {
	const rows = Math.min(result.rows.length, DEFAULT_VISIBLE_ROWS);
	const more = Math.max(result.rowCount, result.rows.length) > MAX_ROWS;
	return {
		width: naturalWidth(columnWidths(result)),
		height:
			TITLE_HEIGHT + HEAD_HEIGHT + rows * ROW_HEIGHT + (more ? 26 : 0) + 12
	};
}

/**
 * Résultat d'une console, posé sur le canvas au format d'une table : en-tête,
 * colonnes typées, lignes. Redimensionnable ; ses lignes défilent dans les
 * deux sens sous des noms de colonnes qui, eux, ne défilent qu'à
 * l'horizontale. Il se lit dans le store de requêtes,
 * comme la console : les deux restent d'accord sans se parler.
 */
export function ResultNode({
	data
}: NodeProps<ResultNodeType>): React.ReactNode {
	const state = useConsoleQuery(data.queryKey);
	const links = useContext(ConsoleLinksContext);
	// La molette défile les lignes tant qu'il en reste sous le pointeur,
	// sinon elle déplace le canvas.
	const bodyRef = useRef<HTMLDivElement | null>(null);
	useContentWheel(bodyRef);
	const headRef = useRef<HTMLDivElement | null>(null);
	const result = state.data;
	if (result === undefined) return null;
	const folded = links !== null && !links.openIds.has(data.consoleId);
	// Tant qu'il n'a pas été redimensionné, le frame prend la taille de son
	// contenu, borné : 12 lignes de haut, 720 px de large. Ensuite il suit la
	// taille donnée et le corps défile dans les deux sens. Le moteur passe la
	// taille mesurée dans `width`/`height` : elle ne dit pas si elle a été
	// choisie, d'où `data.resized`.
	const { resized } = data;
	const stale =
		state.lastSource !== undefined &&
		state.lastSource.trim() !== data.source.trim();
	const widths = columnWidths(result);
	const template = widths.map((w) => `${w}px`).join(" ");
	const columnsWidth = widths.reduce((total, w) => total + w, 0);
	const shown = result.rows.slice(0, MAX_ROWS);
	const hidden = Math.max(result.rowCount, result.rows.length) - shown.length;
	return (
		<>
			<NodeResizer
				isVisible
				minWidth={MIN_WIDTH}
				minHeight={MIN_HEIGHT}
				lineStyle={{ borderColor: "var(--sqlnest-accent)", borderWidth: 1 }}
				handleStyle={{
					width: 10,
					height: 10,
					borderRadius: "var(--sqlnest-radius-4)",
					background: "var(--sqlnest-surface)",
					borderColor: "var(--sqlnest-accent)",
					borderWidth: 2
				}}
			/>
			<div
				style={
					resized
						? { ...shellStyle, width: "100%", height: "100%", maxWidth: "none" }
						: { ...shellStyle, width: naturalWidth(widths) }
				}
			>
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
				{/* Noms de colonnes : hors de la zone qui défile, rien ne passe
				    au-dessus. Ils suivent le défilement horizontal des lignes. */}
				<div
					ref={headRef}
					style={{
						flex: "none",
						overflow: "hidden",
						borderBottom: "1px solid var(--sqlnest-border-subtle)"
					}}
				>
					<div
						style={{
							display: "grid",
							gridTemplateColumns: template,
							// Marge à droite : la barre verticale des lignes ne doit
							// pas raccourcir la course horizontale de l'en-tête.
							width: columnsWidth + 16
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
									height: HEAD_HEIGHT - 1
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
					</div>
				</div>
				{/* `nodrag` : dans les lignes on défile et on sélectionne du
				    texte ; le frame se déplace par son en-tête. */}
				<div
					ref={bodyRef}
					className="nodrag"
					onScroll={(e) => {
						if (headRef.current !== null) {
							headRef.current.scrollLeft = e.currentTarget.scrollLeft;
						}
					}}
					style={
						resized
							? bodyStyle
							: {
									...bodyStyle,
									maxHeight: DEFAULT_VISIBLE_ROWS * ROW_HEIGHT + 8
								}
					}
				>
					<div
						style={{
							display: "grid",
							gridTemplateColumns: template,
							width: columnsWidth,
							padding: "4px 0"
						}}
					>
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
			</div>
		</>
	);
}
