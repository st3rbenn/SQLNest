/**
 * Shell fullscreen de la console SNQL. Layout :
 *
 *   ┌ ConsoleHeader (48px) ────────────────────────────────────────────┐
 *   │ Back/Fermer · Console · dbName    HintPill    Hist · Détacher · Exécuter │
 *   ├ ConsoleTabs (36px) ──────────────────────────────────────────────┤
 *   │ tab1 · tab2 · +                                                  │
 *   ├─── SnqlEditor (resizable, split top) ────────────────────────────┤
 *   │                                                                  │
 *   ├─── resize handle (4px, ns-resize) ───────────────────────────────┤
 *   │ ConsoleResultsPanel                                              │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Raccourcis :
 *  - ⌘⏎ dans l'éditeur → onRun (câblé dans SnqlEditor keymap)
 *  - ⌘⇧K → détache la console dans une fenêtre
 *  - Esc → back au canvas (ou window.close si popout)
 *  - ⌘T → nouvelle tab, ⌘W → ferme la tab active
 */

import { useHotkeys, useLocalStorage } from "@mantine/hooks";
import { useNavigate } from "@tanstack/react-router";
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
import { ConsoleHeader } from "./ConsoleHeader";
import { ConsoleResultsPanel } from "./ConsoleResultsPanel";
import { ConsoleTabs } from "./ConsoleTabs";
import { SnqlEditor } from "./SnqlEditor";
import { openConsoleInPopout, useIsPopout } from "./usePopoutWindow";
import { useConsoleTabs } from "./useConsoleTabs";
import { useRunQuery } from "./useRunQuery";

const SPLIT_STORAGE_KEY = "sqlnest.console.editorHeight";
const SPLIT_MIN_TOP = 120;
const SPLIT_MIN_BOTTOM = 200;
const SPLIT_DEFAULT = 320;

const pageStyle: CSSProperties = {
	position: "fixed",
	inset: 0,
	display: "flex",
	flexDirection: "column",
	background: "var(--sqlnest-canvas-bg)",
	color: "var(--sqlnest-text-primary)",
	fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif"
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
	minHeight: SPLIT_MIN_TOP
};

const resizeHandleStyle: CSSProperties = {
	height: 4,
	cursor: "ns-resize",
	background: "var(--sqlnest-border-subtle)",
	transition: "background-color 120ms ease",
	flexShrink: 0
};

export function ConsolePage({
	teamSlug,
	connId,
	initialSource,
	initialAutorun
}: {
	readonly teamSlug: string;
	readonly connId: string;
	readonly initialSource?: string;
	readonly initialAutorun?: boolean;
}): React.ReactNode {
	const navigate = useNavigate();
	const isPopout = useIsPopout();

	const { data: connections } = useDbConnections(teamSlug);
	const connection = useMemo(
		() => connections?.find((c) => c.id === connId),
		[connections, connId]
	);
	const engine = connection?.engine ?? "postgres";

	const schemaQuery = useSchema(connId, teamSlug);

	const tabs = useConsoleTabs(connId);
	const persistence = useConsolePersistence(engine);
	const runQuery = useRunQuery();

	// Split resize state (persisted).
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

	const [lastRunAt, setLastRunAt] = useState<number | undefined>(undefined);
	const [timingMs, setTimingMs] = useState<number | undefined>(undefined);

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
		const t0 = performance.now();
		runQuery.mutate(
			{ connectionId: connId, source: src, teamSlug },
			{
				onSuccess: (data) => {
					const timing = Math.round(performance.now() - t0);
					setTimingMs(timing);
					setLastRunAt(Date.now());
					tabs.setLastResult(activeTabId, {
						rowCount: data.rowCount,
						timingMs: timing
					});
					persistence.addHistory(src);
				},
				onError: () => {
					setTimingMs(Math.round(performance.now() - t0));
					setLastRunAt(Date.now());
				}
			}
		);
	}, [runQuery, connId, teamSlug, tabs, activeTabId, persistence]);

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

	function handleDetach(): void {
		openConsoleInPopout(teamSlug, connId);
		// Le tab d'origine repart au canvas — évite d'avoir 2 fenêtres
		// identiques ouvertes sur la même URL.
		if (!isPopout) {
			navigate({
				to: "/team/$teamSlug/canvas/$connId",
				params: { teamSlug, connId }
			});
		}
	}

	function handleBack(): void {
		if (isPopout) {
			window.close();
			return;
		}
		navigate({
			to: "/team/$teamSlug/canvas/$connId",
			params: { teamSlug, connId }
		});
	}

	// Hotkeys globaux. 2ᵉ arg [] = actif même dans les inputs / éditeur.
	useHotkeys(
		[
			["mod+shift+K", handleDetach, { preventDefault: true }],
			["Escape", handleBack, { preventDefault: false }],
			["mod+T", tabs.newTab, { preventDefault: true }],
			[
				"mod+W",
				() => tabs.closeTab(activeTabId),
				{ preventDefault: true }
			]
		],
		[]
	);

	return (
		<div style={pageStyle}>
			<ConsoleHeader
				connectionName={connection?.name ?? "…"}
				teamSlug={teamSlug}
				connId={connId}
				isPopout={isPopout}
				canExecute={
					activeSource.trim() !== "" && connection !== undefined
				}
				isRunning={runQuery.isPending}
				onExecute={execute}
				onDetach={handleDetach}
				history={persistence.history}
				onHistorySelect={(source) =>
					tabs.updateSource(activeTabId, source)
				}
				onHistoryClear={persistence.clearHistory}
			/>

			<ConsoleTabs
				tabs={tabs.state.tabs}
				activeTabId={activeTabId}
				onSelect={tabs.setActive}
				onClose={tabs.closeTab}
				onNew={tabs.newTab}
				onRename={tabs.renameTab}
				onReorder={tabs.reorderTabs}
			/>

			<div ref={bodyRef} style={bodyStyle}>
				<div style={{ ...editorWrapperStyle, height: editorHeight }}>
					<SnqlEditor
						value={activeSource}
						onChange={(v) => tabs.updateSource(activeTabId, v)}
						onRun={execute}
						schema={schemaQuery.data ?? null}
						placeholder="get <table> | pick <fields>"
					/>
				</div>
				<div
					style={{
						...resizeHandleStyle,
						background: isDragging
							? "var(--sqlnest-accent-muted)"
							: "var(--sqlnest-border-subtle)"
					}}
					onPointerDown={startDrag}
					role="separator"
					aria-orientation="horizontal"
					aria-label="Redimensionner l'éditeur"
				/>
				<ConsoleResultsPanel
					result={runQuery.data}
					error={runQuery.error}
					isPending={runQuery.isPending}
					timingMs={lastRunAt !== undefined ? timingMs : undefined}
				/>
			</div>
		</div>
	);
}
