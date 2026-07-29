import dagre from "@dagrejs/dagre";
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
import {
	type CSSProperties,
	type KeyboardEvent,
	useMemo,
	useState
} from "react";
import type { SchemaModel } from "./schema-model";
import {
	NODE_WIDTH,
	nodeHeight,
	TableNode,
	type TableNodeType
} from "./TableNode";

const DECLARED = "#2563eb";
const INFERRED = "#d97706";
const nodeTypes = { table: TableNode };

/** Construit nœuds + arêtes positionnés (layout dagre, gauche→droite). */
function buildGraph(schema: SchemaModel): {
	nodes: TableNodeType[];
	edges: Edge[];
} {
	const present = new Set(schema.collections.map((c) => c.name));
	const nodes: TableNodeType[] = schema.collections.map((collection) => ({
		id: collection.name,
		type: "table",
		position: { x: 0, y: 0 },
		// Dimensions explicites : React Flow n'attend pas la mesure du DOM → `fitView`
		// est correct dès le montage (sinon il cadre des nœuds de taille 0).
		width: NODE_WIDTH,
		height: nodeHeight(collection),
		data: { collection, dimmed: false, focused: false, matched: false }
	}));

	const edges: Edge[] = [];
	schema.relations.forEach((rel, i) => {
		// Une relation vers une table hors périmètre casserait React Flow → on filtre.
		if (!present.has(rel.from.collection) || !present.has(rel.to.collection)) {
			return;
		}
		const inferred = rel.origin !== "foreign-key";
		edges.push({
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
		});
	});

	// Schéma vide (schéma pg atteint mais sans table) : rien à disposer.
	if (nodes.length === 0) {
		return { nodes, edges };
	}

	// Layout dagre : rankdir LR (enfant → parent se lit de gauche à droite).
	const g = new dagre.graphlib.Graph();
	g.setGraph({
		rankdir: "LR",
		nodesep: 30,
		ranksep: 90,
		marginx: 24,
		marginy: 24
	});
	g.setDefaultEdgeLabel(() => ({}));
	for (const c of schema.collections) {
		g.setNode(c.name, { width: NODE_WIDTH, height: nodeHeight(c) });
	}
	for (const e of edges) {
		g.setEdge(e.source, e.target);
	}
	dagre.layout(g);

	for (const n of nodes) {
		const p = g.node(n.id);
		if (p) {
			n.position = { x: p.x - p.width / 2, y: p.y - p.height / 2 };
		}
	}
	return { nodes, edges };
}

const searchStyle: CSSProperties = {
	padding: "7px 10px",
	borderRadius: 8,
	border: "1px solid #e2e8f0",
	fontSize: 13,
	width: 220,
	outline: "none"
};

const legendDot = (color: string, dashed: boolean): CSSProperties => ({
	display: "inline-block",
	width: 18,
	height: 0,
	borderTop: `2px ${dashed ? "dashed" : "solid"} ${color}`,
	marginRight: 5,
	verticalAlign: "middle"
});

function CanvasInner({ schema }: { schema: SchemaModel }) {
	const base = useMemo(() => buildGraph(schema), [schema]);
	const [nodes, , onNodesChange] = useNodesState(base.nodes);
	const [focusId, setFocusId] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const { fitView } = useReactFlow();
	// Le composant est **remonté** à chaque changement de schéma (clé côté
	// SchemaCanvas), donc pas d'effet de resynchro ici : `useNodesState` s'initialise
	// avec le graphe positionné et le prop `fitView` cadre au montage.

	// Voisinage FK direct du nœud focalisé (le nœud + ses 1-sauts).
	const neighbors = useMemo(() => {
		if (focusId === null) {
			return null;
		}
		const set = new Set<string>([focusId]);
		for (const e of base.edges) {
			if (e.source === focusId) {
				set.add(e.target);
			}
			if (e.target === focusId) {
				set.add(e.source);
			}
		}
		return set;
	}, [focusId, base.edges]);

	const query = search.trim().toLowerCase();
	const matches = useMemo(() => {
		if (query === "") {
			return null;
		}
		return new Set(
			base.nodes
				.filter((n) => n.id.toLowerCase().includes(query))
				.map((n) => n.id)
		);
	}, [query, base.nodes]);

	// Nœuds affichés : positions vivantes (drag) + drapeaux focus/recherche.
	const displayNodes = useMemo(
		() =>
			nodes.map((n) => {
				const inFocus = neighbors ? neighbors.has(n.id) : true;
				const isMatch = matches ? matches.has(n.id) : false;
				const dimmed =
					(neighbors !== null && !inFocus) || (matches !== null && !isMatch);
				return {
					...n,
					data: {
						...n.data,
						dimmed,
						focused: n.id === focusId,
						matched: isMatch
					}
				};
			}),
		[nodes, neighbors, matches, focusId]
	);

	const displayEdges = useMemo(
		() =>
			base.edges.map((e) => {
				const touchesFocus =
					focusId !== null && (e.source === focusId || e.target === focusId);
				const dim =
					(focusId !== null && !touchesFocus) ||
					(matches !== null &&
						!(matches.has(e.source) && matches.has(e.target)));
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
		[base.edges, focusId, matches]
	);

	// Liste des tables correspondant à la recherche (façon palette), plafonnée.
	const matchList = useMemo(
		() =>
			query === ""
				? []
				: base.nodes
						.filter((n) => n.id.toLowerCase().includes(query))
						.slice(0, 8),
		[query, base.nodes]
	);

	/** Isole une table et centre la vue dessus (zoom lisible). */
	const focusNode = (id: string) => {
		setFocusId(id);
		fitView({ nodes: [{ id }], duration: 500, maxZoom: 1 });
	};

	const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter" && matchList[0]) {
			focusNode(matchList[0].id);
		}
	};

	return (
		<ReactFlow
			nodes={displayNodes}
			edges={displayEdges}
			onNodesChange={onNodesChange}
			nodeTypes={nodeTypes}
			onNodeClick={(_, node) => setFocusId(node.id)}
			onPaneClick={() => {
				setFocusId(null);
				setSearch("");
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
				nodeColor={(n) =>
					(n.data as TableNodeType["data"]).collection.source === "inferred"
						? INFERRED
						: DECLARED
				}
				nodeStrokeWidth={0}
				style={{ background: "#f8fafc" }}
			/>
			<Panel position="top-left">
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						gap: 8,
						background: "#fff",
						border: "1px solid #e2e8f0",
						borderRadius: 10,
						padding: 10,
						boxShadow: "0 4px 16px rgba(15,23,42,0.08)"
					}}
				>
					<input
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						onKeyDown={onSearchKey}
						placeholder={`Rechercher parmi ${base.nodes.length} tables…`}
						spellCheck={false}
						style={searchStyle}
					/>
					{matchList.length > 0 ? (
						<div
							style={{
								display: "flex",
								flexDirection: "column",
								maxHeight: 200,
								overflowY: "auto",
								border: "1px solid #f1f5f9",
								borderRadius: 8
							}}
						>
							{matchList.map((n) => (
								<button
									key={n.id}
									type="button"
									onClick={() => focusNode(n.id)}
									style={{
										textAlign: "left",
										border: "none",
										background: focusId === n.id ? "#eff6ff" : "#fff",
										color: "#334155",
										fontSize: 12.5,
										padding: "7px 10px",
										cursor: "pointer",
										borderBottom: "1px solid #f8fafc",
										display: "flex",
										justifyContent: "space-between",
										gap: 8
									}}
								>
									<span>{n.id}</span>
									<span style={{ color: "#cbd5e1", fontSize: 11 }}>
										{n.data.collection.fields.length} ch.
									</span>
								</button>
							))}
						</div>
					) : null}
					<div
						style={{
							display: "flex",
							alignItems: "center",
							gap: 14,
							fontSize: 11,
							color: "#64748b"
						}}
					>
						<span>
							<span style={legendDot(DECLARED, false)} />
							FK déclarée
						</span>
						<span>
							<span style={legendDot(INFERRED, true)} />
							inférée
						</span>
						{focusId ? (
							<button
								type="button"
								onClick={() => {
									setFocusId(null);
									fitView({ padding: 0.15, duration: 400 });
								}}
								style={{
									border: "none",
									background: "#eff6ff",
									color: "#2563eb",
									fontWeight: 600,
									fontSize: 11,
									padding: "4px 8px",
									borderRadius: 6,
									cursor: "pointer"
								}}
							>
								↺ tout afficher
							</button>
						) : null}
					</div>
				</div>
			</Panel>
			<Panel position="top-right">
				<div
					style={{
						fontSize: 12,
						color: "#475569",
						background: "#fff",
						border: "1px solid #e2e8f0",
						borderRadius: 8,
						padding: "6px 10px"
					}}
				>
					<b>{base.nodes.length}</b> tables · <b>{base.edges.length}</b>{" "}
					relations
					{focusId ? (
						<>
							{" · focus "}
							<b>{focusId}</b>
						</>
					) : null}
				</div>
			</Panel>
		</ReactFlow>
	);
}

/** Canvas ER interactif (pan/zoom/minimap) — dompte les grands schémas via focus + recherche. */
export function SchemaCanvas({ schema }: { schema: SchemaModel }) {
	// Remonte tout le flow au changement de schéma : état React Flow réinitialisé
	// proprement, le graphe se recadre au montage. La clé combine moteur, nombre de
	// tables et les noms des première/dernière tables — assez discriminant pour que
	// deux schémas distincts ne partagent pas de clé en pratique.
	const cols = schema.collections;
	const key = `${schema.engine}:${cols.length}:${cols[0]?.name ?? ""}:${cols[cols.length - 1]?.name ?? ""}`;
	return (
		<ReactFlowProvider key={key}>
			<CanvasInner schema={schema} />
		</ReactFlowProvider>
	);
}
