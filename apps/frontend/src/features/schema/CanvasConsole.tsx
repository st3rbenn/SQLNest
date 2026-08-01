import { ActionIcon, Menu, Tooltip } from "@mantine/core";
import { Button, ResultTable } from "@sqlnest/design-system";
import {
	IconChevronDown,
	IconChevronUp,
	IconHistory,
	IconTerminal2
} from "@tabler/icons-react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { SnqlEditor } from "../query/SnqlEditor";
import { type QueryResult, useRunQuery } from "../query/useRunQuery";
import { ConsoleResizeHandle } from "./console/ConsoleResizeHandle";
import {
	consoleExampleFor,
	useConsolePersistence
} from "./console/useConsolePersistence";
import type { SchemaModel } from "./schema-model";

type Engine = "postgres" | "mongodb";

const CONSOLE_HEIGHT_COLLAPSED = 38;

interface Props {
	readonly engine: Engine;
	readonly leftOffset: number;
	readonly onHeightChange?: (h: number) => void;
	/** Schéma courant → autocomplete des noms de tables/colonnes dans l'éditeur.
	 * Facultatif : sans schéma, l'éditeur reste utilisable mais sans completion. */
	readonly schema?: SchemaModel | undefined;
}

/**
 * Console SNQL escamotable en bas du canvas.
 * - Header cliquable (40 px) qui bascule l'état expanded.
 * - Corps expanded : textarea SNQL + bouton Run + résultat inline (tableau
 *   compact ou message d'erreur). Cmd/Ctrl + Enter exécute.
 * - `leftOffset` = largeur du drawer docké à gauche → la console commence
 *   à sa droite, s'étend jusqu'au bord droit du canvas.
 * - `onHeightChange` informe le parent (SchemaCanvas) de la hauteur
 *   courante — pour ajuster le bottom-offset de la toolbar afin qu'elle
 *   reste au-dessus quand la console s'ouvre.
 * - Source / hauteur / historique persistés en localStorage via
 *   `useConsolePersistence` — une seule slot globale.
 */
export function CanvasConsole({
	engine,
	leftOffset,
	onHeightChange,
	schema
}: Props) {
	// État `expanded` volatile — reset au refresh. La persistance était
	// plus embêtante qu'utile : à chaque refresh la console revenait ouverte
	// même si l'utilisateur ne voulait pas la voir.
	const [expanded, setExpanded] = useState(false);
	const [isResizing, setIsResizing] = useState(false);

	const {
		source,
		setSource,
		height: expandedHeight,
		setHeight: setExpandedHeight,
		history,
		addHistory,
		clearHistory
	} = useConsolePersistence(engine);

	const run = useRunQuery();
	const result = run.data;
	const error = run.error;

	const height = expanded ? expandedHeight : CONSOLE_HEIGHT_COLLAPSED;

	// Publie la hauteur au parent pour qu'il pousse la toolbar au-dessus.
	// Ref d'égalité pour éviter de re-fire si la hauteur ne change pas.
	const lastHeightRef = useRef(height);
	useEffect(() => {
		if (lastHeightRef.current !== height) {
			lastHeightRef.current = height;
			onHeightChange?.(height);
		}
	}, [height, onHeightChange]);

	const execute = () => {
		const q = source.trim();
		if (q === "" || run.isPending) return;
		addHistory(q);
		run.mutate({ engine, source });
	};

	return (
		<div style={containerStyle(leftOffset, height, isResizing)}>
			{expanded ? (
				<ConsoleResizeHandle
					height={expandedHeight}
					onHeightChange={setExpandedHeight}
					onResizingChange={setIsResizing}
				/>
			) : null}
			<button
				type="button"
				onClick={() => setExpanded((x) => !x)}
				style={headerStyle}
				aria-expanded={expanded}
				aria-controls="canvas-console-body"
			>
				<span style={headerLabelStyle}>
					<IconTerminal2 size={16} />
					Console SNQL
				</span>
				<span style={headerHintStyle}>
					{expanded ? "Cmd+Enter pour exécuter" : "Cliquer pour ouvrir"}
				</span>
				{expanded ? <IconChevronDown size={16} /> : <IconChevronUp size={16} />}
			</button>
			{expanded ? (
				<div id="canvas-console-body" style={bodyStyle}>
					<div style={editorWrapperStyle}>
						<SnqlEditor
							value={source}
							onChange={setSource}
							onRun={execute}
							schema={schema}
							placeholder={consoleExampleFor(engine)}
						/>
					</div>
					<div style={actionsStyle}>
						<Button
							size="xs"
							onClick={execute}
							disabled={source.trim() === ""}
							loading={run.isPending}
							loadingLabel="Exécution…"
						>
							Exécuter
						</Button>
						<Menu
							shadow="md"
							width={440}
							position="top-start"
							withArrow
							disabled={history.length === 0}
						>
							<Menu.Target>
								<Tooltip
									label="Historique"
									openDelay={400}
									fz={11}
									px={6}
									py={2}
									withArrow
									arrowSize={4}
								>
									<ActionIcon
										variant="subtle"
										color="gray"
										size="lg"
										disabled={history.length === 0}
										aria-label="Historique des requêtes"
									>
										<IconHistory size={16} />
									</ActionIcon>
								</Tooltip>
							</Menu.Target>
							<Menu.Dropdown>
								{history.map((q) => (
									<Menu.Item
										key={q}
										onClick={() => setSource(q)}
										style={historyItemStyle}
									>
										{q.length > 90 ? `${q.slice(0, 87)}…` : q}
									</Menu.Item>
								))}
								<Menu.Divider />
								<Menu.Item color="red" onClick={clearHistory}>
									Vider l'historique
								</Menu.Item>
							</Menu.Dropdown>
						</Menu>
					</div>
					<div style={resultsStyle}>
						{error ? (
							<div style={errorStyle}>{error.message}</div>
						) : result ? (
							<ResultView result={result} />
						) : (
							<div style={placeholderStyle}>
								Aucun résultat pour l'instant. Tape une requête et Cmd+Enter.
							</div>
						)}
					</div>
				</div>
			) : null}
		</div>
	);
}

function ResultView({ result }: { result: QueryResult }) {
	const columnNames = useMemo(
		() => result.columns.map((c) => c.name),
		[result.columns]
	);
	if (result.written && result.rows.length === 0) {
		return (
			<div style={placeholderStyle}>
				<b>{result.rowCount}</b> ligne(s) affectée(s) — le moteur ne renvoie
				pas les documents modifiés.
			</div>
		);
	}
	return (
		<>
			<div style={resultHeaderStyle}>
				<b>{result.rowCount}</b> ligne{result.rowCount > 1 ? "s" : ""}
			</div>
			<div style={resultTableWrapperStyle}>
				<ResultTable
					columns={columnNames}
					rows={result.rows}
					maxHeight="100%"
					emptyMessage="0 ligne"
				/>
			</div>
		</>
	);
}

// ─── styles ──────────────────────────────────────────────────────────
function containerStyle(
	leftOffset: number,
	height: number,
	isResizing: boolean
): CSSProperties {
	return {
		position: "absolute",
		left: leftOffset,
		right: 8,
		bottom: 8,
		height,
		background: "#fff",
		border: "1px solid var(--mantine-color-slate-2, #e2e8f0)",
		borderRadius: 10,
		boxShadow: "0 -4px 16px rgba(15,23,42,0.08)",
		overflow: "hidden",
		transition: isResizing ? "none" : "height 180ms ease-out",
		zIndex: 5,
		display: "flex",
		flexDirection: "column"
	};
}

const headerStyle: CSSProperties = {
	all: "unset",
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	gap: 12,
	padding: "8px 14px",
	height: 38,
	boxSizing: "border-box",
	cursor: "pointer",
	borderBottom: "1px solid var(--mantine-color-slate-1, #f1f5f9)",
	color: "var(--mantine-color-slate-7, #334155)",
	fontSize: 12,
	fontWeight: 600,
	background: "var(--mantine-color-slate-0, #f8fafc)"
};

const headerLabelStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 8
};

const headerHintStyle: CSSProperties = {
	marginLeft: "auto",
	marginRight: 8,
	fontSize: 11,
	fontWeight: 400,
	color: "var(--mantine-color-slate-5, #64748b)"
};

const bodyStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	flex: 1,
	minHeight: 0,
	padding: 10,
	gap: 8
};

// SnqlEditor a son propre habillage (bord, radius, thème). Le wrapper impose
// juste la contrainte flex : `flex: 0 0 auto` sinon CodeMirror voudrait
// s'étirer au max et écraserait le bloc résultat.
const editorWrapperStyle: CSSProperties = {
	flex: "0 0 auto"
};

const actionsStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 10
};

const historyItemStyle: CSSProperties = {
	fontFamily: "var(--mantine-font-family-monospace)",
	fontSize: 11.5,
	color: "#334155",
	whiteSpace: "nowrap",
	overflow: "hidden",
	textOverflow: "ellipsis"
};

const resultsStyle: CSSProperties = {
	flex: 1,
	minHeight: 0,
	// Overflow HIDDEN ici, pas auto — sinon le sticky `<th>` s'attache
	// à `tableWrapperStyle` qui scrolle avec `resultsStyle`, résultat :
	// le header défile hors écran. Un seul scroll container = celui du
	// tableWrapper (voir `tableWrapperStyle`).
	overflow: "hidden",
	display: "flex",
	flexDirection: "column",
	borderTop: "1px solid var(--mantine-color-slate-1, #f1f5f9)",
	paddingTop: 8
};

const placeholderStyle: CSSProperties = {
	color: "#94a3b8",
	fontSize: 12,
	padding: "8px 4px"
};

const errorStyle: CSSProperties = {
	background: "#fef2f2",
	color: "#b91c1c",
	padding: "8px 10px",
	borderRadius: 6,
	fontSize: 12,
	fontFamily: "var(--mantine-font-family-monospace)",
	whiteSpace: "pre-wrap"
};

const resultHeaderStyle: CSSProperties = {
	fontSize: 11,
	color: "#64748b",
	margin: "4px 0 6px",
	padding: "0 4px"
};

// Wrapper qui donne à <ResultTable maxHeight="100%"> une hauteur bornée dans
// la flex column parent — sinon `overflow: auto` du composant DS ne scrolle
// pas (contenu sans borne). `minHeight: 0` casse l'implicit min-content.
const resultTableWrapperStyle: CSSProperties = {
	flex: 1,
	minHeight: 0,
	display: "flex",
	flexDirection: "column"
};
