import type { Edge } from "@xyflow/react";
import ELK, {
	type ElkExtendedEdge,
	type ElkNode
} from "elkjs/lib/elk.bundled.js";
import type { SchemaModel } from "./schema-model";
import { NODE_WIDTH, nodeHeight, type TableNodeType } from "./TableNode";

/**
 * Layout ER via **ELK** (Eclipse Layout Kernel). Deux algorithmes selon la
 * taille/topologie du graphe :
 *
 * - **`layered`** (petits schémas ≤ ~30 tables) : rendu hiérarchique lisible
 *   gauche→droite (FK enfant→parent), idéal pour un modèle e-commerce classique.
 *
 * - **`stress`** (gros schémas) : force-directed. Le layered a un invariant
 *   « 1 rang = 1 colonne » qui produit un ruban vertical quand un rang contient
 *   des centaines de tables (cas RNAcentral : 140+ `xref_p*` pointant toutes
 *   vers `rna` → 1 colonne de 140 tables, bbox 3300×33000). `stress` répartit en
 *   2D sans cette contrainte : les tables sans FK entre elles peuvent tomber
 *   côte à côte. Rendu moins « ordonné » mais navigable.
 *
 * Async — ELK peut mouliner ~1 s sur RNAcentral.
 */

export interface LayoutResult {
	readonly nodes: TableNodeType[];
	readonly edges: Edge[];
}

// Une instance par processus (le solveur est stateless côté API).
const elk = new ELK();

/** Seuil au-delà duquel `layered` produit un ruban vertical → bascule sur `stress`. */
const LARGE_SCHEMA_THRESHOLD = 30;

const LAYERED_OPTIONS: Record<string, string> = {
	"elk.algorithm": "layered",
	"elk.direction": "RIGHT",
	"elk.spacing.nodeNode": "60",
	"elk.layered.spacing.nodeNodeBetweenLayers": "140",
	"elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
	"elk.separateConnectedComponents": "true",
	"elk.spacing.componentComponent": "80"
};

const STRESS_OPTIONS: Record<string, string> = {
	"elk.algorithm": "stress",
	// Longueur d'arête cible = force de répulsion → distance moyenne inter-table.
	// Bumpé (320→600) pour aérer le cluster central des schémas denses type
	// RNAcentral, laisser de la place au regroupement manuel futur (Slice B —
	// panels nommés). Trade-off : bbox plus grande, mais fitView cadre à l'aise.
	"elk.stress.desiredEdgeLength": "600",
	// Itérations : plus = mieux distribué, mais plus lent (~1 s sur 186 nœuds).
	"elk.stress.iterationLimit": "800",
	// Distance minimale entre 2 tables : empêche le chevauchement même quand la
	// force n'écarte pas assez. Bumpé (60→160) pour ce point précis (gap visible).
	"elk.spacing.nodeNode": "160",
	"elk.separateConnectedComponents": "true",
	"elk.spacing.componentComponent": "200"
};

/**
 * Construit nœuds + arêtes positionnés pour un SchemaModel. Async : ELK peut
 * mouliner sur un gros graphe (RNAcentral : 186 nœuds / 516 arêtes → ~1 s).
 */
export async function buildLayout(
	schema: SchemaModel,
	makeNode: (name: string) => TableNodeType,
	makeEdge: (rel: SchemaModel["relations"][number], index: number) => Edge
): Promise<LayoutResult> {
	const present = new Set(schema.collections.map((c) => c.name));
	const nodes = schema.collections.map((c) => makeNode(c.name));

	const edges: Edge[] = [];
	schema.relations.forEach((rel, i) => {
		// Arêtes vers une collection hors périmètre : ignorées (relation pendante).
		if (present.has(rel.from.collection) && present.has(rel.to.collection)) {
			edges.push(makeEdge(rel, i));
		}
	});

	if (nodes.length === 0) return { nodes, edges };

	const elkNodes: ElkNode[] = nodes.map((n) => ({
		id: n.id,
		width: NODE_WIDTH,
		height: nodeHeight(n.data.collection)
	}));
	// ELK exige des ids uniques d'arêtes ; on garde ceux de React Flow.
	const elkEdges: ElkExtendedEdge[] = edges.map((e) => ({
		id: e.id,
		sources: [e.source],
		targets: [e.target]
	}));

	const options =
		nodes.length > LARGE_SCHEMA_THRESHOLD ? STRESS_OPTIONS : LAYERED_OPTIONS;
	const graph = await elk.layout({
		id: "root",
		layoutOptions: options,
		children: elkNodes,
		edges: elkEdges
	});

	// Rapatrie les positions ELK sur les nœuds React Flow.
	const positions = new Map<string, { x: number; y: number }>();
	for (const child of graph.children ?? []) {
		positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
	}
	for (const n of nodes) {
		const p = positions.get(n.id);
		if (p !== undefined) n.position = p;
	}
	return { nodes, edges };
}
