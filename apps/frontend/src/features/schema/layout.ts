import dagre from "@dagrejs/dagre";
import type { Edge } from "@xyflow/react";
import type { SchemaModel } from "./schema-model";
import type { TableNodeType } from "./TableNode";
import { NODE_WIDTH, nodeHeight } from "./TableNode";

/**
 * Layout ER **multi-composantes** : chaque composante connexe du graphe FK est
 * layoutée séparément par dagre, puis les composantes sont empilées en grille.
 * Sinon dagre étale toutes les tables sur une même colonne au même « rang »
 * (le cas RNAcentral, 186 tables → ruban vertical illisible).
 *
 * Les tables isolées (aucune FK) forment leur propre composante et sont
 * groupées ensemble à la fin pour ne pas dominer la vue.
 */

const GAP_X = 120;
const GAP_Y = 120;
const RANK_SEP = 140;
const NODE_SEP = 60;

export interface LayoutResult {
	readonly nodes: TableNodeType[];
	readonly edges: Edge[];
}

/** Composantes connexes du graphe non-orienté induit par les relations. */
function components(schema: SchemaModel): string[][] {
	const adj = new Map<string, Set<string>>();
	for (const c of schema.collections) {
		adj.set(c.name, new Set());
	}
	for (const r of schema.relations) {
		if (adj.has(r.from.collection) && adj.has(r.to.collection)) {
			adj.get(r.from.collection)?.add(r.to.collection);
			adj.get(r.to.collection)?.add(r.from.collection);
		}
	}
	const seen = new Set<string>();
	const groups: string[][] = [];
	for (const start of adj.keys()) {
		if (seen.has(start)) continue;
		const group: string[] = [];
		const stack = [start];
		while (stack.length > 0) {
			const cur = stack.pop();
			if (cur === undefined || seen.has(cur)) continue;
			seen.add(cur);
			group.push(cur);
			for (const n of adj.get(cur) ?? []) stack.push(n);
		}
		groups.push(group);
	}
	// Grandes composantes d'abord (elles porteront la structure principale).
	groups.sort((a, b) => b.length - a.length);
	return groups;
}

/** Layoute une composante avec dagre (LR) et retourne positions + dimensions du bloc. */
function layoutComponent(
	names: readonly string[],
	byName: Map<string, TableNodeType>,
	relations: readonly SchemaModel["relations"][number][]
): {
	positions: Map<string, { x: number; y: number }>;
	width: number;
	height: number;
} {
	const g = new dagre.graphlib.Graph();
	g.setGraph({
		rankdir: "LR",
		nodesep: NODE_SEP,
		ranksep: RANK_SEP,
		marginx: 20,
		marginy: 20
	});
	g.setDefaultEdgeLabel(() => ({}));

	const inGroup = new Set(names);
	for (const name of names) {
		const node = byName.get(name);
		if (node !== undefined) {
			g.setNode(name, {
				width: NODE_WIDTH,
				height: nodeHeight(node.data.collection)
			});
		}
	}
	for (const r of relations) {
		if (inGroup.has(r.from.collection) && inGroup.has(r.to.collection)) {
			g.setEdge(r.from.collection, r.to.collection);
		}
	}
	dagre.layout(g);

	const positions = new Map<string, { x: number; y: number }>();
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const name of names) {
		const p = g.node(name);
		if (!p) continue;
		const x = p.x - p.width / 2;
		const y = p.y - p.height / 2;
		positions.set(name, { x, y });
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x + p.width > maxX) maxX = x + p.width;
		if (y + p.height > maxY) maxY = y + p.height;
	}
	// Rebase à (0,0) pour empilement inter-composantes.
	for (const [name, p] of positions) {
		positions.set(name, { x: p.x - minX, y: p.y - minY });
	}
	return {
		positions,
		width: Number.isFinite(minX) ? maxX - minX : 0,
		height: Number.isFinite(minY) ? maxY - minY : 0
	};
}

/**
 * Empile les composantes en **grille** : on remplit des colonnes tant que la
 * hauteur cumulée reste ≤ hauteur cible (√aire total × ratio), puis on passe à
 * la colonne suivante. Approximation simple mais robuste — les grosses
 * composantes tombent en haut à gauche, les isolées finissent à la fin.
 */
function packComponents(
	blocks: readonly {
		positions: Map<string, { x: number; y: number }>;
		width: number;
		height: number;
	}[]
): Map<string, { x: number; y: number }> {
	const totalArea = blocks.reduce(
		(sum, b) => sum + (b.width + GAP_X) * (b.height + GAP_Y),
		0
	);
	// Cible ~ carré : hauteur ≈ largeur ≈ √aire.
	const targetHeight = Math.max(400, Math.sqrt(totalArea));

	const placed = new Map<string, { x: number; y: number }>();
	let colX = 0;
	let colY = 0;
	let colWidth = 0;
	for (const b of blocks) {
		if (colY > 0 && colY + b.height > targetHeight) {
			colX += colWidth + GAP_X;
			colY = 0;
			colWidth = 0;
		}
		for (const [name, p] of b.positions) {
			placed.set(name, { x: colX + p.x, y: colY + p.y });
		}
		colY += b.height + GAP_Y;
		if (b.width > colWidth) colWidth = b.width;
	}
	return placed;
}

/** Construit nœuds + arêtes positionnés pour un SchemaModel. */
export function buildLayout(
	schema: SchemaModel,
	makeNode: (name: string) => TableNodeType,
	makeEdge: (rel: SchemaModel["relations"][number], index: number) => Edge
): LayoutResult {
	const present = new Set(schema.collections.map((c) => c.name));
	const nodes = schema.collections.map((c) => makeNode(c.name));
	const byName = new Map(nodes.map((n) => [n.id, n] as const));

	const edges: Edge[] = [];
	schema.relations.forEach((rel, i) => {
		// Arêtes vers une collection hors périmètre : ignorées (relation pendante).
		if (present.has(rel.from.collection) && present.has(rel.to.collection)) {
			edges.push(makeEdge(rel, i));
		}
	});

	if (nodes.length === 0) return { nodes, edges };

	const groups = components(schema);
	const blocks = groups.map((g) =>
		layoutComponent(g, byName, schema.relations)
	);
	const positions = packComponents(blocks);

	for (const n of nodes) {
		const p = positions.get(n.id);
		if (p !== undefined) n.position = p;
	}
	return { nodes, edges };
}
