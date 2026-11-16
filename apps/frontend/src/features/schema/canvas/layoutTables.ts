import type { LayoutResult } from "../layout";
import type { SchemaModel } from "../schema-model";
import type { TableNodeType } from "../TableNode";
import type { XY } from "../useTablePositions";

/** Décalage entre deux tables apparues d'un coup, pour qu'elles ne se recouvrent pas. */
const STACK_OFFSET = 32;

export interface LayoutTablesSync {
	readonly layout: LayoutResult;
	/** Position des tables apparues, à persister comme un déplacement. */
	readonly placed: Readonly<Record<string, XY>>;
}

/**
 * Layout aligné sur le schéma relu (ADR-039 D5) : les tables disparues en
 * sortent, les tables apparues se centrent sur `center`, les autres gardent
 * leur place et reprennent leurs colonnes. `null` : les mêmes tables qu'avant.
 */
export function syncLayoutTables(
	layout: LayoutResult,
	schema: SchemaModel,
	makeNode: (name: string) => TableNodeType,
	center: XY | null
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
	const appeared = added.map((collection, i) => {
		const node = makeNode(collection.name);
		const position = {
			x: origin.x - (node.width ?? 0) / 2 + i * STACK_OFFSET,
			y: origin.y - (node.height ?? 0) / 2 + i * STACK_OFFSET
		};
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
