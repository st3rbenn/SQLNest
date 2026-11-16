import {
	Background,
	NestCanvas,
	NestCanvasProvider,
	Panel,
	SelectionMode,
	useNestCanvas
} from "@sqlnest/canvas";
import "@sqlnest/canvas/style.css";
import "./canvas-overrides.css";
import { useCallback, useMemo, useRef, useState } from "react";
import { SystemSchemaEventsNode } from "../checksum-history/SystemSchemaEventsNode";
import { SystemEnumsNode } from "../enums/SystemEnumsNode";
import type { CanvasTool } from "./CanvasToolbar";
import {
	type CanvasActionsContextValue,
	type CanvasContextMenuState,
	type CanvasDataContextValue,
	type CanvasFocusContextValue,
	CanvasProviders,
	type CanvasUIContextValue
} from "./canvas/CanvasContext";
import { CanvasZoomVariable } from "./canvas/CanvasZoomVariable";
import { CanvasBottomBar } from "./canvas/floating/CanvasBottomBar";
import { CanvasLeftPanel } from "./canvas/floating/CanvasLeftPanel";
import { CanvasOverlays } from "./canvas/floating/CanvasOverlays";
import { CanvasTopRightHUD } from "./canvas/floating/CanvasTopRightHUD";
import { CanvasVeil, ShowAllButton } from "./canvas/floating/CanvasVeil";
import { canReparentNode, withFrameParents } from "./canvas/frameTree";
import { useCanvasActions } from "./canvas/useCanvasActions";
import { useCanvasCommands } from "./canvas/useCanvasCommands";
import { useCanvasConsoles } from "./canvas/useCanvasConsoles";
import { useCanvasEdges } from "./canvas/useCanvasEdges";
import {
	useCanvasFocus,
	useFocusedFrame,
	useReleaseMissingFocus
} from "./canvas/useCanvasFocus";
import { useCanvasFrames } from "./canvas/useCanvasFrames";
import { useCanvasHotkeys } from "./canvas/useCanvasHotkeys";
import { useCanvasLayout } from "./canvas/useCanvasLayout";
import { useCanvasNodeEvents } from "./canvas/useCanvasNodeEvents";
import { useCanvasNodes } from "./canvas/useCanvasNodes";
import { useCanvasSelection } from "./canvas/useCanvasSelection";
import { useCanvasSelectionLasso } from "./canvas/useCanvasSelectionLasso";
import { useCanvasSyncBridge } from "./canvas/useCanvasSyncBridge";
import { useCanvasUndo } from "./canvas/useCanvasUndo";
import { useCanvasViewport } from "./canvas/useCanvasViewport";
import { useDisplayTables } from "./canvas/useDisplayTables";
import { useLeftDrawer } from "./canvas/useLeftDrawer";
import { useLocalPersistence } from "./canvas/useLocalPersistence";
import { usePreviewSnapshotSync } from "./canvas/usePreviewSnapshotSync";
import { useShallowMemo } from "./canvas/useShallowMemo";
import { type SystemNodeType, useSystemNodes } from "./canvas/useSystemNodes";
import { initialZoom, OVERVIEW_FIT } from "./canvas/viewport";
import { ConsoleLinksContext } from "./console-links/ConsoleLinksContext";
import { ResultNode, type ResultNodeType } from "./console-links/ResultNode";
import { useConsoleLinks } from "./console-links/useConsoleLinks";
import { useSchemaEditing } from "./editor/useSchemaEditing";
import { FrameNode, type FrameNodeType } from "./FrameNode";
import { InteractiveEdge } from "./InteractiveEdge";
import { ConsoleNode, type ConsoleNodeType } from "./nodes/ConsoleNode";
import type { Relation, SchemaModel } from "./schema-model";
import { TableNode, type TableNodeType } from "./TableNode";
import { useEdgeAnchors } from "./useEdgeAnchors";
import { useFrames } from "./useFrames";
import { useTablePositions, type XY } from "./useTablePositions";
import { useTableSizes } from "./useTableSizes";

const nodeTypes = {
	table: TableNode,
	frame: FrameNode,
	console: ConsoleNode,
	result: ResultNode,
	"system-schema-events": SystemSchemaEventsNode,
	"system-enums": SystemEnumsNode
};
const edgeTypes = { fk: InteractiveEdge };

type SchemaNode =
	| TableNodeType
	| FrameNodeType
	| ConsoleNodeType
	| ResultNodeType
	| SystemNodeType;

/** Bande basse occupée par la barre d'outils flottante : le cadrage ne
 *  pose rien dessous. */
const TOOLBAR_HEIGHT = 38;
const TOOLBAR_GAP = 8;
/** Marge basse du bouton « tout afficher » : il se pose au-dessus de la
 *  barre d'outils (à 16 px du bas, haute de 52 px), pas dessous. */
const ABOVE_TOOLBAR = 16 + 52 + 8;

interface CanvasInnerProps {
	schema: SchemaModel;
	/** Schéma cible (`public` pour Postgres), affiché dans le fil d'Ariane ;
	 *  omis pour Mongo. */
	schemaLabel?: string | undefined;
	connectionId: string;
	dbName: string;
	/** Équipe : consoles et changements de schéma passent par ses routes. */
	teamSlug: string;
}

function CanvasInner({
	schema,
	schemaLabel,
	connectionId,
	dbName,
	teamSlug
}: CanvasInnerProps) {
	const { screenToFlowPosition } = useNestCanvas();
	const containerRef = useRef<HTMLDivElement | null>(null);
	/** Centre de la vue courante, en coordonnées du canvas. */
	const viewCenter = useCallback((): XY | null => {
		const rect = containerRef.current?.getBoundingClientRect();
		if (!rect) return null;
		return screenToFlowPosition({
			x: rect.left + rect.width / 2,
			y: rect.top + rect.height / 2
		});
	}, [screenToFlowPosition]);

	// ─── État gardé : positions, tailles, frames, ancres, layout ──────────
	const persistence = useLocalPersistence();
	const tablePositions = useTablePositions(schema, persistence);
	const tableSizes = useTableSizes(schema, persistence);
	const { base, baseRef } = useCanvasLayout({
		schema,
		connectionId,
		viewCenter,
		setManyPositions: tablePositions.setManyPositions
	});
	const framesApi = useFrames(schema, persistence);
	const edgeAnchors = useEdgeAnchors(schema, persistence);
	const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(
		() => new Set()
	);

	// ─── Focus : une table ou un frame, jamais les deux ───────────────────
	// `applyOverview` naît plus bas (`useCanvasViewport`) : lu par ref.
	const applyOverviewRef = useRef<() => void>(() => {});
	const {
		focusId,
		focusFrameKey,
		setFocusId,
		setFocusFrameKey,
		focusNode,
		focusFrame,
		clearFocus
	} = useCanvasFocus({
		onClear: useCallback(() => applyOverviewRef.current(), [])
	});
	useReleaseMissingFocus(schema, focusId, setFocusId);

	// ─── État d'interface ─────────────────────────────────────────────────
	const [search, setSearch] = useState("");
	const [menu, setMenu] = useState<CanvasContextMenuState | null>(null);
	// Outil « frame » : un lasso crée un frame puis l'outil revient à
	// « select ». Le raccourci F fait de même depuis une sélection.
	const [activeTool, setActiveTool] = useState<CanvasTool>("select");
	const [hoveredTableName, setHoveredTableName] = useState<string | null>(null);
	const drawer = useLeftDrawer();

	// ─── Nodes des tables, historique, synchronisation ────────────────────
	// `useCanvasNodes` pousse dans l'historique, qui a besoin de son
	// `setNodes` : la dépendance circulaire passe par une ref.
	const historyPushRef = useRef<() => void>(() => {});
	const historyProxy = useMemo(
		() => ({ push: () => historyPushRef.current() }),
		[]
	);
	const {
		nodes,
		setNodes,
		handleNodesChange,
		persistMovedTables,
		handleTableResize
	} = useCanvasNodes({
		base,
		schema,
		tablePositions,
		tableSizes,
		framesApi,
		history: historyProxy
	});
	const history = useCanvasUndo({
		baseRef,
		setNodes,
		tablePositions,
		tableSizes,
		framesApi,
		hiddenIds,
		setHiddenIds
	});
	historyPushRef.current = history.push;

	const { canvasReady } = useCanvasSyncBridge({
		connectionId,
		baseRef,
		setNodes,
		tablePositions,
		tableSizes,
		framesApi,
		edgeAnchors,
		hiddenIds,
		setHiddenIds,
		onHydrated: history.resetBaseline
	});
	// Rendu précalculé pour la galerie quand le CLI est hors ligne.
	usePreviewSnapshotSync({
		connectionId,
		canvasReady,
		tableNodes: nodes,
		frames: framesApi.frames,
		relations: schema.relations,
		hiddenIds
	});

	// ─── Sélection, frames, arêtes ────────────────────────────────────────
	// Dès deux tables sélectionnées le focus est levé : son anneau et le
	// contour de sélection ne se côtoient pas.
	const { selectedTables, clearSelection } = useCanvasSelection<TableNodeType>({
		setNodes,
		onMultiSelect: useCallback(() => {
			setFocusId(null);
			setFocusFrameKey(null);
		}, [setFocusId, setFocusFrameKey])
	});
	const { frameNodes, handleFrameRename, handleFrameDelete, onNodeDragStop } =
		useCanvasFrames({
			base,
			nodes,
			hiddenIds,
			framesApi,
			tablePositions,
			persistMovedTables,
			history: historyProxy,
			focusFrame
		});
	const openRelationMenu = useCallback(
		(at: { x: number; y: number }, relation: Relation) =>
			setMenu({ ...at, relation }),
		[]
	);
	const { displayEdges, neighbors } = useCanvasEdges({
		base,
		schema,
		nodes,
		hiddenIds,
		focusId,
		edgeAnchors,
		onMenu: openRelationMenu
	});

	// ─── Édition du schéma, consoles, nodes système ───────────────────────
	const {
		editMode,
		gesture,
		setGesture,
		inferencePanelOpen,
		setInferencePanelOpen,
		traceRelation
	} = useSchemaEditing({ schema, teamSlug, connectionId });
	const consoles = useCanvasConsoles({ connectionId, teamSlug, viewCenter });
	const consoleLinks = useConsoleLinks({
		connectionId,
		schema,
		tableNodes: nodes,
		consoles,
		edges: displayEdges
	});
	const systemNodes = useSystemNodes({
		schema,
		connectionId,
		teamSlug,
		editMode,
		setGesture,
		openConsoleWithSource: consoles.openWithSource,
		tableNodes: nodes,
		frames: framesApi.frames,
		ready: canvasReady
	});

	// ─── Nodes affichés ───────────────────────────────────────────────────
	const displayTables = useDisplayTables({
		nodes,
		hiddenIds,
		neighbors,
		focusId,
		hoveredTableName,
		onResize: handleTableResize
	});
	const displayNodes = useMemo<SchemaNode[]>(
		() => [
			...frameNodes,
			...withFrameParents(displayTables, framesApi.frames),
			...consoleLinks.consoleNodes,
			...consoleLinks.resultNodes,
			...systemNodes.nodes
		],
		[
			frameNodes,
			displayTables,
			framesApi.frames,
			consoleLinks.consoleNodes,
			consoleLinks.resultNodes,
			systemNodes.nodes
		]
	);

	// ─── Vue : cadrage initial, recadrage sur une table, vue d'ensemble ───
	const { focusAndZoom, applyOverview } = useCanvasViewport({
		base,
		nodes,
		containerRef,
		leftPadding: drawer.leftPadding,
		consoleHeight: TOOLBAR_HEIGHT,
		consoleGap: TOOLBAR_GAP,
		setFocusId
	});
	applyOverviewRef.current = applyOverview;
	const focusedFrame = useFocusedFrame(
		framesApi.frames,
		focusFrameKey,
		setFocusFrameKey
	);

	// ─── Actions, raccourcis, gestes ──────────────────────────────────────
	const {
		layoutConfirmOpen,
		setLayoutConfirmOpen,
		relayoutAll,
		hideTable,
		unhideAll,
		hideSelected,
		createFrameFromSelection,
		addTableToFrame,
		removeTableFromFrame
	} = useCanvasActions({
		base,
		nodes,
		setNodes,
		tablePositions,
		framesApi,
		hiddenIds,
		setHiddenIds,
		focusId,
		setFocusId,
		selectedTables,
		applyOverview,
		history: historyProxy
	});
	useCanvasHotkeys({
		activeTool,
		setActiveTool,
		selectedTables,
		clearSelection,
		hideSelected,
		createFrameFromSelection,
		createConsole: consoles.createAtCenter,
		focusedConsoleId: consoles.focusedId,
		exitConsoleFocus: consoles.exitFocus
	});
	const { handleSelectionStart, handleSelectionEnd } = useCanvasSelectionLasso({
		activeTool,
		setActiveTool,
		framesApi,
		history: historyProxy,
		clearSelection
	});
	const { commandGroups } = useCanvasCommands({
		schema,
		onFocusTable: focusAndZoom,
		onFitView: applyOverview
	});
	const nodeEvents = useCanvasNodeEvents({
		setFocusId,
		setFocusFrameKey,
		focusNode,
		focusFrame,
		focusAndZoom,
		setMenu,
		setGesture,
		enterConsoleFocus: consoles.enterFocus,
		removeConsole: consoles.remove,
		persistConsolePosition: consoles.persistPosition,
		persistSystemNodePosition: systemNodes.persistPosition,
		onFrameDragStop: onNodeDragStop
	});

	// ─── Contextes de la couche flottante ─────────────────────────────────
	// Un contexte par fréquence de changement (voir `CanvasContext`) : chaque
	// valeur ne change que si un de ses champs change.
	const dataCtx = useShallowMemo<CanvasDataContextValue>({
		schema,
		schemaLabel,
		connectionId,
		dbName,
		teamSlug,
		editMode,
		framesApi,
		hiddenIds
	});
	const focusCtx = useShallowMemo<CanvasFocusContextValue>({
		focusId,
		focusFrameKey,
		focusedFrame,
		setFocusId,
		setFocusFrameKey,
		focusNode,
		focusFrame,
		clearFocus,
		focusAndZoom,
		applyOverview
	});
	const uiCtx = useShallowMemo<CanvasUIContextValue>({
		search,
		setSearch,
		menu,
		setMenu,
		activeTool,
		setActiveTool,
		leftDrawerVisible: drawer.visible,
		setLeftDrawerVisible: drawer.setVisible,
		leftDrawerWidth: drawer.width,
		drawerHandleProps: drawer.handleProps,
		leftPadding: drawer.leftPadding,
		consoleHeight: TOOLBAR_HEIGHT,
		consoleGap: TOOLBAR_GAP,
		layoutConfirmOpen,
		setLayoutConfirmOpen,
		selectedTables,
		clearSelection,
		hoveredTableName,
		setHoveredTableName,
		inferencePanelOpen,
		setInferencePanelOpen,
		gesture,
		setGesture
	});
	const actionsCtx = useShallowMemo<CanvasActionsContextValue>({
		hideTable,
		unhideAll,
		hideSelected,
		createFrameFromSelection,
		handleFrameRename,
		handleFrameDelete,
		relayoutAll,
		addTableToFrame,
		removeTableFromFrame,
		commandGroups,
		createConsole: consoles.createAtCenter
	});

	return (
		<div
			ref={containerRef}
			className={activeTool === "frame" ? "canvas-tool-frame" : undefined}
			// Console en plein écran : le CSS estompe le reste du canvas.
			data-console-focus={consoles.focusedId !== null ? "true" : undefined}
			style={{ position: "relative", width: "100%", height: "100%" }}
		>
			<CanvasVeil layoutPending={base === null} syncing={!canvasReady} />

			<ConsoleLinksContext.Provider value={consoleLinks.context}>
				<NestCanvas
					nodes={displayNodes as unknown as TableNodeType[]}
					edges={consoleLinks.edges}
					// Le moteur émet les changes de tous les nodes affichés : chaque
					// famille (tables et frames, consoles, nodes système) garde les
					// siens.
					onNodesChange={(changes) => {
						handleNodesChange(changes);
						consoles.onNodesChange(changes as never);
						consoleLinks.onResultNodesChange(changes as never);
						systemNodes.onNodesChange(changes as never);
					}}
					nodeTypes={nodeTypes}
					edgeTypes={edgeTypes}
					// Molette et trackpad déplacent la vue (Cmd/Ctrl + molette zoome),
					// le clic milieu aussi. Glisser sur le vide trace un lasso, qui
					// prend un node dès qu'il le touche.
					panOnScroll
					zoomOnScroll={false}
					selectionOnDrag
					selectionMode={SelectionMode.Partial}
					panOnDrag={[1]}
					onSelectionStart={handleSelectionStart}
					onSelectionEnd={handleSelectionEnd}
					// Sélection multiple au clic : Shift, ou le modificateur du
					// système (Cmd sur Mac, Ctrl ailleurs).
					multiSelectionKeyCode={["Shift", "Meta", "Control"]}
					onPaneContextMenu={(event) => event.preventDefault()}
					{...nodeEvents}
					// Tables et frames changent de frame en suivant le pointeur.
					canReparent={canReparentNode}
					onConnect={traceRelation}
					// Zoom de départ garanti même si le conteneur n'est pas encore
					// mesuré ; le cadrage de `useCanvasViewport` prend ensuite le relais.
					defaultViewport={{
						x: 0,
						y: 0,
						zoom: initialZoom(schema.collections.length)
					}}
					fitViewOptions={OVERVIEW_FIT}
					minZoom={0.02}
					maxZoom={1.75}
					onlyRenderVisibleElements
				>
					{/* Pas de 20 px : plus fin, la grille salit la vue large ; plus
					 * large, elle ne se lit plus comme un papier millimétré. */}
					<Background color="var(--sqlnest-canvas-dot)" gap={20} />
					<CanvasZoomVariable />
					<Panel position="top-right" style={{ top: 12, right: 12, margin: 0 }}>
						<CanvasTopRightHUD />
					</Panel>
					{focusId ? (
						<Panel
							position="bottom-center"
							style={{ marginBottom: ABOVE_TOOLBAR }}
						>
							<ShowAllButton onClick={clearFocus} />
						</Panel>
					) : null}
				</NestCanvas>
			</ConsoleLinksContext.Provider>

			<CanvasProviders
				data={dataCtx}
				focus={focusCtx}
				ui={uiCtx}
				actions={actionsCtx}
			>
				<CanvasBottomBar />
				<CanvasLeftPanel />
				<CanvasOverlays />
			</CanvasProviders>
		</div>
	);
}

/** Canvas ER interactif — dompte les grands schémas via drawers + focus + recherche. */
export function SchemaCanvas({
	schema,
	schemaLabel,
	connectionId,
	dbName,
	teamSlug
}: {
	schema: SchemaModel;
	schemaLabel?: string;
	connectionId: string;
	dbName: string;
	teamSlug: string;
}) {
	// Un canvas par connexion : en changer remonte tout, état réinitialisé et
	// graphe recadré. Une table créée ou supprimée ne remonte rien — la vue
	// reste où elle est et le panneau garde son résultat (ADR-039 D5).
	return (
		<NestCanvasProvider key={connectionId}>
			<CanvasInner
				schema={schema}
				schemaLabel={schemaLabel}
				connectionId={connectionId}
				dbName={dbName}
				teamSlug={teamSlug}
			/>
		</NestCanvasProvider>
	);
}
