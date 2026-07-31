import { IconChevronDown, IconChevronUp, IconTerminal2 } from "@tabler/icons-react";
import {
	type CSSProperties,
	type KeyboardEvent,
	useEffect,
	useRef,
	useState
} from "react";
import { type QueryResult, useRunQuery } from "../query/useRunQuery";

type Engine = "postgres" | "mongodb";

const CONSOLE_LS_KEY = "sqlnest:canvas-console:source";
const CONSOLE_EXPANDED_LS_KEY = "sqlnest:canvas-console:expanded";
const CONSOLE_HEIGHT_COLLAPSED = 38;
const CONSOLE_HEIGHT_EXPANDED = 340;

const EXAMPLES: Record<Engine, string> = {
	postgres: "get users | where is_active = true | pick email, display_name",
	mongodb: 'get orders | where status = "paid" | pick user_id, total_cents'
};

interface Props {
	readonly engine: Engine;
	readonly leftOffset: number;
	readonly onHeightChange?: (h: number) => void;
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
 * - Le source est persisté en localStorage (une seule slot globale ; pas
 *   d'historique — c'est une console rapide, la page /query reste
 *   l'endroit pour les vraies sessions).
 */
export function CanvasConsole({ engine, leftOffset, onHeightChange }: Props) {
	// État `expanded` persisté en localStorage → survit au refresh.
	const [expanded, setExpanded] = useState<boolean>(() => {
		if (typeof window === "undefined") return false;
		try {
			return window.localStorage.getItem(CONSOLE_EXPANDED_LS_KEY) === "1";
		} catch {
			return false;
		}
	});
	useEffect(() => {
		if (typeof window === "undefined") return;
		try {
			window.localStorage.setItem(
				CONSOLE_EXPANDED_LS_KEY,
				expanded ? "1" : "0"
			);
		} catch {
			/* quota / private mode */
		}
	}, [expanded]);

	const [source, setSource] = useState<string>(() => {
		if (typeof window === "undefined") return EXAMPLES[engine];
		try {
			return window.localStorage.getItem(CONSOLE_LS_KEY) ?? EXAMPLES[engine];
		} catch {
			return EXAMPLES[engine];
		}
	});
	useEffect(() => {
		if (typeof window === "undefined") return;
		try {
			window.localStorage.setItem(CONSOLE_LS_KEY, source);
		} catch {
			/* quota / private mode */
		}
	}, [source]);

	const run = useRunQuery();
	const result = run.data;
	const error = run.error;

	const height = expanded ? CONSOLE_HEIGHT_EXPANDED : CONSOLE_HEIGHT_COLLAPSED;
	// Publie la hauteur au parent pour qu'il pousse la toolbar au-dessus.
	// Ref d'égalité pour éviter de re-fire si la hauteur ne change pas
	// (React n'appelle le callback qu'après commit, donc c'est safe).
	const lastHeightRef = useRef(height);
	useEffect(() => {
		if (lastHeightRef.current !== height) {
			lastHeightRef.current = height;
			onHeightChange?.(height);
		}
	}, [height, onHeightChange]);

	const execute = () => {
		if (source.trim() === "" || run.isPending) return;
		run.mutate({ engine, source });
	};

	const onEditorKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		// Cmd/Ctrl + Enter exécute.
		if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
			e.preventDefault();
			execute();
			return;
		}
		// Escape referme la console si le textarea a le focus (rapide).
		if (e.key === "Escape") {
			e.preventDefault();
			setExpanded(false);
		}
	};

	return (
		<div style={containerStyle(leftOffset, height)}>
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
					<textarea
						value={source}
						onChange={(e) => setSource(e.currentTarget.value)}
						onKeyDown={onEditorKeyDown}
						placeholder={EXAMPLES[engine]}
						spellCheck={false}
						style={editorStyle}
					/>
					<div style={actionsStyle}>
						<button
							type="button"
							onClick={execute}
							disabled={run.isPending || source.trim() === ""}
							style={runButtonStyle(run.isPending)}
						>
							{run.isPending ? "Exécution…" : "Exécuter"}
						</button>
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
	if (result.written && result.rows.length === 0) {
		return (
			<div style={placeholderStyle}>
				<b>{result.rowCount}</b> ligne(s) affectée(s) — le moteur ne renvoie
				pas les documents modifiés.
			</div>
		);
	}
	if (result.rows.length === 0) {
		return (
			<div style={placeholderStyle}>
				<b>0</b> ligne
			</div>
		);
	}
	return (
		<>
			<div style={resultHeaderStyle}>
				<b>{result.rowCount}</b> ligne{result.rowCount > 1 ? "s" : ""}
			</div>
			<div style={tableWrapperStyle}>
				<table style={tableStyle}>
					<thead>
						<tr>
							{result.columns.map((c) => (
								<th key={c.name} style={thStyle}>
									{c.name}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{result.rows.map((row, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: rows n'ont pas d'id stable
							<tr key={i}>
								{result.columns.map((c) => (
									<td key={c.name} style={tdStyle}>
										{renderCell(row[c.name])}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</>
	);
}

function renderCell(value: unknown) {
	if (value === null || value === undefined) {
		return <span style={{ color: "#cbd5e1" }}>NULL</span>;
	}
	if (typeof value === "object") {
		return <code style={{ fontSize: 11 }}>{JSON.stringify(value)}</code>;
	}
	return String(value);
}

// ─── styles ──────────────────────────────────────────────────────────
function containerStyle(leftOffset: number, height: number): CSSProperties {
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
		transition: "height 180ms ease-out",
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

const editorStyle: CSSProperties = {
	resize: "none",
	fontFamily:
		"ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
	fontSize: 13,
	lineHeight: 1.5,
	padding: "8px 10px",
	borderRadius: 6,
	border: "1px solid var(--mantine-color-slate-2, #e2e8f0)",
	background: "#fff",
	color: "#0f172a",
	minHeight: 80,
	outline: "none"
};

const actionsStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 10
};

function runButtonStyle(pending: boolean): CSSProperties {
	return {
		padding: "6px 14px",
		borderRadius: 6,
		border: "none",
		background: pending ? "#93c5fd" : "#2563eb",
		color: "#fff",
		fontWeight: 600,
		fontSize: 12,
		cursor: pending ? "default" : "pointer"
	};
}

const resultsStyle: CSSProperties = {
	flex: 1,
	overflow: "auto",
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
	fontFamily: "ui-monospace, SFMono-Regular, monospace",
	whiteSpace: "pre-wrap"
};

const resultHeaderStyle: CSSProperties = {
	fontSize: 11,
	color: "#64748b",
	margin: "4px 0 6px",
	padding: "0 4px"
};

const tableWrapperStyle: CSSProperties = {
	overflow: "auto",
	border: "1px solid var(--mantine-color-slate-2, #e2e8f0)",
	borderRadius: 6
};

const tableStyle: CSSProperties = {
	borderCollapse: "collapse",
	width: "100%",
	fontSize: 12
};

const thStyle: CSSProperties = {
	textAlign: "left",
	padding: "6px 10px",
	background: "#f8fafc",
	borderBottom: "1px solid #e2e8f0",
	fontWeight: 650,
	color: "#334155",
	whiteSpace: "nowrap"
};

const tdStyle: CSSProperties = {
	padding: "5px 10px",
	borderTop: "1px solid #f1f5f9",
	color: "#1e293b",
	whiteSpace: "nowrap"
};
