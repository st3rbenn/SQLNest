import { placeAt, type Rect } from "../console-links/placeNear";
import type { LayoutResult } from "../layout";
import type { SchemaModel } from "../schema-model";
import type { TableNodeType } from "../TableNode";
import type { XY } from "../useTablePositions";

/** Marge gardée entre une table apparue et ce qui est déjà posé. */
const CLEARANCE = 24;

export interface LayoutTablesSync {
	readonly layout: LayoutResult;
	/** Position des tables apparues, à persister comme un déplacement. */
	readonly placed: Readonly<Record<string, XY>>;
}

/**
 * Layout aligné sur le schéma relu (ADR-039 D5) : les tables disparues en
 * sortent, les tables apparues se posent sur `center`, ou à la place libre la
 * plus proche quand `taken` (ce qui est déjà sur le canvas) l'occupe ; les
 * autres gardent leur place et reprennent leurs colonnes. `null` : les mêmes
 * tables qu'avant.
 */
export function syncLayoutTables(
	layout: LayoutResult,
	schema: SchemaModel,
	makeNode: (name: string) => TableNodeType,
	center: XY | null,
	taken: readonly Rect[] = []
): LayoutTablesSync | null {
	const names = new Set(schema.collections.map((c) => c.name));
	const known = new Set(layout.nodes.map((n) => n.id));
	const added = schema.collections.filter((c) => !known.has(c.name));
	if (added.length === 0 && layout.nodes.every((n) => names.has(n.id))) {
		return null;
	}

	const kept = layout.nodes
		.filter((n) => names.has(n.id))
		.map((n) => ({ ...makeNode(n.id), position: n.position }));
	const origin = center ?? { x: 0, y: 0 };
	const placed: Record<string, XY> = {};
	const occupied = [...taken];
	const appeared = added.map((collection) => {
		const node = makeNode(collection.name);
		const size = { width: node.width ?? 0, height: node.height ?? 0 };
		const position = placeAt(
			{ x: origin.x - size.width / 2, y: origin.y - size.height / 2 },
			size,
			occupied,
			{ clearance: CLEARANCE, prefer: ["right", "below", "left", "above"] }
		);
		occupied.push({ ...position, ...size });
		placed[collection.name] = position;
		return { ...node, position };
	});
	return {
		layout: {
			nodes: [...kept, ...appeared],
			edges: layout.edges.filter(
				(e) => names.has(e.source) && names.has(e.target)
			)
		},
		placed
	};
}
