import {
	HintPill,
	SearchInput,
	SelectionChip,
	showNotification,
	SidebarDrawer,
	Spotlight,
	spotlight,
	useCommandPaletteShortcut
} from "@sqlnest/design-system";
import { useNavigate } from "@tanstack/react-router";
import { buildCanvasCommands } from "./commands";
import { Box, UnstyledButton } from "@mantine/core";
import {
	Background,
	Controls,
	type Edge,
	MarkerType,
	MiniMap,
	Panel,
	ReactFlow,
	ReactFlowProvider,
	useNodesState,
	useOnSelectionChange,
	useReactFlow
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CanvasContextMenu } from "./CanvasContextMenu";
import { CanvasToolbar } from "./CanvasToolbar";
import { FrameNode, type FrameNodeType } from "./FrameNode";
import { type Frame, type FrameRect, rectContainsPoint } from "./frames";
import { buildLayout, type LayoutResult } from "./layout";
import { SchemaTree } from "./SchemaTree";
import type { SchemaModel } from "./schema-model";
import { TableDetails } from "./TableDetails";
import {
	NODE_WIDTH,
	nodeHeight,
	TableNode,
	type TableNodeType
} from "./TableNode";
import { useFrames } from "./useFrames";

const DECLARED = "#2563eb";
const INFERRED = "#d97706";
const nodeTypes = { table: TableNode, frame: FrameNode };

type SchemaNode = TableNodeType | FrameNodeType;

/**
 * Vue aérienne cible. `maxZoom` cap le fit : sans lui, RF zoomerait à ~1×
 * sur un petit sample (cartes énormes). Avec, on garde une hauteur de
 * plafond confortable qui révèle les frames et les arêtes.
 */
const OVERVIEW_FIT: { padding: number; maxZoom: number; duration: number } = {
	padding: 0.25,
	maxZoom: 0.6,
	duration: 400
};

/**
 * Zoom initial adaptatif : quand RF ne peut pas calculer un fit propre au
 * mount (parent 0×0 pendant l'hydratation Mantine AppShell), on part d'un
 * zoom sensé basé sur la taille du schéma. Petit schéma → vue moyenne.
 * Gros schéma → vue **très** aérienne. `fitView` explicit prend le relais
 * dès que `useNodesInitialized` bascule.
 */
function initialZoom(collectionCount: number): number {
	if (collectionCount <= 4) return 0.6;
	if (collectionCount <= 12) return 0.4;
	if (collectionCount <= 40) return 0.25;
	if (collectionCount <= 100) return 0.15;
	return 0.08;
}

// Bornes de zoom pour le focus d'une table. Sous `min`, on zoome IN (l'user
// vient d'une vue aérienne, il veut voir la table). Au-dessus de `max`, on
// dézoome vers `max` (l'user autorise le dezoom pour garder une lecture
// confortable). Entre les deux → on ne touche pas le zoom, juste pan.
const FOCUS_ZOOM_MIN = 1;
const FOCUS_ZOOM_MAX = 1.5;
const FOCUS_TWEEN_MS = 350;

interface Viewport {
	readonly x: number;
	readonly y: number;
	readonly zoom: number;
}

/**
 * Anime le viewport en confiant le tween au moteur CSS via une transition
 * sur la transform de `.react-flow__viewport` — plutôt que du JS
 * frame-par-frame. Robuste face au throttling (embedded browsers, onglets
 * inactifs) car le composeur CSS tourne au niveau du navigateur, pas de
 * `setInterval`/`requestAnimationFrame`. Un handle `cancel()` retire la
 * transition prématurément si un nouveau focus arrive avant la fin.
 */
export function animateViewport(
	from: Viewport,
	to: Viewport,
	durationMs: number,
	apply: (v: Viewport) => void
): { cancel: () => void } {
	if (typeof document === "undefined") {
		apply(to);
		return { cancel: () => {} };
	}
	const vp = document.querySelector<HTMLElement>(".react-flow__viewport");
	// Pas de viewport = pas de canvas rendu → applique direct, pas d'animation.
	if (vp === null) {
		apply(to);
		return { cancel: () => {} };
	}
	// Applique la valeur `from` sans transition — sinon la 1ère transform
	// serait tweenée depuis n'importe quel état résiduel.
	vp.style.transition = "none";
	apply(from);
	// Force un reflow pour que le browser enregistre `from` avant transition.
	void vp.offsetWidth;
	vp.style.transition = `transform ${durationMs}ms cubic-bezier(0.22, 1, 0.36, 1)`;
	apply(to);
	const cleanup = () => {
		vp.style.transition = "";
	};
	const t = setTimeout(cleanup, durationMs + 50);
	return {
		cancel: () => {
			clearTimeout(t);
			cleanup();
		}
	};
}

/**
 * Zoom cible d'un focus-table. Pure → testable.
 * - currentZoom < min → min (zoom in)
 * - currentZoom > max → max (dezoom vers la cible max)
 * - sinon → currentZoom (juste pan)
 */
export function focusZoom(
	currentZoom: number,
	opts: { min: number; max: number }
): number {
	if (currentZoom < opts.min) return opts.min;
	if (currentZoom > opts.max) return opts.max;
	return currentZoom;
}

const FRAME_PAD = 24;

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
		type: "smoothstep",
		markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
		style: {
			stroke: inferred ? INFERRED : DECLARED,
			strokeWidth: 1.5,
			strokeDasharray: inferred ? "5 4" : undefined
		},
		data: { inferred }
	};
}

/**
 * Bounds englobants de toutes les tables (frames exclus). Utilisé pour
 * calculer un viewport initial propre — `fitView` de React Flow refuse
 * de tourner tant que le conteneur parent n'est pas mesuré (warning
 * « needs a width and a height »), et sous Mantine `AppShell` cette
 * mesure arrive **après** l'hydratation. Pur → testable.
 */
export function tablesBounds(nodes: readonly TableNodeType[]): {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
} | null {
	if (nodes.length === 0) return null;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const n of nodes) {
		const w = n.width ?? NODE_WIDTH;
		const h = n.height ?? 200;
		if (n.position.x < minX) minX = n.position.x;
		if (n.position.y < minY) minY = n.position.y;
		if (n.position.x + w > maxX) maxX = n.position.x + w;
		if (n.position.y + h > maxY) maxY = n.position.y + h;
	}
	return { minX, minY, maxX, maxY };
}

export interface ViewportSafeArea {
	readonly left?: number;
	readonly right?: number;
	readonly top?: number;
	readonly bottom?: number;
}

/**
 * Viewport qui centre les bounds dans la fenêtre visible avec un padding en %
 * et un zoom maxi. `safeArea` défalque les bandes occupées par les panels
 * flottants (drawer, toolbar) : le contenu se centre dans le rectangle libre,
 * pas dans le conteneur brut. Pure → testable.
 */
export function overviewViewport(
	bounds: { minX: number; minY: number; maxX: number; maxY: number },
	container: { width: number; height: number },
	options: {
		padding: number;
		maxZoom: number;
		minZoom?: number;
		safeArea?: ViewportSafeArea;
	}
): { x: number; y: number; zoom: number } {
	const safeLeft = options.safeArea?.left ?? 0;
	const safeRight = options.safeArea?.right ?? 0;
	const safeTop = options.safeArea?.top ?? 0;
	const safeBottom = options.safeArea?.bottom ?? 0;
	const freeW = Math.max(1, container.width - safeLeft - safeRight);
	const freeH = Math.max(1, container.height - safeTop - safeBottom);
	const contentW = bounds.maxX - bounds.minX;
	const contentH = bounds.maxY - bounds.minY;
	const pad = options.padding;
	const availW = freeW * (1 - 2 * pad);
	const availH = freeH * (1 - 2 * pad);
	const zoom = Math.max(
		options.minZoom ?? 0.02,
		Math.min(options.maxZoom, availW / contentW, availH / contentH)
	);
	const centerX = (bounds.minX + bounds.maxX) / 2;
	const centerY = (bounds.minY + bounds.maxY) / 2;
	const freeCenterX = safeLeft + freeW / 2;
	const freeCenterY = safeTop + freeH / 2;
	return {
		x: freeCenterX - centerX * zoom,
		y: freeCenterY - centerY * zoom,
		zoom
	};
}

/**
 * Bounds initiaux d'un frame à partir des positions des tables sélectionnées.
 * Sert au `createFrame` (rect stocké dans le frame) — après quoi le rect reste
 * fixe (drag/ajout/retrait de tables ne le déforme plus).
 */
export function boundsOfTables(
	tables: readonly TableNodeType[],
	pad: number
): { x: number; y: number; width: number; height: number } | null {
	if (tables.length === 0) return null;
	const minX = Math.min(...tables.map((n) => n.position.x));
	const minY = Math.min(...tables.map((n) => n.position.y));
	const maxX = Math.max(
		...tables.map((n) => n.position.x + (n.width ?? NODE_WIDTH))
	);
	const maxY = Math.max(
		...tables.map((n) => n.position.y + (n.height ?? 200))
	);
	return {
		x: minX - pad,
		y: minY - pad,
		width: maxX - minX + pad * 2,
		height: maxY - minY + pad * 2
	};
}

function computeFrameNodes(
	frames: readonly Frame[],
	tableNodes: readonly TableNodeType[],
	onFrameResize: (key: string, rect: FrameRect) => void
): FrameNodeType[] {
	if (frames.length === 0) return [];
	const byId = new Map(tableNodes.map((n) => [n.id, n]));
	return frames.flatMap((frame) => {
		// Rect explicite (user-defined avec `rect` posé) → utilisé tel quel.
		// Sinon → calcul dynamique à partir des membres (frames-seed hérités).
		let rect = frame.rect;
		if (!rect) {
			const members = frame.collections
				.map((c) => byId.get(c))
				.filter((n): n is TableNodeType => n !== undefined);
			rect = boundsOfTables(members, FRAME_PAD) ?? undefined;
			if (!rect) return [];
		}
		return [
			{
				id: `frame:${frame.key}`,
				type: "frame" as const,
				position: { x: rect.x, y: rect.y },
				width: rect.width,
				height: rect.height,
				data: {
					frame,
					onResizeEnd: (r: FrameRect) => onFrameResize(frame.key, r)
				},
				// Draggable pour permettre de déplacer le frame + ses tables
				// ensemble (handler `onNodeDrag` dans CanvasInner applique le
				// delta aux membres).
				draggable: true,
				selectable: true,
				connectable: false,
				zIndex: -1
			}
		];
	});
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
	useEffect(() => {
		if (base !== null) setNodes(base.nodes);
	}, [base, setNodes]);

	const [focusId, setFocusId] = useState<string | null>(null);
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

	// Sélection multi-tables tenue à jour par RF. Alimente le chip bas-centre
	// et le raccourci `F`. Filtre les frame-nodes (non sélectionnables mais
	// robuste face à un futur changement).
	const [selectedTables, setSelectedTables] = useState<readonly string[]>([]);
	useOnSelectionChange({
		onChange: useCallback(({ nodes: sel }) => {
			const ids = sel
				.filter((n) => (n as { type?: string }).type !== "frame")
				.map((n) => n.id);
			setSelectedTables(ids);
		}, [])
	});

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

	// Nœuds table affichés : positions vivantes (drag) + drapeaux focus + masqués.
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
							matched: false
						}
					};
				}),
		[nodes, neighbors, focusId, hiddenIds]
	);

	const frameNodes = useMemo(
		() =>
			computeFrameNodes(
				framesApi.frames,
				nodes.filter((n) => !hiddenIds.has(n.id)),
				framesApi.setFrameRect
			),
		[framesApi.frames, nodes, hiddenIds, framesApi.setFrameRect]
	);

	const displayNodes = useMemo<SchemaNode[]>(
		() => [...frameNodes, ...displayTableNodes],
		[frameNodes, displayTableNodes]
	);

	const displayEdges = useMemo(
		() =>
			(base?.edges ?? [])
				.filter((e) => !hiddenIds.has(e.source) && !hiddenIds.has(e.target))
				.map((e) => {
					const touchesFocus =
						focusId !== null && (e.source === focusId || e.target === focusId);
					const dim = focusId !== null && !touchesFocus;
					const inferred = (e.data as { inferred?: boolean })?.inferred;
					return {
						...e,
						style: {
							...e.style,
							stroke: dim ? "#cbd5e1" : inferred ? INFERRED : DECLARED,
							strokeWidth: touchesFocus ? 2.5 : 1.5,
							opacity: dim ? 0.35 : 1
						},
						zIndex: touchesFocus ? 10 : 0
					};
				}),
		[base, focusId, hiddenIds]
	);

	// `safeArea` = bandes occupées par les panels flottants ou dockés :
	// - gauche : drawer arbre docké (300 px pleine hauteur)
	// - droite : drawer TableDetails flottant (352 px) seulement au focus
	// - bas   : toolbar horizontale flottante (~68 px avec ses marges)
	const safeArea = useMemo(
		() => ({
			left: 300 + 8,
			right: focusId !== null ? 12 + 340 + 8 : 8,
			top: 12,
			bottom: 68
		}),
		[focusId]
	);

	// Vue aérienne au 1er layout SEULEMENT — on ne re-fit pas quand `safeArea`
	// change (sinon chaque focus déclencherait un reset overview qui écrase
	// le `setCenter` du `focusAndZoom`). Le safeArea courant est lu via ref
	// pour rester à jour dans le calcul sans re-trigger l'effet.
	const safeAreaRef = useRef(safeArea);
	safeAreaRef.current = safeArea;
	useEffect(() => {
		if (base === null || containerRef.current === null) return;
		const bounds = tablesBounds(base.nodes);
		if (bounds === null) return;
		const rect = containerRef.current.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;
		setViewport(
			overviewViewport(bounds, rect, {
				padding: OVERVIEW_FIT.padding,
				maxZoom: OVERVIEW_FIT.maxZoom,
				safeArea: safeAreaRef.current
			})
		);
	}, [base, setViewport]);

	/** Focus visuel : isole une table, estompe le reste, ouvre le drawer d'infos —
	 * SANS recadrer la vue. Comportement par défaut du clic gauche sur canvas et
	 * du clic-droit (menu contextuel). L'utilisateur choisit quand zoomer via
	 * `focusAndZoom` (double-clic, menu Détails, entrées distantes). */
	const focusNode = (id: string) => setFocusId(id);

	/** Focus + recadrage sur la table. Utilisé par les points d'entrée
	 * « distants » — arbre, palette Cmd+K, menu Détails, FK cliquables du
	 * drawer — où l'utilisateur cherche activement une table et veut être
	 * amené dessus. Aussi le double-clic sur la carte.
	 *
	 * Stratégie « pan-first » : on ne reset PAS le zoom à chaque focus. Si
	 * la vue est déjà dans la fourchette confortable [FOCUS_ZOOM_MIN,
	 * FOCUS_ZOOM_MAX], on garde le zoom courant et on se contente d'un pan
	 * animé vers la nouvelle table. Si le zoom est trop bas (vue aérienne)
	 * on zoome IN au seuil, si trop haut (user a zoomé manuellement) on
	 * dézoome vers le plafond — dans les deux cas, autorisé pour garder
	 * une lecture correcte de la carte. */
	const focusAndZoom = (id: string) => {
		const node = nodes.find((n) => n.id === id);
		if (!node || containerRef.current === null) {
			setFocusId(id);
			return;
		}
		const cx = node.position.x + (node.width ?? NODE_WIDTH) / 2;
		const cy =
			node.position.y +
			(node.height ?? nodeHeight(node.data.collection)) / 2;
		const from = getViewport();
		const zoom = focusZoom(from.zoom, {
			min: FOCUS_ZOOM_MIN,
			max: FOCUS_ZOOM_MAX
		});
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
				safeArea
			}),
			{ duration: OVERVIEW_FIT.duration }
		);
	};

	const clearFocus = () => {
		setFocusId(null);
		applyOverview();
	};

	const relayoutAll = () => {
		if (base !== null) setNodes(base.nodes);
		applyOverview();
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
	};

	const unhideAll = () => setHiddenIds(new Set());

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
	}, [selectedTables, nodes, framesApi]);

	const hideSelected = useCallback(() => {
		if (selectedTables.length === 0) return;
		setHiddenIds((prev) => {
			const next = new Set(prev);
			for (const t of selectedTables) next.add(t);
			return next;
		});
	}, [selectedTables]);

	const { deleteElements } = useReactFlow();
	const clearSelection = useCallback(() => {
		void deleteElements({ nodes: [] }); // no-op API access to bind
		// Le vrai clear : reset selected flag sur tous les nodes.
		setNodes((ns) => ns.map((n) => ({ ...n, selected: false })));
	}, [deleteElements, setNodes]);

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
	const navigate = useNavigate();
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
				onOpenInEditor: (name) =>
					void navigate({ to: "/query", search: { source: `get ${name}` } }),
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
				onNodesChange={onNodesChange}
				nodeTypes={nodeTypes}
				// Lasso multi-select : glisser dans le vide (bouton gauche) trace
				// un rectangle, sélectionne les tables intersectées. Shift+click
				// pour ajouter à la sélection. `panOnDrag` limité au bouton du
				// milieu — le glisser gauche est réservé au lasso.
				selectionOnDrag
				panOnDrag={[1, 2]}
				// Clic gauche = focus visuel (ring + estompage voisins + drawer) sans
				// bouger la vue. Double-clic = recadre sur la table (comme Figma).
				onNodeClick={(_, node) => focusNode(node.id)}
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
				onNodeDrag={(_, node) => {
					// Drag d'un frame → applique le delta à ses tables membres,
					// en direct (frame et tables bougent ensemble sous le curseur).
					if ((node as { type?: string }).type !== "frame") return;
					const frameKey = node.id.replace(/^frame:/, "");
					const frame = framesApi.frames.find((f) => f.key === frameKey);
					if (!frame || !frame.rect) return;
					const dx = node.position.x - frame.rect.x;
					const dy = node.position.y - frame.rect.y;
					if (dx === 0 && dy === 0) return;
					const members = new Set(frame.collections);
					setNodes((ns) =>
						ns.map((n) =>
							members.has(n.id)
								? {
										...n,
										position: { x: n.position.x + dx, y: n.position.y + dy }
									}
								: n
						)
					);
					framesApi.setFrameRect(frame.key, {
						x: node.position.x,
						y: node.position.y,
						width: frame.rect.width,
						height: frame.rect.height
					});
				}}
				onNodeDragStop={(_, node) => {
					if ((node as { type?: string }).type === "frame") return;
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
				}}
				onPaneClick={() => {
					setFocusId(null);
					setMenu(null);
				}}
				// `defaultViewport` = zoom initial garanti même quand le container
				// n'est pas encore mesuré (Mantine AppShell hydrate en 2 passes) ;
				// dès que les nodes sont mesurés, l'effet `nodesInitialized`
				// ci-dessus appelle `fitView(OVERVIEW_FIT)` pour un cadrage parfait.
				defaultViewport={{ x: 0, y: 0, zoom: initialZoom(schema.collections.length) }}
				fitViewOptions={OVERVIEW_FIT}
				minZoom={0.02}
				maxZoom={1.75}
				onlyRenderVisibleElements
				proOptions={{ hideAttribution: false }}
			>
				<Background color="#e2e8f0" gap={20} />
				<Controls showInteractive={false} />
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
					style={{ background: "#f8fafc" }}
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

			{/* Toolbar verticale gauche */}
			<CanvasToolbar onAutoLayout={relayoutAll} />

			{/* Drawer gauche docké : arborescence (frames + reste), pleine
			 * hauteur, collé au bord. La pill Cmd+K vit dans son footer. */}
			<Box
				style={{
					position: "absolute",
					top: 0,
					left: 0,
					bottom: 0,
					zIndex: 4
				}}
			>
				<SidebarDrawer
					variant="docked"
					title="Schéma"
					header={
						<SearchInput
							value={search}
							onChange={(e) => setSearch(e.currentTarget.value)}
							placeholder={`Rechercher parmi ${schema.collections.length} tables…`}
						/>
					}
					footer={
						<UnstyledButton
							onClick={() => spotlight.open()}
							aria-label="Ouvrir la palette de commandes"
							style={{ width: "100%" }}
						>
							<HintPill
								keys={["⌘K"]}
								bg="transparent"
								withBorder={false}
								shadow="none"
								style={{
									display: "flex",
									justifyContent: "center"
								}}
							>
								Actions rapides
							</HintPill>
						</UnstyledButton>
					}
					style={{ height: "100%" }}
				>
					<SchemaTree
						schema={schema}
						frames={framesApi.frames}
						focusId={focusId}
						search={search}
						onSelect={focusAndZoom}
					/>
				</SidebarDrawer>
			</Box>

			{/* Drawer droit : infos de la table focus (visible uniquement quand focus). */}
			{focusId !== null ? (
				<TableDetails
					schema={schema}
					tableName={focusId}
					onSelect={focusAndZoom}
					onClose={clearFocus}
				/>
			) : null}

			{/* Chip de sélection multi-tables (tour 1d) — visible dès qu'une
			 * table est sélectionnée (Shift+click ou lasso). Actions : Frame (F)
			 * → crée un frame ; Masquer → cache les tables sélectionnées ;
			 * ✕ → clear. Anchored au-dessus de la toolbar horizontale. */}
			{selectedTables.length > 0 ? (
				<Box
					style={{
						position: "absolute",
						left: "50%",
						transform: "translateX(-50%)",
						bottom: 90,
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
				<UnstyledButton
					onClick={unhideAll}
					style={{
						position: "absolute",
						top: 12,
						left: "50%",
						transform: "translateX(-50%)",
						zIndex: 5,
						padding: "6px 12px",
						borderRadius: 999,
						background: "#fff",
						border: "1px solid var(--mantine-color-slate-2)",
						boxShadow: "var(--mantine-shadow-md)",
						fontSize: 12,
						fontWeight: 600,
						color: "var(--mantine-color-slate-7)"
					}}
				>
					{hiddenIds.size} table
					{hiddenIds.size > 1 ? "s" : ""} masquée
					{hiddenIds.size > 1 ? "s" : ""} — tout réafficher
				</UnstyledButton>
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
					onAddToFrame={(frameKey) =>
						framesApi.addTableToFrame(frameKey, menu.tableName)
					}
					onRemoveFromFrame={() =>
						framesApi.removeTableFromFrame(menu.tableName)
					}
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
