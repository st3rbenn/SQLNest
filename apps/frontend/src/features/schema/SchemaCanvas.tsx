import {
	SelectionChip,
	showNotification,
	Spotlight,
	spotlight,
	useCommandPaletteShortcut
} from "@sqlnest/design-system";
import { buildCanvasCommands } from "./commands";
import { ActionIcon, Box } from "@mantine/core";
import {
	IconLayoutSidebarLeftCollapse,
	IconLayoutSidebarLeftExpand
} from "@tabler/icons-react";
import {
	Background,
	Controls,
	type Edge,
	MarkerType,
	MiniMap,
	type NodeChange,
	Panel,
	ReactFlow,
	ReactFlowProvider,
	SelectionMode,
	useNodesState,
	useReactFlow
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./canvas-overrides.css";
import {
	startTransition,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState
} from "react";
import {
	animateViewport,
	FOCUS_TWEEN_MS,
	FOCUS_ZOOM_MIN,
	focusZoom,
	initialZoom,
	OVERVIEW_FIT,
	overviewViewport,
	tablesBounds,
	type Viewport
} from "./canvas/viewport";
import { AutoLayoutModal } from "./canvas/AutoLayoutModal";
import { useCanvasHistory } from "./canvas/useCanvasHistory";
import {
	boundsOfTables,
	computeFrameNodes,
	FRAME_PAD
} from "./canvas/computeFrameNodes";
import { DrawerPane, useResizableDrawer } from "./canvas/DrawerPane";
import { HiddenChip } from "./canvas/HiddenChip";
import { useCanvasFocus } from "./canvas/useCanvasFocus";
import { useCanvasSelection } from "./canvas/useCanvasSelection";
import { CanvasConsole } from "./CanvasConsole";
import { CanvasContextMenu } from "./CanvasContextMenu";
import { CanvasToolbar } from "./CanvasToolbar";
import { bestHandles, type Side, spreadOffsets } from "./edgeRouting";
import { FrameNode, type FrameNodeType } from "./FrameNode";
import { type Frame, type FrameRect, rectContainsPoint } from "./frames";
import { InteractiveEdge, type InteractiveEdgeData } from "./InteractiveEdge";
import { buildLayout, type LayoutResult } from "./layout";
import type { SchemaModel } from "./schema-model";
import {
	NODE_WIDTH,
	nodeHeight,
	TableNode,
	type TableNodeType
} from "./TableNode";
import { useEdgeAnchors } from "./useEdgeAnchors";
import { useFrames } from "./useFrames";
import { useTablePositions, type XY } from "./useTablePositions";
import { useTableSizes } from "./useTableSizes";

const DECLARED = "#2563eb";
const INFERRED = "#d97706";
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

function CanvasInner({ schema }: { schema: SchemaModel }) {
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

	// nodes reflètent les positions vivantes (drag) ; réinitialisés dès qu'ELK rend.
	const [nodes, setNodes, onNodesChange] = useNodesState<TableNodeType>([]);

	// Positions user persistées en localStorage — overlay au-dessus du layout ELK
	// pour que la disposition survive au refresh (sans ça, ELK re-place tout,
	// les tables sortent des frames, la membership devient fantôme et se fait
	// nettoyer par le filtre post-layout). Lu via ref dans l'effet ci-dessous
	// pour NE PAS re-déclencher `setNodes(base.nodes)` à chaque persistance —
	// sinon chaque drag-stop réappliquerait l'overlay et pourrait clignoter.
	const tablePositions = useTablePositions(schema);
	const tablePositionsRef = useRef(tablePositions.positions);
	tablePositionsRef.current = tablePositions.positions;
	// Sizes user persistées (NodeResizer 4 côtés de chaque table) — même
	// pattern d'overlay que positions : ref pour éviter le re-seed en boucle.
	// Stocke width ET height : le user peut resize dans les 2 axes.
	const tableSizes = useTableSizes(schema);
	const tableSizesRef = useRef(tableSizes.sizes);
	tableSizesRef.current = tableSizes.sizes;
	useEffect(() => {
		if (base !== null) {
			const savedPos = tablePositionsRef.current;
			const savedSize = tableSizesRef.current;
			setNodes(
				base.nodes.map((n) => {
					const pos = savedPos[n.id];
					const size = savedSize[n.id];
					return {
						...n,
						...(pos !== undefined ? { position: pos } : {}),
						...(size?.width !== undefined ? { width: size.width } : {}),
						...(size?.height !== undefined ? { height: size.height } : {})
					};
				})
			);
		}
	}, [base, setNodes]);

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
	const { getViewport, setViewport } = useReactFlow();
	const containerRef = useRef<HTMLDivElement | null>(null);
	// Handle du tween en cours — annulé si un nouveau focus arrive.
	const tweenRef = useRef<{ cancel: () => void } | null>(null);

	// Frames user-defined (persistés en localStorage). Remplace le
	// `framesFor(schema)` statique — l'utilisateur crée/retire ses frames
	// via lasso + F et le menu contextuel « Retirer du frame ».
	const framesApi = useFrames(schema);

	// Historique undo/redo — capture positions + sizes + frames + hiddenIds.
	// `history.push()` doit être appelé APRÈS chaque geste user notable
	// (drag stop, resize end, create/remove/rename frame, hide/unhide,
	// auto-layout). Le hook maintient l'invariant « past = états
	// pré-mutation » via un `prevRef` resynchronisé post-commit — voir
	// `useCanvasHistory` pour l'analyse détaillée du timing.
	const history = useCanvasHistory({
		tablePositions,
		tableSizes,
		framesApi,
		hiddenIds,
		setHiddenIds
	});

	// Frames : deux chemins d'update qui doivent cohabiter sans se marcher
	// dessus :
	//   (A) DRAG du frame — le user attrape le corps → `onNodeDrag` custom
	//       (plus bas) shift TOUS les membres + call setFrameRect à chaque
	//       tick. `frameDragStateRef` est set pendant ce geste.
	//   (B) RESIZE via handle NodeResizer — RF dispatche `dimensions` et,
	//       pour les corners top/left, ALSO des `position` NodeChange.
	//       `onNodeDrag` NE fire PAS. Ces changes finissent par défaut dans
	//       `applyNodeChanges(nodes)` où `nodes` ne contient que les tables →
	//       drop silencieux → resize visuellement figé.
	// Notre `handleNodesChange` intercepte (B) : dimensions + position pour
	// les IDs `frame:*` → route vers `framesApi.setFrameRect`. On saute les
	// `position` quand un drag est en cours pour le frame concerné (chemin A
	// gère déjà, éviter la double-update).
	const framesApiRef = useRef(framesApi);
	framesApiRef.current = framesApi;
	const frameDragStateRef = useRef<{
		frameKey: string;
		frameOrigin: { x: number; y: number };
		rectSize: { width: number; height: number };
		memberOrigins: Map<string, { x: number; y: number }>;
	} | null>(null);
	const handleNodesChange = useCallback(
		(changes: NodeChange[]) => {
			const restChanges: NodeChange[] = [];
			const api = framesApiRef.current;
			// RF émet dimensions ET position dans le MÊME batch pour un resize
			// depuis un corner top/left. On doit fusionner par frame avant l'écriture
			// — sinon deux `setFrameRect` séquentiels lisent `frame.rect` frozen
			// avant le premier setState (async), et le 2e écrase le 1er.
			// Bug symptomatique : tire vers la gauche → seule `position.x` s'applique,
			// la nouvelle `width` est perdue → visuellement le frame « pousse à droite ».
			const perFrame = new Map<
				string,
				{ x?: number; y?: number; width?: number; height?: number }
			>();
			for (const c of changes) {
				if (!c.id?.startsWith("frame:")) {
					restChanges.push(c);
					continue;
				}
				const key = c.id.slice("frame:".length);
				if (c.type === "dimensions" && c.dimensions) {
					// RF émet AUSSI des `dimensions` en dehors de tout geste (mesure
					// DOM auto). `resizing !== true` = mesure → on ignore, sinon on
					// écrit à chaque render la même dimension et on peut casser le rect.
					if (c.resizing !== true) continue;
					const entry = perFrame.get(key) ?? {};
					entry.width = c.dimensions.width;
					entry.height = c.dimensions.height;
					perFrame.set(key, entry);
				} else if (c.type === "position" && c.position) {
					// `position` sur un frame — deux origines :
					//   1) resize corner top/left → RF émet position (`dragging: false`)
					//   2) drag manuel → `dragging: true`, géré par `onNodeDrag` custom
					//      qui shift les membres. SKIP ici pour éviter la double-update.
					if (c.dragging === true) continue;
					const entry = perFrame.get(key) ?? {};
					entry.x = c.position.x;
					entry.y = c.position.y;
					perFrame.set(key, entry);
				}
				// select/remove/… pour les frames → ignorés (non-selectable).
			}
			for (const [key, entry] of perFrame) {
				const frame = api.frames.find((f) => f.key === key);
				if (!frame?.rect) continue;
				api.setFrameRect(key, {
					x: entry.x ?? frame.rect.x,
					y: entry.y ?? frame.rect.y,
					width: entry.width ?? frame.rect.width,
					height: entry.height ?? frame.rect.height
				});
			}
			if (restChanges.length > 0) onNodesChange(restChanges);
		},
		[onNodesChange]
	);

	// Overrides d'ancres par edge (source-side / target-side). Persistés en
	// localStorage par signature de schéma. Lus dans `displayEdges` avec
	// fallback sur l'auto-routing (`bestHandles`) quand aucun override n'est
	// posé. Setters passés aux edges via `data` (voir InteractiveEdge).
	const edgeAnchors = useEdgeAnchors(schema);

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

	// Post-ELK : fige le rect des frames-seed depuis les positions ELK. Un
	// frames-seed n'a pas de rect persisté (c'est le rôle de ce `useEffect`
	// de le calculer une fois puis de le sauver). Les frames user-created ont
	// déjà leur rect posé au moment du `createFrame`.
	//
	// Note : plus de filtre "membre hors du rect → remove". Avec les positions
	// persistées, le rect + la membership sont indépendants — un membre peut
	// être temporairement hors rect (ex. ajouté via context menu sans être
	// déplacé, ou frame resizé plus petit sans déplacer les tables). Le retirer
	// automatiquement provoquait un bug drag : la table "abandonnée" restait
	// en place alors que le frame se déplaçait. Les gestes utilisateur (resize
	// via handle, drag-out d'une table) continuent de nettoyer la membership.
	const membershipRefreshedFor = useRef<LayoutResult | null>(null);
	useEffect(() => {
		if (base === null || nodes.length === 0) return;
		if (membershipRefreshedFor.current === base) return;
		membershipRefreshedFor.current = base;
		const byId = new Map(nodes.map((n) => [n.id, n]));
		for (const frame of framesApi.frames) {
			if (frame.rect) continue;
			const members = frame.collections
				.map((c) => byId.get(c))
				.filter((n): n is TableNodeType => n !== undefined);
			const rect = boundsOfTables(members, FRAME_PAD);
			if (rect) framesApi.setFrameRect(frame.key, rect);
		}
		// biome-ignore lint/correctness/useExhaustiveDependencies: framesApi lu via closure — ok car le ref garantit exec unique
	}, [base, nodes]);

	// Voisinage FK direct du nœud focalisé (le nœud + ses 1-sauts).
	const neighbors = useMemo(() => {
		if (focusId === null || base === null) return null;
		const set = new Set<string>([focusId]);
		for (const e of base.edges) {
			if (e.source === focusId) set.add(e.target);
			if (e.target === focusId) set.add(e.source);
		}
		return set;
	}, [focusId, base]);

	// Callback stable pour le NodeResizer d'une table : persist les nouvelles
	// dimensions ET la nouvelle position au release. La position CHANGE quand
	// le user tire depuis un handle top ou left (RF déplace l'origine pour
	// garder l'opposé fixe). Sans persister x/y, un refresh remettait la table
	// à l'ancienne origine → elle semblait grossir uniquement vers la droite.
	const handleTableResize = useCallback(
		(name: string, size: { width: number; height: number; x: number; y: number }) => {
			tableSizes.setSize(name, { width: size.width, height: size.height });
			tablePositions.setPosition(name, { x: size.x, y: size.y });
			history.push();
		},
		[tableSizes, tablePositions, history]
	);

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

	// Ref sur les nodes courants — le handler de resize a besoin de la
	// dernière version des positions sans refermer sur une snapshot obsolète.
	const nodesRef = useRef(nodes);
	nodesRef.current = nodes;

	// `frameDragStateRef` déclaré plus haut (partagé avec handleNodesChange
	// pour éviter la double-update des `position` NodeChange pendant un drag).
	// Le snapshot capturé au `onNodeDragStart` calcule un delta ABSOLU depuis
	// l'origine → immune au batching React 18 (plusieurs mousemove peuvent
	// tirer avant qu'un setFrameRect ait committé, dx naïf `node.position -
	// frame.rect` exploserait, les membres dériveraient plus vite que le
	// frame).

	// Callback `onResizeEnd` du NodeResizer — le rect a déjà été persisté en
	// direct par `handleNodesChange` (intercept live des dimensions/position).
	// Ici on ne fait QUE la reconciliation membership : table dont le centre
	// tombe HORS du rect final → retirée du frame (sinon un drag du frame la
	// ferait suivre alors qu'elle est visuellement dehors). Pas de nouveau
	// `setFrameRect` — c'était un doublon qui écrasait le rect live avec le
	// rect final tel que reçu du NodeResizer (précision floats + timing) et
	// qui semblait provoquer des jumps + un état bancal empêchant le drag
	// suivant.
	const handleFrameResize = useCallback(
		(key: string, newRect: FrameRect) => {
			const api = framesApiRef.current;
			const frame = api.frames.find((f) => f.key === key);
			if (!frame) return;
			const byId = new Map(nodesRef.current.map((n) => [n.id, n]));
			for (const memberName of frame.collections) {
				const node = byId.get(memberName);
				if (!node) continue;
				const w = node.width ?? NODE_WIDTH;
				const h = node.height ?? nodeHeight(node.data.collection);
				const center = {
					x: node.position.x + w / 2,
					y: node.position.y + h / 2
				};
				if (!rectContainsPoint(newRect, center)) {
					api.removeTableFromFrame(memberName);
				}
			}
			// Le rect final a déjà été persisté en direct par `handleNodesChange`
			// (intercept live des dimensions). On checkpoint ici, une seule fois
			// au release — pas pendant le drag continu du handle.
			history.push();
		},
		[history]
	);

	// Rename inline depuis le badge d'un frame (double-clic → input → Enter).
	const handleFrameRename = useCallback(
		(key: string, label: string) => {
			framesApi.renameFrame(key, label);
			history.push();
		},
		[framesApi, history]
	);

	// Right-click sur le badge d'un frame → supprime (l'auto-delete a été
	// retiré, il faut un geste explicite maintenant).
	const handleFrameDelete = useCallback(
		(key: string) => {
			const frame = framesApi.frames.find((f) => f.key === key);
			framesApi.removeFrame(key);
			if (frame) {
				showNotification({
					title: `Frame « ${frame.label} » supprimé`,
					message: `${frame.collections.length} table${frame.collections.length > 1 ? "s" : ""} conservée${frame.collections.length > 1 ? "s" : ""}.`,
					color: "blue",
					autoClose: 2500
				});
			}
			history.push();
		},
		[framesApi, history]
	);

	const handleFrameFocus = useCallback(
		(key: string) => focusFrame(key),
		// biome-ignore lint/correctness/useExhaustiveDependencies: focusFrame stable (setState setter closure)
		[]
	);
	const frameNodes = useMemo(
		() =>
			computeFrameNodes(
				framesApi.frames,
				nodes.filter((n) => !hiddenIds.has(n.id)),
				handleFrameResize,
				handleFrameRename,
				handleFrameDelete,
				handleFrameFocus
			),
		[
			framesApi.frames,
			nodes,
			hiddenIds,
			handleFrameResize,
			handleFrameRename,
			handleFrameDelete,
			handleFrameFocus
		]
	);

	const displayNodes = useMemo<SchemaNode[]>(
		() => [...frameNodes, ...displayTableNodes],
		[frameNodes, displayTableNodes]
	);

	// Index rapide pour l'auto-routing des edges — évite un O(n) par edge.
	const nodeById = useMemo(() => {
		const map = new Map<string, TableNodeType>();
		for (const n of nodes) map.set(n.id, n);
		return map;
	}, [nodes]);

	// Enveloppe stable pour passer les setters d'ancres aux edges via
	// `data` — recréée seulement si l'API change (refs stables via
	// useCallback dans useEdgeAnchors).
	const anchorApi = useMemo<InteractiveEdgeData>(
		() => ({
			setOverride: edgeAnchors.setOverride,
			clearOverride: edgeAnchors.clearOverride
		}),
		[edgeAnchors.setOverride, edgeAnchors.clearOverride]
	);

	const displayEdges = useMemo(() => {
		const visible = (base?.edges ?? []).filter(
			(e) => !hiddenIds.has(e.source) && !hiddenIds.has(e.target)
		);
		// Pass 1 : résout side source + side target de chaque edge
		// (override > auto-routing). Sert de base au groupement offset.
		const resolved = visible.map((e) => {
			const src = nodeById.get(e.source);
			const tgt = nodeById.get(e.target);
			const auto =
				src && tgt
					? bestHandles(
							{
								x: src.position.x,
								y: src.position.y,
								width: src.width ?? NODE_WIDTH,
								height: src.height ?? nodeHeight(src.data.collection)
							},
							{
								x: tgt.position.x,
								y: tgt.position.y,
								width: tgt.width ?? NODE_WIDTH,
								height: tgt.height ?? nodeHeight(tgt.data.collection)
							}
						)
					: null;
			const override = edgeAnchors.overrides[e.id];
			const sourceHandle: Side | undefined = override?.source ?? auto?.source;
			const targetHandle: Side | undefined = override?.target ?? auto?.target;
			return { edge: e, sourceHandle, targetHandle };
		});

		// Pass 2 : groupe les edges par (nodeId, side) — pour source ET target —
		// pour distribuer leurs endpoints le long du côté partagé (sans ça,
		// plusieurs arrows convergent au mid-side et se superposent, impossibles
		// à cibler individuellement).
		const srcGroups = new Map<string, string[]>();
		const tgtGroups = new Map<string, string[]>();
		for (const { edge, sourceHandle, targetHandle } of resolved) {
			if (sourceHandle) {
				const key = `${edge.source}:${sourceHandle}`;
				const list = srcGroups.get(key) ?? [];
				list.push(edge.id);
				srcGroups.set(key, list);
			}
			if (targetHandle) {
				const key = `${edge.target}:${targetHandle}`;
				const list = tgtGroups.get(key) ?? [];
				list.push(edge.id);
				tgtGroups.set(key, list);
			}
		}
		// Pass 3 : calcule le ratio d'offset par edge/end.
		const offsets = new Map<string, { source?: number; target?: number }>();
		for (const [, ids] of srcGroups) {
			const ratios = spreadOffsets(ids.length);
			ids.forEach((id, i) => {
				const prev = offsets.get(id) ?? {};
				offsets.set(id, { ...prev, source: ratios[i] });
			});
		}
		for (const [, ids] of tgtGroups) {
			const ratios = spreadOffsets(ids.length);
			ids.forEach((id, i) => {
				const prev = offsets.get(id) ?? {};
				offsets.set(id, { ...prev, target: ratios[i] });
			});
		}

		// Pass 4 : compose l'edge final (styles + handles + data avec offsets).
		return resolved.map(({ edge: e, sourceHandle, targetHandle }) => {
			const touchesFocus =
				focusId !== null && (e.source === focusId || e.target === focusId);
			const dim = focusId !== null && !touchesFocus;
			const inferred = (e.data as { inferred?: boolean })?.inferred;
			const o = offsets.get(e.id);
			return {
				...e,
				...(sourceHandle !== undefined ? { sourceHandle } : {}),
				...(targetHandle !== undefined ? { targetHandle } : {}),
				style: {
					...e.style,
					stroke: dim ? "#cbd5e1" : inferred ? INFERRED : DECLARED,
					strokeWidth: touchesFocus ? 2.5 : 1.5,
					opacity: dim ? 0.35 : 1
				},
				zIndex: touchesFocus ? 10 : 0,
				data: {
					...(e.data ?? {}),
					...anchorApi,
					sourceOffsetRatio: o?.source ?? 0,
					targetOffsetRatio: o?.target ?? 0
				}
			};
		});
	}, [base, focusId, hiddenIds, nodeById, edgeAnchors.overrides, anchorApi]);

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
	const safeArea = useMemo(
		() => ({
			left: leftPadding,
			right: 8,
			top: 12,
			bottom: 68 + consoleHeight + CONSOLE_GAP
		}),
		[consoleHeight, leftPadding]
	);

	// Vue aérienne — auto-fit au mount du layout ELK, puis refit uniquement
	// quand le CONTAINER change de taille (resize fenêtre). Sans ça :
	//   - le container peut être mesuré à une taille intermédiaire pendant
	//     l'hydratation, le fit s'y bloque (rect capturé trop petit sur les
	//     écrans larges → schéma décollé du centre).
	//   - le refresh sur une fenêtre différente laisse le schéma dans un
	//     coin.
	// `safeArea` **N'EST PAS** dans les deps : ses changements (toggle drawer,
	// focus qui ouvre TableDetails, console qui grandit) ne doivent PAS reset
	// la vue de l'utilisateur — sinon toggler le drawer ou focuser une table
	// « recadre » sous les pieds. Le safeArea est lu via ref pour être frais
	// quand le fit legitime tourne (mount + resize).
	const safeAreaRef = useRef(safeArea);
	safeAreaRef.current = safeArea;
	const userTouchedViewportRef = useRef(false);
	useEffect(() => {
		if (base === null) return;
		const el = containerRef.current;
		if (el === null) return;

		const fit = () => {
			if (userTouchedViewportRef.current) return;
			const rect = el.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) return;
			const bounds = tablesBounds(base.nodes);
			if (bounds === null) return;
			setViewport(
				overviewViewport(bounds, rect, {
					padding: OVERVIEW_FIT.padding,
					maxZoom: OVERVIEW_FIT.maxZoom,
					minZoom: OVERVIEW_FIT.minZoom,
					safeArea: safeAreaRef.current
				})
			);
		};

		fit();
		const ro = new ResizeObserver(fit);
		ro.observe(el);
		return () => ro.disconnect();
	}, [base, setViewport]);
	// Reset du flag "user touched" quand base change (nouveau schéma =
	// nouvelle vue par défaut, on ré-auto-fit jusqu'à interaction).
	useEffect(() => {
		userTouchedViewportRef.current = false;
	}, [base]);
	// Détecte les gestes viewport user (wheel = zoom, mousedown sur la
	// pane = début de pan). Une fois marqué, l'auto-fit s'arrête → la
	// vue de l'utilisateur est préservée sur les resize suivants.
	useEffect(() => {
		const el = containerRef.current;
		if (el === null) return;
		const markWheel = () => {
			userTouchedViewportRef.current = true;
		};
		const markPan = (e: PointerEvent) => {
			const t = e.target as HTMLElement | null;
			// Pan démarre depuis la pane vide (pas sur un nœud/edge/UI).
			if (t?.classList.contains("react-flow__pane")) {
				userTouchedViewportRef.current = true;
			}
		};
		el.addEventListener("wheel", markWheel, { passive: true });
		el.addEventListener("pointerdown", markPan);
		return () => {
			el.removeEventListener("wheel", markWheel);
			el.removeEventListener("pointerdown", markPan);
		};
	}, []);

	/** Focus + recadrage sur la table. Utilisé par les points d'entrée
	 * « distants » — arbre, palette Cmd+K, menu Détails, FK cliquables du
	 * drawer — où l'utilisateur cherche activement une table et veut être
	 * amené dessus. Aussi le double-clic sur la carte.
	 *
	 * Stratégie « zoom-in-only » : si la vue est déjà zoomée (≥ FOCUS_ZOOM_MIN),
	 * on GARDE le zoom courant et on se contente d'un pan animé. Si le zoom est
	 * en-dessous (vue aérienne), on zoome IN au seuil lisible. On ne dézoome
	 * JAMAIS — cliquer sur une table doit toujours « rapprocher », comme un
	 * zoom Figma sur un objet. */
	const focusAndZoom = (id: string) => {
		const node = nodes.find((n) => n.id === id);
		if (!node || containerRef.current === null) {
			setFocusId(id);
			return;
		}
		const cx = node.position.x + (node.width ?? NODE_WIDTH) / 2;
		const cy =
			node.position.y + (node.height ?? nodeHeight(node.data.collection)) / 2;
		const from = getViewport();
		const zoom = focusZoom(from.zoom, { min: FOCUS_ZOOM_MIN });
		const rect = containerRef.current.getBoundingClientRect();
		const sa = safeAreaRef.current;
		const freeCenterX = sa.left + (rect.width - sa.left - sa.right) / 2;
		const freeCenterY = sa.top + (rect.height - sa.top - sa.bottom) / 2;
		const to: Viewport = {
			x: freeCenterX - cx * zoom,
			y: freeCenterY - cy * zoom,
			zoom
		};
		// Annule le tween précédent s'il est encore en cours, puis anime.
		// `setFocusId` (ring/drawer/estompage) déféré via `startTransition`
		// pour qu'il n'interrompe pas le tween mid-animation.
		// Marque userTouched AVANT le tween : `setFocusId` change `safeArea`
		// (drawer droit ouvre → right passe de 8 à 352), ce qui déclenche le
		// `useEffect(fit, [safeArea])` — sans ce flag, ce fit écrase notre
		// tween par un retour à l'overview (bug « ça dezoom au click »).
		userTouchedViewportRef.current = true;
		tweenRef.current?.cancel();
		tweenRef.current = animateViewport(from, to, FOCUS_TWEEN_MS, setViewport);
		startTransition(() => setFocusId(id));
	};

	const applyOverview = () => {
		if (base === null || containerRef.current === null) return;
		const bounds = tablesBounds(base.nodes);
		if (bounds === null) return;
		const rect = containerRef.current.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;
		setViewport(
			overviewViewport(bounds, rect, {
				padding: OVERVIEW_FIT.padding,
				maxZoom: OVERVIEW_FIT.maxZoom,
				minZoom: OVERVIEW_FIT.minZoom,
				safeArea
			}),
			{ duration: OVERVIEW_FIT.duration }
		);
	};
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

	// « Auto-layout » : forcer les positions ELK et les persister par-dessus
	// les sauvegardes user + RECOMPUTER le rect des frames pour qu'ils
	// suivent la nouvelle disposition (sans ça, les frames restent à leur
	// ancien rect → tables « fantômes » qui suivent le frame au drag alors
	// qu'elles sont visuellement dehors, souvenir cuisant du user).
	// Modal de confirmation obligatoire (`layoutConfirmOpen`) parce que le
	// geste est massif et non-trivialement réversible tant qu'on n'a pas
	// d'historique undo.
	const [layoutConfirmOpen, setLayoutConfirmOpen] = useState(false);
	const relayoutAll = () => {
		if (base === null) return;
		setNodes(base.nodes);
		const entries: Record<string, XY> = {};
		for (const n of base.nodes) entries[n.id] = n.position;
		tablePositions.setManyPositions(entries);
		// Recompute chaque frame rect depuis les nouvelles positions ELK de
		// ses membres. Frames sans membres → laissés en l'état (rare, cas
		// dégénéré). `boundsOfTables` inclut déjà le pad.
		const byId = new Map(base.nodes.map((n) => [n.id, n]));
		for (const frame of framesApi.frames) {
			const members = frame.collections
				.map((c) => byId.get(c))
				.filter((n): n is TableNodeType => n !== undefined);
			const rect = boundsOfTables(members, FRAME_PAD);
			if (rect !== null) framesApi.setFrameRect(frame.key, rect);
		}
		applyOverview();
		history.push();
	};

	const hideTable = (name: string) => {
		setHiddenIds((prev) => {
			const next = new Set(prev);
			next.add(name);
			return next;
		});
		if (focusId === name) setFocusId(null);
		showNotification({
			title: "Table masquée",
			message: `${name} — restaure via « Tout réafficher ».`,
			color: "blue",
			autoClose: 2000
		});
		history.push();
	};

	const unhideAll = () => {
		setHiddenIds(new Set());
		history.push();
	};

	// ─── frames user-defined (tour 1d) ────────────────────────────────────
	// Shortcut `F` : crée un frame à partir de la sélection courante.
	// Aussi appelable depuis le SelectionChip / la palette.
	const createFrameFromSelection = useCallback(() => {
		if (selectedTables.length === 0) return;
		const selectedNodes = nodes.filter((n) => selectedTables.includes(n.id));
		const rect = boundsOfTables(selectedNodes, FRAME_PAD);
		const frame = framesApi.createFrame(selectedTables, {
			...(rect ? { rect } : {})
		});
		showNotification({
			title: `Frame « ${frame.label} » créé`,
			message: `${selectedTables.length} table${selectedTables.length > 1 ? "s" : ""} groupée${selectedTables.length > 1 ? "s" : ""}`,
			color: "green",
			autoClose: 2500
		});
		history.push();
	}, [selectedTables, nodes, framesApi, history]);

	const hideSelected = useCallback(() => {
		if (selectedTables.length === 0) return;
		setHiddenIds((prev) => {
			const next = new Set(prev);
			for (const t of selectedTables) next.add(t);
			return next;
		});
		history.push();
	}, [selectedTables, history]);

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key !== "f" && e.key !== "F") return;
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			const target = e.target as HTMLElement | null;
			// Ignore quand l'utilisateur tape dans un input.
			if (
				target &&
				(target.tagName === "INPUT" ||
					target.tagName === "TEXTAREA" ||
					target.isContentEditable)
			) {
				return;
			}
			if (selectedTables.length === 0) return;
			e.preventDefault();
			createFrameFromSelection();
			clearSelection();
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [selectedTables, createFrameFromSelection, clearSelection]);

	// ─── palette Cmd+K (tour 1c) ──────────────────────────────────────────
	useCommandPaletteShortcut(spotlight.open);
	const soon = (title: string) =>
		showNotification({
			title,
			message: "Bientôt disponible.",
			color: "amber",
			autoClose: 2000
		});
	const commandGroups = useMemo(
		() =>
			buildCanvasCommands(schema, {
				// Palette = entrée distante → recadre sur la table choisie.
				onFocusTable: focusAndZoom,
				onFitView: () => applyOverview(),
				onAskAi: () => soon("Demander à l'IA"),
				onToggleTheme: () => soon("Thème sombre")
			}),
		// biome-ignore lint/correctness/useExhaustiveDependencies: focusAndZoom/fitView are stable enough for the palette lifetime
		[schema]
	);

	return (
		<div
			ref={containerRef}
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
						color: "#64748b",
						pointerEvents: "none",
						zIndex: 3
					}}
				>
					Calcul du layout…
				</div>
			) : null}

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
				onNodeDragStart={(_, node) => {
					// Drag d'un frame : snapshot des positions initiales du frame
					// et de tous ses membres. Le drag calculera un delta ABSOLU
					// depuis ces origines — immune au batching React 18 (voir
					// commentaire de `frameDragStateRef`).
					if ((node as { type?: string }).type !== "frame") return;
					const frameKey = node.id.replace(/^frame:/, "");
					const frame = framesApi.frames.find((f) => f.key === frameKey);
					if (!frame || !frame.rect) return;
					const members = new Set(frame.collections);
					const memberOrigins = new Map<string, { x: number; y: number }>();
					for (const n of nodesRef.current) {
						if (members.has(n.id))
							memberOrigins.set(n.id, { x: n.position.x, y: n.position.y });
					}
					frameDragStateRef.current = {
						frameKey,
						frameOrigin: { x: node.position.x, y: node.position.y },
						rectSize: { width: frame.rect.width, height: frame.rect.height },
						memberOrigins
					};
				}}
				onNodeDrag={(_, node) => {
					// Drag d'un frame → applique le delta ABSOLU aux positions
					// initiales des membres. Frame et tables bougent ensemble
					// sous le curseur sans dérive.
					if ((node as { type?: string }).type !== "frame") return;
					const state = frameDragStateRef.current;
					if (!state) return;
					const dx = node.position.x - state.frameOrigin.x;
					const dy = node.position.y - state.frameOrigin.y;
					setNodes((ns) =>
						ns.map((n) => {
							const origin = state.memberOrigins.get(n.id);
							if (!origin) return n;
							return {
								...n,
								position: { x: origin.x + dx, y: origin.y + dy }
							};
						})
					);
					framesApi.setFrameRect(state.frameKey, {
						x: node.position.x,
						y: node.position.y,
						width: state.rectSize.width,
						height: state.rectSize.height
					});
				}}
				onNodeDragStop={(_, node) => {
					// Drag d'un frame → persiste les positions finales de ses
					// membres (ceux-ci ont été shiftés en direct par `onNodeDrag`).
					// Le rect du frame est déjà persisté via `setFrameRect` dans
					// `onNodeDrag`. Sans ça, un refresh restaurerait le rect mais
					// pas les tables → membership fantôme, filtre nettoie, frame
					// vide.
					if ((node as { type?: string }).type === "frame") {
						const state = frameDragStateRef.current;
						frameDragStateRef.current = null;
						if (!state) return;
						const entries: Record<string, XY> = {};
						for (const n of nodesRef.current) {
							if (state.memberOrigins.has(n.id)) entries[n.id] = n.position;
						}
						if (Object.keys(entries).length > 0) {
							tablePositions.setManyPositions(entries);
						}
						// Checkpoint après drag frame (rect + positions membres).
						history.push();
						return;
					}
					// Une table posée : recalcule son appartenance à un frame en
					// testant si son centre est dans un rect. Une seule frame par
					// table (celui du dessous emporte s'il y a chevauchement, ce
					// qui est rare avec des frames non-imbriqués).
					const w = (node as { width?: number }).width ?? NODE_WIDTH;
					const h = (node as { height?: number }).height ?? 200;
					const center = {
						x: node.position.x + w / 2,
						y: node.position.y + h / 2
					};
					// Membership au drag (comme Figma) :
					// - drop dans un frame ≠ actuel → add (drag-in ou switch)
					// - drop en dehors de tout frame → remove (drag-out)
					// - drop dans le frame actuel → no-op (repositionnement interne)
					const current = framesApi.frameOfTable(node.id);
					let dropped: Frame | null = null;
					for (const f of framesApi.frames) {
						if (!f.rect) continue;
						if (rectContainsPoint(f.rect, center)) {
							dropped = f;
							break;
						}
					}
					if (dropped && (!current || current.key !== dropped.key)) {
						framesApi.addTableToFrame(dropped.key, node.id);
					} else if (!dropped && current) {
						framesApi.removeTableFromFrame(node.id);
					}
					// Persiste la position finale (survit au refresh).
					tablePositions.setPosition(node.id, node.position);
					// Checkpoint après drag stop d'une table (position + éventuel
					// changement de membership frame).
					history.push();
				}}
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
				<Background color="#e2e8f0" gap={20} />
				{/* Contrôles RF (+/−, fit) et minimap remontés au-dessus de la
				 * console SNQL — sans ça ils passent derrière quand elle est
				 * ouverte. Bottom = hauteur console + gap standard. */}
				<Controls
					showInteractive={false}
					style={{ bottom: consoleHeight + CONSOLE_GAP + 4 }}
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
					style={{
						background: "#f8fafc",
						bottom: consoleHeight + CONSOLE_GAP + 4
					}}
				/>
				{focusId ? (
					<Panel position="bottom-center">
						<button
							type="button"
							onClick={clearFocus}
							style={{
								border: "none",
								background: "#eff6ff",
								color: "#2563eb",
								fontWeight: 600,
								fontSize: 12,
								padding: "6px 12px",
								borderRadius: 8,
								cursor: "pointer",
								boxShadow: "0 2px 8px rgba(15,23,42,0.10)"
							}}
						>
							↺ tout afficher
						</button>
					</Panel>
				) : null}
			</ReactFlow>

			{/* Toolbar horizontale bas-centre — remonte au-dessus de la console
			 * SNQL quand elle est ouverte pour rester accessible. Auto-layout
			 * passe par une confirmation (destructif — écrase la disposition
			 * user, historique undo pas encore branché). */}
			<CanvasToolbar
				onAutoLayout={() => setLayoutConfirmOpen(true)}
				bottomOffset={consoleHeight + CONSOLE_GAP}
			/>
			<AutoLayoutModal
				opened={layoutConfirmOpen}
				onClose={() => setLayoutConfirmOpen(false)}
				onConfirm={relayoutAll}
			/>

			{/* Console SNQL escamotable (bas-droit, à droite du drawer). */}
			<CanvasConsole
				engine={schema.engine as "postgres" | "mongodb"}
				leftOffset={leftPadding}
				onHeightChange={setConsoleHeight}
				schema={schema}
			/>

			{/* Toggle drawer gauche : ActionIcon flottant qui bascule sur le
			 * bord du drawer (visible) ou au coin canvas (masqué). */}
			<ActionIcon
				variant="filled"
				size="lg"
				radius="md"
				onClick={() => setLeftDrawerVisible((x) => !x)}
				aria-label={
					leftDrawerVisible
						? "Masquer le drawer gauche"
						: "Afficher le drawer gauche"
				}
				style={{
					position: "absolute",
					top: 12,
					left: leftDrawerVisible ? leftDrawerWidth - 18 : 8,
					zIndex: 5,
					background: "#fff",
					color: "#475569",
					border: "1px solid #e2e8f0",
					boxShadow: "0 2px 6px rgba(15,23,42,0.10)"
				}}
			>
				{leftDrawerVisible ? (
					<IconLayoutSidebarLeftCollapse size={16} />
				) : (
					<IconLayoutSidebarLeftExpand size={16} />
				)}
			</ActionIcon>

			{/* Drawer gauche docké — UN SEUL drawer qui switch entre l'arborescence
			 * (par défaut) et la vue détails d'une table/frame (quand focusId /
			 * focusFrameKey set). Le back button du header détails clear le focus →
			 * retour automatique à l'arborescence dans le même conteneur. Largeur
			 * et pill Cmd+K identiques dans les deux modes → pas de reflow au focus. */}
			{leftDrawerVisible ? (
				<DrawerPane
					schema={schema}
					width={leftDrawerWidth}
					handleProps={drawerHandleProps}
					search={search}
					onSearchChange={setSearch}
					framesApi={framesApi}
					focusId={focusId}
					focusFrameKey={focusFrameKey}
					focusedFrame={focusedFrame}
					onClearFocus={clearFocus}
					onClearFocusFrame={() => setFocusFrameKey(null)}
					onFocusTable={focusAndZoom}
					onFrameRename={handleFrameRename}
					onFrameDelete={handleFrameDelete}
				/>
			) : null}

			{/* Chip de sélection multi-tables (tour 1d) — visible dès qu'une
			 * table est sélectionnée (Shift+click ou lasso). Actions : Frame (F)
			 * → crée un frame ; Masquer → cache les tables sélectionnées ;
			 * ✕ → clear. Ancré haut-centre, sous le futur breadcrumb canvas
			 * (engine + schema info) qui prendra `top: 12` — d'où le décalage
			 * à ~60 px pour lui laisser la place quand il arrivera. */}
			{selectedTables.length > 0 ? (
				<Box
					style={{
						position: "absolute",
						left: "50%",
						transform: "translateX(-50%)",
						top: 60,
						zIndex: 6
					}}
				>
					<SelectionChip
						count={selectedTables.length}
						label="table"
						actions={[
							{
								id: "frame",
								label: "Frame",
								hint: "F",
								onClick: () => {
									createFrameFromSelection();
									clearSelection();
								}
							},
							{
								id: "hide",
								label: "Masquer",
								onClick: () => {
									hideSelected();
									clearSelection();
								}
							}
						]}
						onClear={clearSelection}
					/>
				</Box>
			) : null}

			{/* Chip « masqués — tout réafficher » quand ≥1 table est cachée. */}
			{hiddenIds.size > 0 ? (
				<HiddenChip count={hiddenIds.size} onUnhideAll={unhideAll} />
			) : null}

			{/* Menu contextuel (tour 1b + retirer du frame tour 1d). */}
			{menu !== null ? (
				<CanvasContextMenu
					open
					position={{ x: menu.x, y: menu.y }}
					tableName={menu.tableName}
					frames={framesApi.frames}
					frameOfTable={framesApi.frameOfTable(menu.tableName)}
					onClose={() => setMenu(null)}
					onHide={hideTable}
					onFocus={focusAndZoom}
					onAddToFrame={(frameKey) => {
						framesApi.addTableToFrame(frameKey, menu.tableName);
						history.push();
					}}
					onRemoveFromFrame={() => {
						framesApi.removeTableFromFrame(menu.tableName);
						history.push();
					}}
				/>
			) : null}

			{/* Palette Cmd+K (tour 1c). */}
			<Spotlight
				actions={commandGroups}
				searchProps={{
					placeholder: "Chercher une table, une action…"
				}}
				nothingFound="Aucun résultat."
				highlightQuery
				shortcut={null}
			/>
		</div>
	);
}

/** Canvas ER interactif — dompte les grands schémas via drawers + focus + recherche. */
export function SchemaCanvas({ schema }: { schema: SchemaModel }) {
	// Remonte tout le flow au changement de schéma : état React Flow réinitialisé
	// proprement, le graphe se recadre au montage. Clé combinant moteur, taille et
	// première/dernière table — assez discriminante pour deux schémas distincts.
	const cols = schema.collections;
	const key = `${schema.engine}:${cols.length}:${cols[0]?.name ?? ""}:${cols[cols.length - 1]?.name ?? ""}`;
	return (
		<ReactFlowProvider key={key}>
			<CanvasInner schema={schema} />
		</ReactFlowProvider>
	);
}
