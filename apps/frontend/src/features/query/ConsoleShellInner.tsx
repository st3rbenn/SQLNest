/**
 * Corps de la console SNQL — la même mécanique tabs / éditeur / résultats
 * / split-resize que la page fullscreen, mais SANS le wrapper
 * `position: fixed; inset: 0`. Utilisé par :
 *
 *   - `ConsolePage` (route `/query`) : wrap dans un shell fullscreen.
 *   - `ConsoleNode` (node React Flow T5) : wrap dans un node canvas.
 *
 * Le shell parent fournit la surface (fullscreen ou node) et les
 * hotkeys qui dépendent du contexte (Escape back, ⌘⇧K détacher). Cet
 * inner ne gère que ce qui est commun aux deux modes : ⌘T / ⌘W tabs,
 * ⌘⇧F format, ⌘⏎ run via SnqlEditor keymap.
 *
 * ─── Variantes ─────────────────────────────────────────────────────────
 *   variant="route"  → header standard (Back Canvas / Fermer + Détacher),
 *                       parent gère la nav via `onDetach`.
 *   variant="node"   → header sans Back/Détacher, parent injecte
 *                       `extraLeftActions` (bouton Focus/Collapse T5).
 *
 * ─── Isolation multi-instances ────────────────────────────────────────
 * `tabsScopeSuffix` (optionnel) permet à plusieurs consoles sur la même
 * connexion (ex : plusieurs nodes T5 dans le canvas) d'avoir chacune
 * leurs tabs propres. Sans suffix, comportement legacy — une console
 * partagée par connId.
 */

import { useHotkeys, useLocalStorage } from "@mantine/hooks";
import { formatSnql } from "@sqlnest/snql";
import {
	type CSSProperties,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState
} from "react";
import { useDbConnections } from "../db-connections/useDbConnections";
import { useConsolePersistence } from "../schema/console/useConsolePersistence";
import { useSchema } from "../schema/useSchema";
import { runConsoleQuery, useConsoleQuery } from "./consoleQueriesStore";
import { ConsoleHeader, type ConsoleHeaderVariant } from "./ConsoleHeader";
import { ConsoleResultsPanel } from "./ConsoleResultsPanel";
import { SnqlEditor, type SnqlEditorHandle } from "./SnqlEditor";
import { useConsoleTabs } from "./useConsoleTabs";
import { useLiveDiagnostics } from "./useLiveDiagnostics";
import { type SerializedSpan, SnqlRuntimeError } from "./useRunQuery";

/**
 * Type guard défensif : la source pgError peut avoir été sérialisée par
 * msgpackr ou Zod et remonter un span mal formé (`null`, tuple d'arité
 * différente, valeurs non numériques). Filtre au point de consommation
 * plutôt que d'assumer la shape.
 */
function isSerializedSpan(value: unknown): value is SerializedSpan {
	return (
		Array.isArray(value) &&
		value.length === 2 &&
		typeof value[0] === "number" &&
		typeof value[1] === "number"
	);
}

const SPLIT_STORAGE_KEY = "sqlnest.console.editorHeight";
const SPLIT_MIN_TOP = 120;
const SPLIT_MIN_BOTTOM = 200;
const SPLIT_DEFAULT = 220;

const shellStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	width: "100%",
	height: "100%",
	background: "var(--sqlnest-canvas-bg)",
	color: "var(--sqlnest-text-primary)",
	fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif",
	overflow: "hidden"
};

const bodyStyle: CSSProperties = {
	flex: 1,
	display: "flex",
	flexDirection: "column",
	minHeight: 0
};

const editorWrapperStyle: CSSProperties = {
	background: "var(--sqlnest-canvas-bg)",
	overflow: "hidden",
	minHeight: SPLIT_MIN_TOP,
	display: "flex",
	flexDirection: "column"
};

const editorFillStyle: CSSProperties = {
	flex: 1,
	minHeight: 0,
	display: "flex",
	flexDirection: "column"
};

const resizeHandleStyle: CSSProperties = {
	height: 4,
	cursor: "ns-resize",
	background: "var(--sqlnest-border-subtle)",
	transition: "background-color 120ms ease",
	flexShrink: 0
};

export interface ConsoleShellInnerProps {
	readonly teamSlug: string;
	readonly connId: string;
	readonly initialSource?: string;
	readonly initialAutorun?: boolean;
	/** Variante du header — voir le doc du fichier. */
	readonly variant?: ConsoleHeaderVariant;
	/** Détacher = popout. Requis en `route`, ignoré en `node`. */
	readonly onDetach?: () => void;
	/** Popout window flag — propagé au header (label "Fermer" au lieu de
	 * "Canvas" en variant route). Non pertinent en `node`. */
	readonly isPopout?: boolean;
	/** Slot pour actions en-tête gauche (utilisé par ConsoleNode pour le
	 * bouton Focus/Collapse). */
	readonly extraLeftActions?: React.ReactNode;
	/** Isole les tabs de cette instance — voir useConsoleTabs. */
	readonly tabsScopeSuffix?: string;
}

export function ConsoleShellInner({
	teamSlug,
	connId,
	initialSource,
	initialAutorun,
	variant = "route",
	onDetach,
	isPopout = false,
	extraLeftActions,
	tabsScopeSuffix
}: ConsoleShellInnerProps): React.ReactNode {
	const { data: connections } = useDbConnections(teamSlug);
	const connection = useMemo(
		() => connections?.find((c) => c.id === connId),
		[connections, connId]
	);
	const engine = connection?.engine ?? "postgres";

	const schemaQuery = useSchema(connId, teamSlug);

	const tabs = useConsoleTabs(connId, tabsScopeSuffix);
	const persistence = useConsolePersistence(engine);

	// La query state vit dans un store singleton (voir consoleQueriesStore)
	// pour survivre au remount du shell — sinon le switch fullscreen ↔ normal
	// (portal T5) tuerait la mutation en cours. Key stable par (connId,
	// scope de node éventuel, tab actif) : chaque tab a son propre run state.
	const activeTabIdEarly = tabs.activeTab.id;
	const queryKey = useMemo(
		() =>
			tabsScopeSuffix
				? `${connId}:${tabsScopeSuffix}:${activeTabIdEarly}`
				: `${connId}:${activeTabIdEarly}`,
		[connId, tabsScopeSuffix, activeTabIdEarly]
	);
	const queryState = useConsoleQuery(queryKey);

	// Split resize state (persisted, partagé entre toutes les instances —
	// c'est un préférence globale de layout console, pas per-instance).
	const [editorHeight, setEditorHeight] = useLocalStorage<number>({
		key: SPLIT_STORAGE_KEY,
		defaultValue: SPLIT_DEFAULT,
		getInitialValueInEffect: false
	});
	const [isDragging, setIsDragging] = useState(false);
	const bodyRef = useRef<HTMLDivElement>(null);

	function startDrag(e: React.PointerEvent<HTMLDivElement>): void {
		e.preventDefault();
		setIsDragging(true);
	}

	useEffect(() => {
		if (!isDragging) return;
		function onMove(e: PointerEvent): void {
			const rect = bodyRef.current?.getBoundingClientRect();
			if (!rect) return;
			const nextTop = e.clientY - rect.top;
			const maxTop = rect.height - SPLIT_MIN_BOTTOM;
			const clamped = Math.max(SPLIT_MIN_TOP, Math.min(maxTop, nextTop));
			setEditorHeight(clamped);
		}
		function onUp(): void {
			setIsDragging(false);
		}
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
	}, [isDragging, setEditorHeight]);

	const activeTabId = tabs.activeTab.id;
	const activeSource = tabs.activeTab.source;

	// Live diagnostic : compile local debounced pendant la frappe. Passé à
	// l'éditeur pour squigglies + gutter badge + tooltip au hover. Zero I/O.
	const liveDiagnostic = useLiveDiagnostics(
		activeSource,
		engine,
		schemaQuery.data ?? undefined
	);

	const editorRef = useRef<SnqlEditorHandle>(null);

	// Extrait tous les spans source SNQL du pgError courant → alimente les
	// squigglies dans l'éditeur. Trois sources :
	//  - Phase 3a : `paramSpans[N-1]` pour chaque `$N` référencé dans le message.
	//  - Phase 3b-lite : `identSpans[column]` (toutes les occurrences) quand
	//    l'erreur pointe une colonne inexistante.
	//  - Phase 3c : `rowSpans` sur violation unique/FK (SQLSTATE 23xxx).
	const errorSpans = useMemo<readonly SerializedSpan[]>(() => {
		const err = queryState.error;
		if (!(err instanceof SnqlRuntimeError) || err.pgError == null) return [];
		const pg = err.pgError;
		const collected: SerializedSpan[] = [];
		// Filtre défensif — msgpackr / Zod optional peuvent remonter `null` en
		// place d'un span absent ; on ne veut ni null ni tuple mal formé.

		// (a) Uniquement les $N réellement mentionnés dans le message (pas TOUS
		// les params bindés — un `column does not exist` ne concerne pas les
		// littéraux WHERE/LIMIT). Le message peut référencer $2 sans $1 → on
		// dédup + suit l'ordre d'apparition.
		if (typeof pg.message === "string" && Array.isArray(pg.paramSpans)) {
			const seenIdx = new Set<number>();
			for (const match of pg.message.matchAll(/\$(\d+)/g)) {
				const idx = Number.parseInt(match[1] ?? "", 10);
				if (!Number.isFinite(idx) || idx <= 0 || seenIdx.has(idx)) continue;
				seenIdx.add(idx);
				const span = pg.paramSpans[idx - 1];
				if (isSerializedSpan(span)) collected.push(span);
			}
		}

		// (b) Idents quotés dans le message (`column "foo" does not exist`,
		// `relation "bar" does not exist`, `operator does not exist: text = int`)
		// → résolution via identSpans + éventuellement pgError.column/table si
		// pg l'a rempli en plus.
		if (pg.identSpans != null && typeof pg.identSpans === "object") {
			const identNames = new Set<string>();
			if (typeof pg.message === "string") {
				for (const match of pg.message.matchAll(/"([^"]+)"/g)) {
					if (match[1] !== undefined) identNames.add(match[1]);
				}
			}
			if (typeof pg.column === "string") identNames.add(pg.column);
			if (typeof pg.table === "string") identNames.add(pg.table);
			for (const name of identNames) {
				const spans = (pg.identSpans as Record<string, unknown>)[name];
				if (!Array.isArray(spans)) continue;
				for (const s of spans) if (isSerializedSpan(s)) collected.push(s);
			}
		}

		// (c) Rows d'un batch INSERT sur violation contrainte (SQLSTATE 23xxx).
		if (pg.code?.startsWith("23") === true && Array.isArray(pg.rowSpans)) {
			for (const s of pg.rowSpans) if (isSerializedSpan(s)) collected.push(s);
		}

		return collected;
	}, [queryState.error]);

	const onFocusSpan = useCallback((span: SerializedSpan) => {
		editorRef.current?.focusSpan(span);
	}, []);

	// Le panel results n'apparaît qu'après la première interaction avec la
	// query (pending, résultat ou erreur). Avant : l'éditeur prend tout
	// l'espace pour ne pas polluer visuellement.
	const hasRun =
		queryState.isPending ||
		queryState.data !== undefined ||
		queryState.error !== null;

	// Injection depuis les search params ?source= (avant tout run éventuel).
	// Le hook n'écrase que si le tab actif est vide (évite d'effacer un
	// travail en cours).
	useEffect(() => {
		if (initialSource && activeSource === "") {
			tabs.updateSource(activeTabId, initialSource);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const execute = useCallback(() => {
		const src = tabs.activeTab.source.trim();
		if (src === "") return;
		// Fire-and-forget : le store est notify des changes de state, le
		// useEffect ci-dessous propage vers `tabs.setLastResult` +
		// `persistence.addHistory` au done.
		void runConsoleQuery(queryKey, {
			connectionId: connId,
			source: src,
			teamSlug
		});
	}, [tabs, connId, teamSlug, queryKey]);

	// Side-effects post-run — quand une run termine (success ou error), on
	// propage vers `tabs.setLastResult` (rowCount + timing dans la tab bar)
	// et `persistence.addHistory` (only success). Le trigger est le change
	// de `lastRunAt` — set par le store à chaque done. `lastHandledRunAtRef`
	// évite de re-fire si le shell remount avec le state existant.
	const lastHandledRunAtRef = useRef<number | undefined>(undefined);
	useEffect(() => {
		const runAt = queryState.lastRunAt;
		if (runAt === undefined) return;
		if (lastHandledRunAtRef.current === runAt) return;
		lastHandledRunAtRef.current = runAt;
		if (queryState.data && queryState.timingMs !== undefined) {
			tabs.setLastResult(activeTabId, {
				rowCount: queryState.data.rowCount,
				timingMs: queryState.timingMs
			});
			if (queryState.lastSource !== undefined) {
				persistence.addHistory(queryState.lastSource);
			}
		}
	}, [
		queryState.lastRunAt,
		queryState.data,
		queryState.timingMs,
		queryState.lastSource,
		tabs,
		activeTabId,
		persistence
	]);

	const format = useCallback(() => {
		const src = tabs.activeTab.source;
		if (src.trim() === "") return;
		const formatted = formatSnql(src);
		if (formatted !== src) {
			tabs.updateSource(activeTabId, formatted);
		}
	}, [tabs, activeTabId]);

	// Autorun depuis ?autorun=1 — one-shot au mount.
	const autoranRef = useRef(false);
	useEffect(() => {
		if (
			initialAutorun &&
			!autoranRef.current &&
			tabs.activeTab.source.trim() !== ""
		) {
			autoranRef.current = true;
			execute();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [initialAutorun, tabs.activeTab.source]);

	// Hotkeys communs aux deux variants. Escape et mod+shift+K sont
	// laissés au parent (dépendent du contexte route vs node).
	useHotkeys(
		[
			["mod+shift+F", format, { preventDefault: true }],
			["mod+T", tabs.newTab, { preventDefault: true }],
			[
				"mod+W",
				() => tabs.closeTab(activeTabId),
				{ preventDefault: true }
			]
		],
		[]
	);

	// `onDetach` stubbed en mode node : la prop existe dans ConsoleHeader
	// mais le bouton est caché. On passe un no-op plutôt qu'undefined.
	const detachHandler = onDetach ?? (() => {});

	return (
		<div style={shellStyle}>
			<ConsoleHeader
				connectionName={connection?.name ?? "…"}
				teamSlug={teamSlug}
				connId={connId}
				isPopout={isPopout}
				canExecute={
					activeSource.trim() !== "" && connection !== undefined
				}
				canFormat={activeSource.trim() !== ""}
				isRunning={queryState.isPending}
				onExecute={execute}
				onFormat={format}
				onDetach={detachHandler}
				history={persistence.history}
				onHistorySelect={(source) =>
					tabs.updateSource(activeTabId, source)
				}
				onHistoryClear={persistence.clearHistory}
				tabs={tabs.state.tabs}
				activeTabId={activeTabId}
				onSelectTab={tabs.setActive}
				onCloseTab={tabs.closeTab}
				onNewTab={tabs.newTab}
				onRenameTab={tabs.renameTab}
				onReorderTabs={tabs.reorderTabs}
				variant={variant}
				extraLeftActions={extraLeftActions}
			/>

			<div ref={bodyRef} style={bodyStyle}>
				{/* Résultats masqués tant qu'aucune query n'a été lancée — évite
				    le "vide flou" au premier chargement, laisse l'éditeur
				    respirer tout seul. Apparaît dès qu'un run est pending / OK /
				    en erreur. */}
				<div
					style={{
						...editorWrapperStyle,
						...(hasRun
							? { height: editorHeight }
							: { flex: 1, minHeight: 0 })
					}}
				>
					<div style={editorFillStyle}>
						<SnqlEditor
							ref={editorRef}
							value={activeSource}
							onChange={(v) => tabs.updateSource(activeTabId, v)}
							onRun={execute}
							schema={schemaQuery.data ?? null}
							placeholder="get <table> pick <fields>"
							errorSpans={errorSpans}
							liveDiagnostic={liveDiagnostic}
						/>
					</div>
				</div>
				{hasRun ? (
					<>
						<div
							style={{
								...resizeHandleStyle,
								background: isDragging
									? "var(--sqlnest-accent-muted)"
									: "var(--sqlnest-border)"
							}}
							onPointerDown={startDrag}
							role="separator"
							aria-orientation="horizontal"
							aria-label="Redimensionner l'éditeur"
						/>
						<ConsoleResultsPanel
							result={queryState.data}
							error={queryState.error}
							isPending={queryState.isPending}
							timingMs={queryState.timingMs}
							onFocusSpan={onFocusSpan}
						/>
					</>
				) : null}
			</div>
		</div>
	);
}
