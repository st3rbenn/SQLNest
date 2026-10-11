import { nodeDimensions } from "./geometry";
import type { ParentLookup } from "./parents";
import type { DragItem } from "./store";
import type { InternalNode, Node, NodeChange, XYPosition } from "./types";

type CanReparent = (node: Node, parent: Node | null) => boolean;

function depthOf(
	node: InternalNode,
	lookup: Map<string, InternalNode>
): number {
	let depth = 0;
	let current = node.parentId ? lookup.get(node.parentId) : undefined;
	while (current && depth <= lookup.size) {
		depth += 1;
		current = current.parentId ? lookup.get(current.parentId) : undefined;
	}
	return depth;
}

/**
 * Parent visé quand `node` est lâché au point `point` (flow) : le conteneur
 * le plus profond sous le point qui l'accepte, sinon la racine si elle
 * l'accepte, sinon son parent actuel. Les nodes de `excluded` (le drag et
 * leurs descendants) ne sont jamais candidats.
 */
export function findDropTarget(
	point: XYPosition,
	node: InternalNode,
	excluded: Set<string>,
	lookup: Map<string, InternalNode>,
	canReparent: CanReparent
): string | null {
	let best: InternalNode | null = null;
	let bestDepth = -1;
	for (const candidate of lookup.values()) {
		if (excluded.has(candidate.id) || candidate.hidden) continue;
		const { x, y } = candidate.internals.positionAbsolute;
		const { width, height } = nodeDimensions(candidate);
		if (
			point.x < x ||
			point.x > x + width ||
			point.y < y ||
			point.y > y + height
		) {
			continue;
		}
		if (!canReparent(node.internals.userNode, candidate.internals.userNode)) {
			continue;
		}
		const depth = depthOf(candidate, lookup);
		if (
			best === null ||
			depth > bestDepth ||
			(depth === bestDepth && candidate.internals.z >= best.internals.z)
		) {
			best = candidate;
			bestDepth = depth;
		}
	}
	if (best !== null) return best.id;
	if (canReparent(node.internals.userNode, null)) return null;
	return node.parentId ?? null;
}

/** Les nodes déplacés et tous leurs descendants. */
export function withDescendants(
	ids: Iterable<string>,
	parentLookup: ParentLookup
): Set<string> {
	const out = new Set<string>();
	const stack = [...ids];
	while (stack.length > 0) {
		const id = stack.pop() as string;
		if (out.has(id)) continue;
		out.add(id);
		for (const child of parentLookup.get(id)?.keys() ?? []) stack.push(child);
	}
	return out;
}

/** Position absolue de `id` si les positions de `overrides` étaient appliquées. */
export function absoluteAfter(
	id: string,
	lookup: Map<string, InternalNode>,
	overrides: Map<string, XYPosition>
): XYPosition {
	let x = 0;
	let y = 0;
	let current = lookup.get(id);
	let guard = 0;
	while (current && guard <= lookup.size) {
		const position = overrides.get(current.id) ?? current.position;
		x += position.x;
		y += position.y;
		current = current.parentId ? lookup.get(current.parentId) : undefined;
		guard += 1;
	}
	return { x, y };
}

type Snapshot = {
	position: XYPosition;
	width: number | undefined;
	height: number | undefined;
	children: Map<string, XYPosition>;
};

/**
 * Agrandissements d'un geste : chaque parent susceptible de grandir est
 * photographié avant son premier agrandissement ; quand un node change de
 * parent, tout ce qui a bougé ou grandi pendant le geste revient à son
 * état de départ.
 */
export function createExpansionMemory() {
	const snapshots = new Map<string, Snapshot>();
	const touched = new Set<string>();

	return {
		/** Photographie la chaîne de parents que `item` peut agrandir. */
		snapshot(
			item: DragItem,
			lookup: Map<string, InternalNode>,
			parentLookup: ParentLookup
		) {
			let child = lookup.get(item.id);
			let parentId =
				item.parentId === undefined
					? child?.parentId
					: (item.parentId ?? undefined);
			while (child?.expandParent && parentId) {
				const parent = lookup.get(parentId);
				if (parent === undefined) break;
				if (!snapshots.has(parentId)) {
					snapshots.set(parentId, {
						position: { ...parent.position },
						width: parent.measured.width,
						height: parent.measured.height,
						children: new Map(
							Array.from(parentLookup.get(parentId)?.values() ?? []).map(
								(c) => [c.id, { ...c.position }]
							)
						)
					});
				}
				child = parent;
				parentId = parent.parentId;
			}
		},

		/** Retient ce que le geste a déplacé ou agrandi (hors nodes déplacés). */
		track(changes: NodeChange[], dragged: Set<string>) {
			for (const change of changes) {
				if (!("id" in change) || dragged.has(change.id)) continue;
				if (change.type === "position" || change.type === "dimensions") {
					touched.add(change.id);
				}
			}
		},

		/** Changes qui ramènent à l'état de départ + positions qu'ils imposent. */
		revert(dragged: Set<string>): {
			changes: NodeChange[];
			overrides: Map<string, XYPosition>;
		} {
			const changes: NodeChange[] = [];
			const overrides = new Map<string, XYPosition>();
			for (const id of touched) {
				const own = snapshots.get(id);
				let position = own?.position;
				if (position === undefined) {
					for (const snap of snapshots.values()) {
						position = snap.children.get(id);
						if (position) break;
					}
				}
				if (position && !dragged.has(id)) {
					changes.push({ id, type: "position", position });
					overrides.set(id, position);
				}
				if (own?.width !== undefined && own.height !== undefined) {
					changes.push({
						id,
						type: "dimensions",
						setAttributes: true,
						dimensions: { width: own.width, height: own.height }
					});
				}
			}
			touched.clear();
			return { changes, overrides };
		},

		clear() {
			snapshots.clear();
			touched.clear();
		}
	};
}
