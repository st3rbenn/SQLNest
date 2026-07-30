import {
	SearchInput,
	showNotification,
	SidebarDrawer,
	type SidebarTab,
	Spotlight,
	spotlight,
	useCommandPaletteShortcut
} from "@sqlnest/design-system";
import { useNavigate } from "@tanstack/react-router";
import { buildCanvasCommands } from "./commands";
import { Box, Stack, Text, UnstyledButton } from "@mantine/core";
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
	useReactFlow
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { CanvasContextMenu } from "./CanvasContextMenu";
import { CanvasToolbar } from "./CanvasToolbar";
import { FrameNode, type FrameNodeType } from "./FrameNode";
import { framesFor } from "./frames";
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

const TABS: SidebarTab[] = [
	{ value: "tables", label: "Tables" },
	{ value: "frames", label: "Frames" },
	{ value: "diff", label: "Diff" }
];

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

/**
 * Viewport qui centre les bounds dans une fenêtre avec un padding en % et
 * un zoom maxi. Pure (aucune dépendance à React Flow) → testable et prévisible.
 */
export function overviewViewport(
	bounds: { minX: number; minY: number; maxX: number; maxY: number },
	container: { width: number; height: number },
	options: { padding: number; maxZoom: number; minZoom?: number }
): { x: number; y: number; zoom: number } {
	const contentW = bounds.maxX - bounds.minX;
	const contentH = bounds.maxY - bounds.minY;
	const pad = options.padding;
	const availW = container.width * (1 - 2 * pad);
	const availH = container.height * (1 - 2 * pad);
	const zoom = Math.max(
		options.minZoom ?? 0.02,
		Math.min(options.maxZoom, availW / contentW, availH / contentH)
	);
	const centerX = (bounds.minX + bounds.maxX) / 2;
	const centerY = (bounds.minY + bounds.maxY) / 2;
	return {
		x: container.width / 2 - centerX * zoom,
		y: container.height / 2 - centerY * zoom,
		zoom
	};
}

function computeFrameNodes(
	schema: SchemaModel,
	tableNodes: readonly TableNodeType[]
): FrameNodeType[] {
	const frames = framesFor(schema);
	if (frames.length === 0) return [];
	const byId = new Map(tableNodes.map((n) => [n.id, n]));
	return frames.flatMap((frame) => {
		const rects = frame.collections
			.map((c) => byId.get(c))
			.filter((n): n is TableNodeType => n !== undefined);
		if (rects.length === 0) return [];
		const minX = Math.min(...rects.map((n) => n.position.x));
		const minY = Math.min(...rects.map((n) => n.position.y));
		const maxX = Math.max(
			...rects.map((n) => n.position.x + (n.width ?? NODE_WIDTH))
		);
		const maxY = Math.max(
			...rects.map((n) => n.position.y + (n.height ?? 200))
		);
		return [
			{
				id: `frame:${frame.key}`,
				type: "frame" as const,
				position: { x: minX - FRAME_PAD, y: minY - FRAME_PAD },
				width: maxX - minX + FRAME_PAD * 2,
				height: maxY - minY + FRAME_PAD * 2,
				data: { frame },
				draggable: false,
				selectable: false,
				connectable: false,
				zIndex: -1,
				style: { pointerEvents: "none" as const }
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
	const [activeTab, setActiveTab] = useState<string>("tables");
	const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(
		() => new Set()
	);
	const [menu, setMenu] = useState<{
		x: number;
		y: number;
		tableName: string;
	} | null>(null);
	const { fitView, setViewport } = useReactFlow();
	const containerRef = useRef<HTMLDivElement | null>(null);

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
				schema,
				nodes.filter((n) => !hiddenIds.has(n.id))
			),
		[schema, nodes, hiddenIds]
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

	// Vue aérienne au 1er layout. On calcule le viewport nous-mêmes à partir
	// des bounds ELK (positions déjà connues, pas besoin d'attendre que RF
	// mesure ses nœuds) et on l'applique via `setViewport`. Ça contourne le
	// warning « container needs width and height » de RF sous Mantine
	// AppShell (le conteneur est bien 1440×850 mais RF a raté sa fenêtre
	// initiale de mesure et refuse ensuite de re-fit).
	useEffect(() => {
		if (base === null || containerRef.current === null) return;
		const bounds = tablesBounds(base.nodes);
		if (bounds === null) return;
		const rect = containerRef.current.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;
		setViewport(
			overviewViewport(bounds, rect, {
				padding: OVERVIEW_FIT.padding,
				maxZoom: OVERVIEW_FIT.maxZoom
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
	 * amené dessus. Aussi le double-clic sur la carte. */
	const focusAndZoom = (id: string) => {
		setFocusId(id);
		fitView({ nodes: [{ id }], duration: 500, maxZoom: 1 });
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
				maxZoom: OVERVIEW_FIT.maxZoom
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

			{/* Drawer droit : arborescence + tabs (Tables/Frames/Diff) */}
			<Box
				style={{
					position: "absolute",
					top: 12,
					right: 12,
					bottom: 12,
					zIndex: 4
				}}
			>
				<SidebarDrawer
					tabs={TABS}
					value={activeTab}
					onTabChange={setActiveTab}
					header={
						activeTab === "tables" ? (
							<SearchInput
								value={search}
								onChange={(e) => setSearch(e.currentTarget.value)}
								placeholder={`Rechercher parmi ${schema.collections.length} tables…`}
							/>
						) : null
					}
					style={{ height: "100%" }}
				>
					{activeTab === "tables" ? (
						<SchemaTree
							schema={schema}
							focusId={focusId}
							search={search}
							onSelect={focusAndZoom}
						/>
					) : null}
					{activeTab === "frames" ? (
						<Stack gap="xs" p="sm">
							<Text size="xs" c="dimmed">
								Frames de regroupement (aperçu statique — bientôt éditable).
							</Text>
							{framesFor(schema).map((f) => (
								<Text key={f.key} size="sm">
									<span
										style={{
											display: "inline-block",
											width: 8,
											height: 8,
											borderRadius: 2,
											background: `hsl(${f.hue}, 55%, 60%)`,
											marginRight: 6
										}}
									/>
									{f.label} · {f.collections.length}
								</Text>
							))}
							{framesFor(schema).length === 0 ? (
								<Text size="xs" c="dimmed">
									Aucun frame défini pour cette base.
								</Text>
							) : null}
						</Stack>
					) : null}
					{activeTab === "diff" ? (
						<Stack gap="xs" p="sm">
							<Text size="xs" c="dimmed">
								Diff de schémas — bientôt.
							</Text>
						</Stack>
					) : null}
				</SidebarDrawer>
			</Box>

			{/* Drawer gauche : infos + FK cliquables (visible uniquement quand focus) */}
			{focusId !== null ? (
				<TableDetails
					schema={schema}
					tableName={focusId}
					onSelect={focusAndZoom}
					onClose={clearFocus}
				/>
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

			{/* Menu contextuel (tour 1b). */}
			{menu !== null ? (
				<CanvasContextMenu
					open
					position={{ x: menu.x, y: menu.y }}
					tableName={menu.tableName}
					frames={framesFor(schema)}
					onClose={() => setMenu(null)}
					onHide={hideTable}
					onFocus={focusAndZoom}
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
