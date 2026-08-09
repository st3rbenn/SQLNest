import type { SpotlightActionGroupData } from "@sqlnest/design-system";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { CanvasTool } from "../CanvasToolbar";
import type { Frame } from "../frames";
import type { SchemaModel } from "../schema-model";
import type { FramesApi } from "../useFrames";

// ═══════════════════════════════════════════════════════════════════════
//   Design — pourquoi 4 contextes ?
//
// React Context re-render TOUS les consumers d'un context dès que sa
// value change. Un mega-context canvas trans-render à chaque geste
// (search, drag, click, ...). On split par FRÉQUENCE de mutation :
//
//   1. DataContext    — schema + APIs stables (rarement muté)
//   2. FocusContext   — focus + viewport (muté au click/nav)
//   3. UIContext      — search, menu, tool, drawer (muté à l'UI)
//   4. ActionsContext — callbacks bindés (stables, rarement re-mémoïsés)
//
// Chaque composant floating ne s'abonne qu'aux contextes dont il a
// besoin — le drawer gauche ne re-render pas quand la console SNQL se
// resize.
//
// Les hooks orchestrés (useCanvasNodes, useCanvasFrames, etc.) NE
// consomment PAS ces contextes — ils gardent leur opts explicite pour
// rester testables en isolation avec des mocks légers.
// ═══════════════════════════════════════════════════════════════════════

// ─── 1. Data — schema + APIs (rarement mutées) ─────────────────────────
export interface CanvasDataContextValue {
	readonly schema: SchemaModel;
	readonly schemaLabel: string | undefined;
	/** UUID de la db_connection dont ce schéma provient — propagé aux
	 *  navigations sortantes (ex: menu contextuel → /query) pour que
	 *  l'éditeur atterrisse sur la MÊME db que le canvas. */
	readonly connectionId: string;
	/** Nom lisible de la db_connection (ex: "apollon_db") — affiché dans
	 *  le back button top-left. Différent de `schemaLabel` qui désigne le
	 *  schéma Postgres cible (`public`). */
	readonly dbName: string;
	readonly framesApi: FramesApi;
	readonly hiddenIds: ReadonlySet<string>;
}

// ─── 2. Focus — focus/frame + viewport ─────────────────────────────────
export interface CanvasFocusContextValue {
	readonly focusId: string | null;
	readonly focusFrameKey: string | null;
	readonly focusedFrame: Frame | undefined;
	readonly setFocusId: (id: string | null) => void;
	readonly setFocusFrameKey: (key: string | null) => void;
	readonly focusNode: (id: string) => void;
	readonly focusFrame: (key: string) => void;
	readonly clearFocus: () => void;
	readonly focusAndZoom: (id: string) => void;
	readonly applyOverview: () => void;
}

// ─── 3. UI — volatile UI state ─────────────────────────────────────────
export interface ResizableDrawerHandleProps {
	readonly onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
	readonly onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
	readonly onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
	readonly onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void;
}

export interface CanvasContextMenuState {
	readonly x: number;
	readonly y: number;
	readonly tableName: string;
}

export interface CanvasUIContextValue {
	readonly search: string;
	readonly setSearch: (v: string) => void;
	readonly menu: CanvasContextMenuState | null;
	readonly setMenu: (m: CanvasContextMenuState | null) => void;
	readonly activeTool: CanvasTool;
	readonly setActiveTool: (t: CanvasTool) => void;
	readonly leftDrawerVisible: boolean;
	readonly setLeftDrawerVisible: (
		v: boolean | ((prev: boolean) => boolean)
	) => void;
	readonly leftDrawerWidth: number;
	readonly drawerHandleProps: ResizableDrawerHandleProps;
	readonly leftPadding: number;
	readonly consoleHeight: number;
	readonly setConsoleHeight: (h: number) => void;
	readonly consoleGap: number;
	readonly layoutConfirmOpen: boolean;
	readonly setLayoutConfirmOpen: (o: boolean) => void;
	readonly selectedTables: readonly string[];
	readonly clearSelection: () => void;
	/** Nom de la table survolée dans le side panel (SchemaTree). Alimente
	 *  le highlight visuel du TableNode correspondant dans le canvas —
	 *  aide à repérer une table sans cliquer. `null` quand rien n'est
	 *  survolé. */
	readonly hoveredTableName: string | null;
	readonly setHoveredTableName: (name: string | null) => void;
}

// ─── 4. Actions — callbacks bindés (stables) ───────────────────────────
export interface CanvasActionsContextValue {
	readonly hideTable: (name: string) => void;
	readonly unhideAll: () => void;
	readonly hideSelected: () => void;
	readonly createFrameFromSelection: () => void;
	readonly handleFrameRename: (key: string, label: string) => void;
	readonly handleFrameDelete: (key: string) => void;
	readonly relayoutAll: () => void;
	readonly addTableToFrame: (frameKey: string, tableName: string) => void;
	readonly removeTableFromFrame: (tableName: string) => void;
	readonly commandGroups: SpotlightActionGroupData[];
}

// ─── Contexts + selector hooks ─────────────────────────────────────────
const DataCtx = createContext<CanvasDataContextValue | null>(null);
const FocusCtx = createContext<CanvasFocusContextValue | null>(null);
const UICtx = createContext<CanvasUIContextValue | null>(null);
const ActionsCtx = createContext<CanvasActionsContextValue | null>(null);

const err = (name: string): never => {
	throw new Error(
		`${name}() called outside <CanvasProviders>. Wrap the consumer tree in <CanvasProviders value={...}>.`
	);
};

/** Lit le slot Data (schema + APIs stables). */
export function useCanvasData(): CanvasDataContextValue {
	return useContext(DataCtx) ?? err("useCanvasData");
}
/** Lit le slot Focus (focus/viewport). */
export function useCanvasFocusCtx(): CanvasFocusContextValue {
	return useContext(FocusCtx) ?? err("useCanvasFocusCtx");
}
/** Lit le slot UI (state volatile UI). */
export function useCanvasUI(): CanvasUIContextValue {
	return useContext(UICtx) ?? err("useCanvasUI");
}
/** Lit le slot Actions (callbacks bindés). */
export function useCanvasActionsCtx(): CanvasActionsContextValue {
	return useContext(ActionsCtx) ?? err("useCanvasActionsCtx");
}

// ─── Providers ─────────────────────────────────────────────────────────
export interface CanvasProvidersProps {
	readonly data: CanvasDataContextValue;
	readonly focus: CanvasFocusContextValue;
	readonly ui: CanvasUIContextValue;
	readonly actions: CanvasActionsContextValue;
	readonly children: ReactNode;
}

/**
 * 4-provider stack — un seul point de mount pour la tree canvas.
 *
 * ⚠️ Les 4 `value` doivent être stables entre les renders (via useMemo
 * dans le parent, ou grâce à des refs/callback stables). Passer un objet
 * inline `value={{...}}` provoquerait un re-render de tous les consumers
 * à CHAQUE render du parent.
 */
export function CanvasProviders({
	data,
	focus,
	ui,
	actions,
	children
}: CanvasProvidersProps) {
	// Wrappe chaque provider avec un useMemo minimal — les valeurs viennent
	// déjà stables du parent, mais on garantit une identité stable au niveau
	// du provider (pas de spread implicite).
	const dataMemo = useMemo(() => data, [data]);
	const focusMemo = useMemo(() => focus, [focus]);
	const uiMemo = useMemo(() => ui, [ui]);
	const actionsMemo = useMemo(() => actions, [actions]);
	return (
		<DataCtx.Provider value={dataMemo}>
			<FocusCtx.Provider value={focusMemo}>
				<UICtx.Provider value={uiMemo}>
					<ActionsCtx.Provider value={actionsMemo}>
						{children}
					</ActionsCtx.Provider>
				</UICtx.Provider>
			</FocusCtx.Provider>
		</DataCtx.Provider>
	);
}
