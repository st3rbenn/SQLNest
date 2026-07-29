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
const nodeTypes = { table: TableNode };

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

	// Nœuds affichés : positions vivantes (drag) + drapeaux focus.
	const displayNodes = useMemo(
		() =>
			nodes.map((n) => {
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
		[nodes, neighbors, focusId]
	);

	const displayEdges = useMemo(
		() =>
			(base?.edges ?? []).map((e) => {
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
		[base, focusId]
	);

	/** « Walk to » — isole une table et centre la vue dessus. Point d'entrée
	 * commun pour l'arbre, le panneau d'infos (FK cliquables) et le clic canvas. */
	const focusNode = (id: string) => {
		setFocusId(id);
		fitView({ nodes: [{ id }], duration: 500, maxZoom: 1 });
	};

	const clearFocus = () => {
		setFocusId(null);
		fitView({ padding: 0.15, duration: 400 });
	};

	return (
		<div style={{ position: "relative", width: "100%", height: "100%" }}>
			{base === null ? (
				// ELK peut mouliner ~1 s sur RNAcentral (186 nœuds). L'overlay évite un
				// « saut » (canvas vide → canvas plein), et l'arbre reste utilisable.
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
				nodes={displayNodes}
				edges={displayEdges}
				onNodesChange={onNodesChange}
				nodeTypes={nodeTypes}
				onNodeClick={(_, node) => focusNode(node.id)}
				onPaneClick={() => setFocusId(null)}
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

			{/* Drawer droit : arborescence + recherche fusionnée */}
			<SchemaTree schema={schema} focusId={focusId} onSelect={focusNode} />

			{/* Drawer gauche : infos + FK cliquables (visible uniquement quand focus) */}
			{focusId !== null ? (
				<TableDetails
					schema={schema}
					tableName={focusId}
					onSelect={focusNode}
					onClose={clearFocus}
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
