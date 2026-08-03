import { useHotkeys } from "@mantine/hooks";
import {
	Background,
	Controls,
	type Edge,
	MarkerType,
	MiniMap,
	Panel,
	ReactFlow,
	ReactFlowProvider,
	SelectionMode
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./canvas-overrides.css";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState
} from "react";
import { type CanvasTool } from "./CanvasToolbar";
import { CanvasProviders } from "./canvas/CanvasContext";
import { useResizableDrawer } from "./canvas/DrawerPane";
import { CanvasBottomBar } from "./canvas/floating/CanvasBottomBar";
import { CanvasLeftPanel } from "./canvas/floating/CanvasLeftPanel";
import { CanvasOverlays } from "./canvas/floating/CanvasOverlays";
import { useCanvasActions } from "./canvas/useCanvasActions";
import { useCanvasCommands } from "./canvas/useCanvasCommands";
import { useCanvasEdges } from "./canvas/useCanvasEdges";
import { useCanvasFocus } from "./canvas/useCanvasFocus";
import { useCanvasFrames } from "./canvas/useCanvasFrames";
import { useCanvasHistory } from "./canvas/useCanvasHistory";
import { useCanvasNodes } from "./canvas/useCanvasNodes";
import { useCanvasSelection } from "./canvas/useCanvasSelection";
import { useCanvasSelectionLasso } from "./canvas/useCanvasSelectionLasso";
import { useCanvasSyncBridge } from "./canvas/useCanvasSyncBridge";
import { useCanvasViewport } from "./canvas/useCanvasViewport";
import { useUndoRedoShortcuts } from "./canvas/useUndoRedoShortcuts";
import { initialZoom, OVERVIEW_FIT } from "./canvas/viewport";
import { FrameNode, type FrameNodeType } from "./FrameNode";
import { InteractiveEdge } from "./InteractiveEdge";
import { buildLayout, type LayoutResult } from "./layout";
import type { SchemaModel } from "./schema-model";
import {
	NODE_WIDTH,
	nodeHeight,
	TableNode,
	type TableNodeType
} from "./TableNode";
import { useCurrentUser } from "../auth/sessionQuery";
import { useEdgeAnchors } from "./useEdgeAnchors";
import { useFrames } from "./useFrames";
import { useTablePositions } from "./useTablePositions";
import { useTableSizes } from "./useTableSizes";

// Couleurs des edges — accent bleu Figma pour les FK déclarées, jaune
// warning pour les FK inférées (jamais confirmées par la DB). Toutes deux
// choisies pour rester lisibles sur `#1E1E1E`.
const DECLARED = "#0d99ff";
const INFERRED = "#ffc933";
const nodeTypes = { table: TableNode, frame: FrameNode };
const edgeTypes = { fk: InteractiveEdge };

type SchemaNode = TableNodeType | FrameNodeType;

function makeNode(schema: SchemaModel) {
	return (name: string): TableNodeType => {
		const collection = schema.collections.find((c) => c.name === name);
		if (collection === undefined) {
			throw new Error(`makeNode: collection introuvable ${name}`);
		}
		return {
			id: name,
			type: "table",
			position: { x: 0, y: 0 },
			// Dimensions explicites → fitView cadre sans attendre la mesure DOM.
			width: NODE_WIDTH,
			height: nodeHeight(collection),
			data: { collection, dimmed: false, focused: false, matched: false }
		};
	};
}

function makeEdge(rel: SchemaModel["relations"][number], i: number): Edge {
	const inferred = rel.origin !== "foreign-key";
	return {
		id: `e${i}-${rel.from.collection}-${rel.to.collection}`,
		source: rel.from.collection,
		target: rel.to.collection,
		// Custom edge type — dessine le path + expose des poignées drag aux
		// endpoints (voir `InteractiveEdge`).
		type: "fk",
		markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
		style: {
			stroke: inferred ? INFERRED : DECLARED,
			strokeWidth: 1.5,
			strokeDasharray: inferred ? "5 4" : undefined
		},
		// `relation` intégral pour que le tooltip du hover puisse formater
		// les colonnes reliées, la kind/origine et le preview SQL du join.
		data: { inferred, relation: rel }
	};
}

interface CanvasInnerProps {
	schema: SchemaModel;
	/** Nom du schéma cible (ex : `public` pour Postgres). Affiché dans le
	 * breadcrumb — omis pour Mongo. `| undefined` explicite pour permettre
	 * un pass-through depuis un caller dont le prop est optionnel (sous
	 * `exactOptionalPropertyTypes`, `schemaLabel?: string` n'accepterait pas
	 * une valeur `string | undefined`). */
	schemaLabel?: string | undefined;
}

function CanvasInner({ schema, schemaLabel }: CanvasInnerProps) {
	// Layout ELK — async. Le composant est **remonté** au changement de schéma
	// (clé sur ReactFlowProvider), donc pas de course entre deux layouts.
	const [base, setBase] = useState<LayoutResult | null>(null);
	useEffect(() => {
		let cancelled = false;
		buildLayout(schema, makeNode(schema), makeEdge).then((result) => {
			if (!cancelled) setBase(result);
		});
		return () => {
			cancelled = true;
		};
	}, [schema]);
	// Ref sur `base` — lue par le callback `onRestore` de useCanvasHistory
	// pour retomber sur les positions ELK d'origine quand un node n'a pas
	// d'override dans le snapshot restauré. Ref (pas dep du useCallback)
	// pour garder une identité stable et éviter les stale closures.
	const baseRef = useRef<LayoutResult | null>(null);
	baseRef.current = base;

	// ─── Persistance : server-only quand loggé, localStorage quand anonyme ─
	// Le user loggé a un canvas serveur (hydraté par useCanvasSync) — le
	// localStorage n'apporte alors qu'un risque de stale state cross-device
	// (logout ici, changement là-bas, refresh → vieux state réinjecté). Le
	// user anonyme n'a pas de compte, on garde le localStorage comme unique
	// persistance (comportement historique).
	const { data: session } = useCurrentUser();
	const persistLocal = session?.user == null;
	const hookOpts = useMemo(() => ({ persistLocal }), [persistLocal]);

	// Purge des entrées `sqlnest:*:*` des slices canvas dès qu'on détecte
	// un user loggé. Sans ça, les keys anonymes restent sur disque et
	// peuvent réapparaître à un logout futur ou à un swap de compte.
	useEffect(() => {
		if (persistLocal) return;
		if (typeof window === "undefined") return;
		const prefixes = [
			"sqlnest:positions:",
			"sqlnest:sizes:",
			"sqlnest:frames:",
			"sqlnest:edge-anchors:"
		];
		try {
			const stale = Object.keys(window.localStorage).filter((k) =>
				prefixes.some((p) => k.startsWith(p))
			);
			for (const k of stale) window.localStorage.removeItem(k);
		} catch {
			/* quota / private mode */
		}
	}, [persistLocal]);

	const tablePositions = useTablePositions(schema, hookOpts);
	// Sizes user persistées (NodeResizer 4 côtés de chaque table) — stocke
	// width ET height : le user peut resize dans les 2 axes.
	const tableSizes = useTableSizes(schema, hookOpts);

	// Focus canvas — table OU frame, mutuellement exclusifs (un seul drawer
	// détails à la fois). Extrait dans `useCanvasFocus`. `onClear` réapplique
	// l'overview ; `applyOverview` étant défini plus bas dans ce composant,
	// on passe une closure stable qui lit la version courante via ref.
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
	const [search, setSearch] = useState("");
	const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(
		() => new Set()
	);
	const [menu, setMenu] = useState<{
		x: number;
		y: number;
		tableName: string;
	} | null>(null);
	// Outil actif de la toolbar canvas. « frame » = mode explicite : cursor
	// crosshair sur le pane, un lasso au release crée un frame à partir des
	// tables touchées puis revient à « select ». Le raccourci F reste dispo
	// pour créer un frame depuis une sélection existante — c'est le geste
	// « expert », le mode toolbar est le geste « découvrable ».
	const [activeTool, setActiveTool] = useState<CanvasTool>("select");
	const containerRef = useRef<HTMLDivElement | null>(null);

	// Frames user-defined (persistés en localStorage quand anonyme,
	// server-only quand loggé — cf. `hookOpts` plus haut). Remplace le
	// `framesFor(schema)` statique — l'utilisateur crée/retire ses frames
	// via lasso + F et le menu contextuel « Retirer du frame ».
	const framesApi = useFrames(schema, hookOpts);

	// Overrides d'ancres par edge (source-side / target-side). Persistés
	// en localStorage quand anonyme, server-only quand loggé (via
	// `useCanvasSync` — payload sync inclut edgeAnchors depuis 2026-08).
	// Déclaré ICI pour que `useCanvasSync` (juste après) puisse les
	// observer + les remplacer via `canvasSyncReplaceAll.edgeAnchors`.
	const edgeAnchors = useEdgeAnchors(schema, hookOpts);

	// State React Flow `nodes` + handleTableResize + handleNodesChange
	// (intercept frame changes) — voir `useCanvasNodes` pour la doc.
	// `history.push` passé via ref (`historyPushRef`) : `useCanvasHistory`
	// est déclaré JUSTE APRÈS mais a besoin de `setNodes` qu'on obtient
	// ici → dépendance circulaire résolue par le ref (rebound plus bas).
	const historyPushRef = useRef<() => void>(() => {});
	const historyProxy = useMemo(
		() => ({ push: () => historyPushRef.current() }),
		[]
	);
	const { nodes, setNodes, nodesRef, handleNodesChange, handleTableResize } =
		useCanvasNodes({
			base,
			tablePositions,
			tableSizes,
			framesApi,
			history: historyProxy
		});

	// Historique undo/redo — capture positions + sizes + frames + hiddenIds.
	// `history.push()` doit être appelé APRÈS chaque geste user notable
	// (drag stop, resize end, create/remove/rename frame, hide/unhide,
	// auto-layout). Le hook maintient l'invariant « past = états
	// pré-mutation » via un `prevRef` resynchronisé post-commit — voir
	// `useCanvasHistory` pour l'analyse détaillée du timing.
	//
	// `onRestore` : le hook restore positions/sizes/frames/hiddenIds dans
	// leurs hooks respectifs, mais React Flow garde son propre `nodes` state
	// (via `useNodesState` plus haut) qui n'était pas resync → Cmd+Z ne
	// bougeait visuellement rien, seul un reload rendait la vue cohérente.
	// On applique donc ici les overlays positions/sizes du snapshot sur les
	// nodes RF, avec fallback sur la position ELK d'origine (`baseRef`)
	// pour les nodes non présents dans le snapshot (jamais draggés / resizés
	// à ce moment-là de l'historique).
	const history = useCanvasHistory({
		tablePositions,
		tableSizes,
		framesApi,
		hiddenIds,
		setHiddenIds,
		onRestore: useCallback(
			(snapshot) => {
				const baseNodes = baseRef.current?.nodes;
				if (!baseNodes) return;
				const baseById = new Map(baseNodes.map((n) => [n.id, n]));
				setNodes((prev) =>
					prev.map((n) => {
						const baseNode = baseById.get(n.id);
						const pos = snapshot.positions[n.id];
						const size = snapshot.sizes[n.id];
						// Fallback chaîné : snapshot → ELK base → keep. Spread
						// conditionnel pour width/height afin de respecter
						// `exactOptionalPropertyTypes` (jamais `width: undefined`).
						const w = size?.width ?? baseNode?.width;
						const h = size?.height ?? baseNode?.height;
						return {
							...n,
							position: pos ?? baseNode?.position ?? n.position,
							...(w !== undefined ? { width: w } : {}),
							...(h !== undefined ? { height: h } : {})
						};
					})
				);
			},
			[setNodes]
		)
	});
	// Bind du proxy `historyPushRef` (déclaré plus haut, consommé par
	// `useCanvasNodes.handleTableResize`) au vrai `history.push` maintenant
	// que `useCanvasHistory` est monté. Le pattern ref évite la dépendance
	// circulaire entre useCanvasNodes (produit setNodes) et useCanvasHistory
	// (consomme setNodes pour onRestore).
	historyPushRef.current = history.push;

	// Shortcuts globaux Cmd/Ctrl+Z (undo) et Cmd/Ctrl+Shift+Z ou Cmd/Ctrl+Y
	// (redo). preventDefault critique pour bloquer le « restore tab fermée »
	// de Chrome/Safari. Skip auto quand focus est dans un input/textarea/
	// contenteditable — l'undo natif du champ (rename inline frame, éditeur
	// SNQL) reste actif.
	useUndoRedoShortcuts({ onUndo: history.undo, onRedo: history.redo });

	// Sync serveur du state canvas — signature + replaceAll + useCanvasSync.
	// Voir `useCanvasSyncBridge` pour la doc (repush RF nodes après hydration,
	// fallback chaîné serveur → ELK base → keep, gate anonyme).
	const { canvasReady } = useCanvasSyncBridge({
		schema,
		baseRef,
		setNodes,
		tablePositions,
		tableSizes,
		framesApi,
		edgeAnchors,
		hiddenIds,
		setHiddenIds
	});

	// Sélection multi-tables — alimente le chip bas-centre et le raccourci `F`.
	// Extrait dans `useCanvasSelection` ; le callback `onMultiSelect` clear le
	// focus dès qu'on passe à ≥2 sélectionnés (sinon les styles `focused` (bord
	// interne bleu foncé + shadow opacité 0.25) et `.selected` (outline
	// extérieur + shadow opacité 0.15) coexistent sur des tables différentes →
	// mix visuellement confus).
	const { selectedTables, clearSelection } = useCanvasSelection<TableNodeType>({
		setNodes,
		onMultiSelect: useCallback(() => {
			setFocusId(null);
			setFocusFrameKey(null);
		}, [setFocusId, setFocusFrameKey])
	});

	// Frames — orchestration complète (handlers resize/rename/delete/focus,
	// membership reconciliation post-ELK, drag lifecycle avec snapshot des
	// positions au drag-start). Voir `useCanvasFrames` pour la doc.
	const {
		frameNodes,
		handleFrameRename,
		handleFrameDelete,
		onNodeDragStart,
		onNodeDrag,
		onNodeDragStop
	} = useCanvasFrames({
		base,
		nodes,
		nodesRef,
		setNodes,
		hiddenIds,
		framesApi,
		tablePositions,
		history: historyProxy,
		focusFrame
	});

	// Edges + neighbors dérivés — pipeline routing/offset dans un hook
	// dédié (voir `useCanvasEdges` : override user > auto bestHandles,
	// spread offsets pour edges partageant un handle, style focus/dim).
	const { displayEdges, neighbors } = useCanvasEdges({
		base,
		nodes,
		hiddenIds,
		focusId,
		edgeAnchors
	});

	// Nœuds table affichés : positions vivantes (drag) + drapeaux focus + masqués.
	// Injecte aussi le callback `onResizeEnd` — TableNode s'en sert pour le
	// NodeResizer 4 côtés. Absent = pas de handles (utile aux tests / rendus
	// externes).
	const displayTableNodes = useMemo(
		() =>
			nodes
				.filter((n) => !hiddenIds.has(n.id))
				.map((n) => {
					const inFocus = neighbors ? neighbors.has(n.id) : true;
					return {
						...n,
						data: {
							...n.data,
							dimmed: neighbors !== null && !inFocus,
							focused: n.id === focusId,
							matched: false,
							onResizeEnd: (s: {
								width: number;
								height: number;
								x: number;
								y: number;
							}) => handleTableResize(n.id, s)
						}
					};
				}),
		[nodes, neighbors, focusId, hiddenIds, handleTableResize]
	);

	// (`nodesRef` exposé par `useCanvasNodes` — voir plus haut, consommé par
	// les handlers frame drag/resize qui ont besoin de la dernière version
	// des positions sans refermer sur une snapshot obsolète.)

	// (`frameNodes` + handlers + drag lifecycle exposés par `useCanvasFrames`
	// plus haut.)

	const displayNodes = useMemo<SchemaNode[]>(
		() => [...frameNodes, ...displayTableNodes],
		[frameNodes, displayTableNodes]
	);

	// Hauteur courante de la console SNQL (bas droite). Publiée par
	// `CanvasConsole.onHeightChange` — sert (a) au safeArea pour que le
	// fit initial garde le contenu au-dessus de la console, (b) au
	// bottom-offset de la toolbar horizontale pour qu'elle remonte quand
	// la console s'ouvre.
	const [consoleHeight, setConsoleHeight] = useState(38);
	const CONSOLE_GAP = 8;

	// Visibilité du drawer gauche — masquable via un IconButton pour libérer
	// de l'espace. État volatile (reset au refresh) : la persistance était
	// plus embêtante qu'utile (le drawer revient à sa position par défaut
	// à chaque rechargement, plus prévisible que "ce qu'il était avant").
	const [leftDrawerVisible, setLeftDrawerVisible] = useState(true);

	// Largeur du drawer — resizable via le handle droit. State + handlers
	// encapsulés dans `useResizableDrawer` (persistance localStorage,
	// clamp MIN/MAX). Largeur remontée ici pour dériver `leftPadding`
	// (safeArea + console leftOffset) et positionner le toggle button.
	const { width: leftDrawerWidth, handleProps: drawerHandleProps } =
		useResizableDrawer();

	// `leftPadding` dérivé — sert au safeArea (fit initial) et à la console
	// SNQL (leftOffset). Suit la largeur courante du drawer + gap.
	const leftPadding = leftDrawerVisible ? leftDrawerWidth + 8 : 8;

	// `safeArea` = bandes occupées par les panels flottants ou dockés :
	// - gauche : drawer unifié docké (300 px pleine hauteur — même largeur
	//            en mode arborescence ET en mode détails) OU juste padding
	// - droite : plus de drawer flottant droit (détails migrés dans le gauche)
	// - bas   : toolbar (68 px) + console (dynamique, poussée au-dessus)
	// Viewport : auto-fit + focusAndZoom + applyOverview + userTouched
	// tracking. Encapsulé dans `useCanvasViewport` — voir sa doc pour la
	// raison du safeArea via ref (évite le recadrage au toggle drawer).
	const { focusAndZoom, applyOverview } = useCanvasViewport({
		base,
		nodes,
		containerRef,
		leftPadding,
		consoleHeight,
		consoleGap: CONSOLE_GAP,
		setFocusId
	});
	// Injecte la version courante de `applyOverview` dans la ref lue par le
	// callback `onClear` de `useCanvasFocus` (déclaré plus haut).
	applyOverviewRef.current = applyOverview;

	// Frame courant (si le drawer affiche FrameDetails). Recalculé à chaque
	// re-render — passe à undefined si le frame a été supprimé pendant qu'on
	// l'affichait ; l'effet ci-dessous clear alors focusFrameKey.
	const focusedFrame = useMemo(
		() =>
			focusFrameKey !== null
				? framesApi.frames.find((f) => f.key === focusFrameKey)
				: undefined,
		[focusFrameKey, framesApi.frames]
	);
	useEffect(() => {
		if (focusFrameKey !== null && focusedFrame === undefined) {
			setFocusFrameKey(null);
		}
	}, [focusFrameKey, focusedFrame]);

	// Actions destructives / massives : auto-layout, hide, frame creation.
	// Voir `useCanvasActions` pour la doc de chacune. Le hook expose aussi
	// le state du modal Auto-layout (`layoutConfirmOpen`) car il gate
	// l'appel à `relayoutAll` — confirmation obligatoire, geste massif
	// non-trivialement réversible.
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

	// Shortcuts toolbar canvas — mêmes sémantiques que Figma/Sketch.
	// `useHotkeys` skip auto sur INPUT/TEXTAREA/SELECT + contentEditable
	// (préserve l'undo/rename inline), et gère les modifier keys sans
	// qu'on ait besoin de check `metaKey/ctrlKey/altKey` à la main.
	useHotkeys([
		[
			"Escape",
			() => {
				if (activeTool === "frame") setActiveTool("select");
			},
			{ preventDefault: true }
		],
		[
			"V",
			() => setActiveTool("select"),
			{ preventDefault: true }
		],
		[
			"F",
			() => {
				// `F` a deux comportements complémentaires :
				//  - avec sélection → crée un frame depuis la sélection.
				//  - sans sélection → active le mode Frame (lasso).
				if (selectedTables.length > 0) {
					createFrameFromSelection();
					clearSelection();
				} else {
					setActiveTool("frame");
				}
			},
			{ preventDefault: true }
		]
	]);

	// Mode « frame » toolbar — capture lasso + crée un frame. Voir
	// `useCanvasSelectionLasso` pour la doc (rect = lasso pas bounds tables,
	// création frames vides possibles, retour auto à `select`).
	const { handleSelectionStart, handleSelectionEnd } = useCanvasSelectionLasso({
		activeTool,
		setActiveTool,
		framesApi,
		history: historyProxy,
		clearSelection
	});

	// Palette Cmd+K — spotlight shortcut + commandGroups. Voir
	// `useCanvasCommands` pour la surface (tables + fit-view + ask-ai + theme).
	const { commandGroups } = useCanvasCommands({
		schema,
		onFocusTable: focusAndZoom,
		onFitView: applyOverview
	});

	// ─── Contexts pour la couche floating (R4) ────────────────────────────
	// Les 3 composants <CanvasBottomBar>, <CanvasLeftPanel>, <CanvasOverlays>
	// consomment ces slots via `useCanvasData()`, `useCanvasFocusCtx()`,
	// `useCanvasUI()`, `useCanvasActionsCtx()` — 0 prop parent. Chaque
	// value est memoïsée par slot pour ne pas re-render tous les consumers
	// dès qu'un state UI mineur change. Voir `CanvasContext.tsx` pour la
	// raison du split en 4 contextes.
	const dataCtxValue = useMemo(
		() => ({ schema, schemaLabel, framesApi, hiddenIds }),
		[schema, schemaLabel, framesApi, hiddenIds]
	);
	const focusCtxValue = useMemo(
		() => ({
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
		}),
		[
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
		]
	);
	const uiCtxValue = useMemo(
		() => ({
			search,
			setSearch,
			menu,
			setMenu,
			activeTool,
			setActiveTool,
			leftDrawerVisible,
			setLeftDrawerVisible,
			leftDrawerWidth,
			drawerHandleProps,
			leftPadding,
			consoleHeight,
			setConsoleHeight,
			consoleGap: CONSOLE_GAP,
			layoutConfirmOpen,
			setLayoutConfirmOpen,
			selectedTables,
			clearSelection
		}),
		[
			search,
			menu,
			activeTool,
			leftDrawerVisible,
			leftDrawerWidth,
			drawerHandleProps,
			leftPadding,
			consoleHeight,
			layoutConfirmOpen,
			setLayoutConfirmOpen,
			selectedTables,
			clearSelection
		]
	);
	const actionsCtxValue = useMemo(
		() => ({
			hideTable,
			unhideAll,
			hideSelected,
			createFrameFromSelection,
			handleFrameRename,
			handleFrameDelete,
			relayoutAll,
			addTableToFrame,
			removeTableFromFrame,
			commandGroups
		}),
		[
			hideTable,
			unhideAll,
			hideSelected,
			createFrameFromSelection,
			handleFrameRename,
			handleFrameDelete,
			relayoutAll,
			addTableToFrame,
			removeTableFromFrame,
			commandGroups
		]
	);

	return (
		<div
			ref={containerRef}
			className={activeTool === "frame" ? "canvas-tool-frame" : undefined}
			style={{ position: "relative", width: "100%", height: "100%" }}
		>
			{base === null ? (
				<div
					style={{
						position: "absolute",
						inset: 0,
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						fontSize: 13,
						color: "var(--sqlnest-text-secondary)",
						pointerEvents: "none",
						zIndex: 3
					}}
				>
					Calcul du layout…
				</div>
			) : null}

			{/* Overlay OPAQUE tant que useCanvasSync n'a pas hydraté depuis le
			 * serveur. Sans ça on voit brièvement l'état localStorage (frames
			 * résiduelles, positions old) puis un saut quand `replaceAll`
			 * applique le payload serveur. L'overlay masque cette fenêtre. */}
			{canvasReady ? null : (
				<div
					style={{
						position: "absolute",
						inset: 0,
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						fontSize: 12,
						color: "var(--sqlnest-text-tertiary)",
						background: "var(--sqlnest-canvas-bg)",
						zIndex: 100
					}}
				>
					Chargement du canvas…
				</div>
			)}

			<ReactFlow
				nodes={displayNodes as unknown as TableNodeType[]}
				edges={displayEdges}
				onNodesChange={handleNodesChange}
				nodeTypes={nodeTypes}
				edgeTypes={edgeTypes}
				// Comportements souris à la Figma :
				// - wheel/trackpad → pan (Cmd/Ctrl+wheel garde le zoom natif RF)
				// - clic gauche + drag sur le vide → lasso (sélection partielle :
				//   sélectionne dès qu'un nœud touche le rectangle, pas besoin
				//   d'être 100 % dedans)
				// - clic milieu drag → pan (fallback quand pas de wheel)
				// - clic droit sur le vide → aucun menu par défaut du navigateur
				//   (les nœuds gardent leur propre menu via `onNodeContextMenu`)
				panOnScroll
				zoomOnScroll={false}
				selectionOnDrag
				selectionMode={SelectionMode.Partial}
				panOnDrag={[1]}
				onSelectionStart={handleSelectionStart}
				onSelectionEnd={handleSelectionEnd}
				// Multi-select via click : accepte Shift OU le modifier natif de
				// l'OS (Cmd sur Mac, Ctrl sur Win/Linux). RF prend un array de
				// key codes — n'importe lequel matche. Ça couvre :
				//  - Shift+click (intuitif, cross-platform, comme Figma/Notion)
				//  - Cmd+click (attendu sur Mac — convention Finder / natif)
				//  - Ctrl+click (attendu sur Win/Linux — convention Explorer)
				multiSelectionKeyCode={["Shift", "Meta", "Control"]}
				onPaneContextMenu={(event) => event.preventDefault()}
				// Clic gauche seul = focus visuel (drawer détails + ring + estompage).
				// Clic avec modifier (Shift / Cmd / Ctrl) = sélection multi RF, on
				// n'ouvre PAS le drawer détails (sinon il masque le SelectionChip)
				// ET on clear un focus éventuel (sinon la table précédemment focus
				// garde son ring bleu foncé pendant que les autres ont juste le
				// contour selected bleu clair → styles mixtes visibles).
				// Double-clic = recadre sur la table (comme Figma).
				// Clic sur un frame → ouvre FrameDetails (liste des tables du frame)
				// dans le même drawer, avec back button vers l'arborescence.
				onNodeClick={(event, node) => {
					if (event.shiftKey || event.metaKey || event.ctrlKey) {
						setFocusId(null);
						setFocusFrameKey(null);
						return;
					}
					if ((node as { type?: string }).type === "frame") {
						const frameKey = node.id.replace(/^frame:/, "");
						focusFrame(frameKey);
						return;
					}
					focusNode(node.id);
				}}
				onNodeDoubleClick={(_, node) => {
					if ((node as { type?: string }).type === "frame") return;
					focusAndZoom(node.id);
				}}
				onNodeContextMenu={(event, node) => {
					if ((node as { type?: string }).type === "frame") return;
					event.preventDefault();
					// Focus visuel sans fitView : la vue ne bouge pas, donc le menu
					// positionné en clientX/Y reste face à la carte cliquée.
					focusNode(node.id);
					setMenu({
						x: event.clientX,
						y: event.clientY,
						tableName: node.id
					});
				}}
				onNodeDragStart={onNodeDragStart}
				onNodeDrag={onNodeDrag}
				onNodeDragStop={onNodeDragStop}
				onPaneClick={() => {
					setFocusId(null);
					setMenu(null);
				}}
				// `defaultViewport` = zoom initial garanti même quand le container
				// n'est pas encore mesuré (Mantine AppShell hydrate en 2 passes) ;
				// dès que les nodes sont mesurés, l'effet `nodesInitialized`
				// ci-dessus appelle `fitView(OVERVIEW_FIT)` pour un cadrage parfait.
				defaultViewport={{
					x: 0,
					y: 0,
					zoom: initialZoom(schema.collections.length)
				}}
				fitViewOptions={OVERVIEW_FIT}
				minZoom={0.02}
				maxZoom={1.75}
				onlyRenderVisibleElements
				proOptions={{ hideAttribution: false }}
			>
				{/* Grille de points fine sur bg #1E1E1E — couleur pilotée par
				 * `--sqlnest-canvas-dot` (rgba blanc à 8% pour rester discrète).
				 * `gap` conservé à 20 px : trop fin devient trop sale au zoom
				 * large, trop large casse la sensation de « papier millimétré ». */}
				<Background color="var(--sqlnest-canvas-dot)" gap={20} />
				{/* Contrôles RF (+/−, fit) et minimap remontés au-dessus de la
				 * console SNQL — sans ça ils passent derrière quand elle est
				 * ouverte. Bottom = hauteur console + gap standard. `left` suit
				 * `leftPadding` pour rester à côté du drawer (comme la console). */}
				<Controls
					showInteractive={false}
					style={{
						bottom: consoleHeight + CONSOLE_GAP + 4,
						left: leftPadding
					}}
				/>
				<MiniMap
					pannable
					zoomable
					nodeColor={(n) => {
						if (n.type === "frame") return "transparent";
						return (n.data as TableNodeType["data"]).collection.source ===
							"inferred"
							? INFERRED
							: DECLARED;
					}}
					nodeStrokeWidth={0}
					// Bg + maskColor gérés par `canvas-overrides.css` (règles
					// `.react-flow__minimap*`) pour rester cohérent avec le reste des
					// surfaces dark. Seul le `bottom` est calculé dynamiquement ici
					// (dépend de la console SNQL).
					style={{
						bottom: consoleHeight + CONSOLE_GAP + 4
					}}
				/>
				{focusId ? (
					<Panel position="bottom-center">
						<button
							type="button"
							onClick={clearFocus}
							style={{
								border: "1px solid var(--sqlnest-border)",
								background: "var(--sqlnest-surface)",
								color: "var(--sqlnest-accent)",
								fontWeight: 600,
								fontSize: 12,
								padding: "6px 12px",
								borderRadius: 8,
								cursor: "pointer",
								boxShadow: "0 2px 8px rgba(0,0,0,0.32)"
							}}
						>
							↺ tout afficher
						</button>
					</Panel>
				) : null}
			</ReactFlow>

			<CanvasProviders
				data={dataCtxValue}
				focus={focusCtxValue}
				ui={uiCtxValue}
				actions={actionsCtxValue}
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
	schemaLabel
}: {
	schema: SchemaModel;
	schemaLabel?: string;
}) {
	// Remonte tout le flow au changement de schéma : état React Flow réinitialisé
	// proprement, le graphe se recadre au montage. Clé combinant moteur, taille et
	// première/dernière table — assez discriminante pour deux schémas distincts.
	const cols = schema.collections;
	const key = `${schema.engine}:${cols.length}:${cols[0]?.name ?? ""}:${cols[cols.length - 1]?.name ?? ""}`;
	return (
		<ReactFlowProvider key={key}>
			<CanvasInner schema={schema} schemaLabel={schemaLabel} />
		</ReactFlowProvider>
	);
}
