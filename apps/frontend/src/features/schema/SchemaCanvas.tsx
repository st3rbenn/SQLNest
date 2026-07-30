import {
	SearchInput,
	showNotification,
	SidebarDrawer,
	type SidebarTab
} from "@sqlnest/design-system";
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
import { useEffect, useMemo, useState } from "react";
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
	const { fitView } = useReactFlow();

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

	/** « Walk to » — isole une table et centre la vue dessus. Point d'entrée
	 * commun pour l'arbre, le panneau d'infos (FK cliquables) et le clic canvas. */
	const focusNode = (id: string) => {
		setFocusId(id);
		fitView({ nodes: [{ id }], duration: 500, maxZoom: 1 });
	};

	/** Focus visuel sans recadrer. Utilisé par le clic-droit : ouvrir le menu
	 * sans déplacer la vue (sinon la table glisse sous le curseur et le menu,
	 * positionné en coordonnées écran, se retrouve à côté). */
	const focusWithoutFit = (id: string) => setFocusId(id);

	const clearFocus = () => {
		setFocusId(null);
		fitView({ padding: 0.15, duration: 400 });
	};

	const relayoutAll = () => {
		if (base !== null) setNodes(base.nodes);
		fitView({ padding: 0.15, duration: 400 });
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

	return (
		<div style={{ position: "relative", width: "100%", height: "100%" }}>
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
				onNodeClick={(_, node) => focusNode(node.id)}
				onNodeContextMenu={(event, node) => {
					if ((node as { type?: string }).type === "frame") return;
					event.preventDefault();
					// Focus visuel (ring + drawer) sans fitView : la vue ne bouge pas,
					// donc le menu positionné en clientX/Y reste face à la carte cliquée.
					focusWithoutFit(node.id);
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
				fitView
				fitViewOptions={{ padding: 0.15 }}
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
							onSelect={focusNode}
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
					onSelect={focusNode}
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
					onFocus={focusNode}
				/>
			) : null}
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
