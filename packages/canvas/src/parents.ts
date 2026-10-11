import { nodeDimensions } from "./geometry";
import type { InternalNode, NodeChange, Rect, XYPosition } from "./types";

export type ParentLookup = Map<string, Map<string, InternalNode>>;

/** z-index d'un node : le sien, + `selectedZ` s'il est sélectionné. */
export function calculateZ(
	node: { zIndex?: number | undefined; selected?: boolean | undefined },
	selectedZ: number
): number {
	const zIndex =
		typeof node.zIndex === "number" && Number.isFinite(node.zIndex)
			? node.zIndex
			: 0;
	return zIndex + (node.selected ? selectedZ : 0);
}

/**
 * Position absolue et z d'un enfant, dérivées de son parent. Un enfant passe
 * toujours au-dessus de son parent. Le parent doit avoir été adopté avant
 * (parents avant enfants dans le tableau des nodes).
 */
export function updateChildNode(
	node: InternalNode,
	lookup: Map<string, InternalNode>,
	parentLookup: ParentLookup,
	selectedZ: number
): void {
	const parentId = node.parentId as string;
	const parent = lookup.get(parentId);
	if (parent === undefined) return;
	const siblings = parentLookup.get(parentId);
	if (siblings) siblings.set(node.id, node);
	else parentLookup.set(parentId, new Map([[node.id, node]]));

	const { x: parentX, y: parentY } = parent.internals.positionAbsolute;
	const x = parentX + node.position.x;
	const y = parentY + node.position.y;
	const childZ = calculateZ(node, selectedZ);
	const parentZ = parent.internals.z ?? 0;
	const z = parentZ >= childZ ? parentZ + 1 : childZ;
	const abs = node.internals.positionAbsolute;
	const positionChanged = x !== abs.x || y !== abs.y;
	if (positionChanged || z !== node.internals.z) {
		lookup.set(node.id, {
			...node,
			internals: {
				...node.internals,
				positionAbsolute: positionChanged ? { x, y } : abs,
				z
			}
		});
	}
}

/** Vrai si un ancêtre du node est sélectionné. */
export function isParentSelected(
	node: InternalNode,
	lookup: Map<string, InternalNode>
): boolean {
	if (!node.parentId) return false;
	const parent = lookup.get(node.parentId);
	if (parent === undefined) return false;
	if (parent.selected) return true;
	return isParentSelected(parent, lookup);
}

/** Position relative au parent d'un node amené en `nextPosition` (absolue). */
export function calculateNodePosition(
	node: InternalNode,
	nextPosition: XYPosition,
	lookup: Map<string, InternalNode>
): { position: XYPosition; positionAbsolute: XYPosition } {
	const parent = node.parentId ? lookup.get(node.parentId) : undefined;
	const { x: parentX, y: parentY } = parent
		? parent.internals.positionAbsolute
		: { x: 0, y: 0 };
	return {
		position: { x: nextPosition.x - parentX, y: nextPosition.y - parentY },
		positionAbsolute: nextPosition
	};
}

const rectBounds = (a: Rect, b: Rect): Rect => {
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return {
		x,
		y,
		width: Math.max(a.x + a.width, b.x + b.width) - x,
		height: Math.max(a.y + a.height, b.y + b.height) - y
	};
};

export type ExpandChild = { id: string; parentId: string; rect: Rect };

/**
 * Agrandit les parents pour contenir les enfants poussés hors de leurs
 * bords. Vers la gauche / le haut, le parent se déplace et ses autres
 * enfants sont décalés d'autant pour ne pas bouger à l'écran. Un parent qui
 * a lui-même `expandParent` agrandit à son tour son propre parent ; sa
 * position relative est alors recalculée dans le parent agrandi.
 */
export function handleExpandParent(
	children: ExpandChild[],
	lookup: Map<string, InternalNode>,
	parentLookup: ParentLookup
): NodeChange[] {
	const changes: NodeChange[] = [];
	/** Positions des parents agrandis, ajustées si leur propre parent bouge. */
	const parentPositions = new Map<string, XYPosition>();
	let level: (ExpandChild & { chained: boolean })[] = children.map((c) => ({
		...c,
		chained: false
	}));
	const seen = new Set<string>();
	while (level.length > 0) {
		const expansions = new Map<
			string,
			{ expandedRect: Rect; parent: InternalNode }
		>();
		for (const child of level) {
			const parent = lookup.get(child.parentId);
			if (parent === undefined || seen.has(child.parentId)) continue;
			const parentRect = expansions.get(child.parentId)?.expandedRect ?? {
				...parent.internals.positionAbsolute,
				...nodeDimensions(parent)
			};
			expansions.set(child.parentId, {
				expandedRect: rectBounds(parentRect, child.rect),
				parent
			});
		}
		const next: (ExpandChild & { chained: boolean })[] = [];
		for (const [parentId, { expandedRect, parent }] of expansions) {
			seen.add(parentId);
			const positionAbsolute = parent.internals.positionAbsolute;
			const dimensions = nodeDimensions(parent);
			const xChange =
				expandedRect.x < positionAbsolute.x
					? Math.round(Math.abs(positionAbsolute.x - expandedRect.x))
					: 0;
			const yChange =
				expandedRect.y < positionAbsolute.y
					? Math.round(Math.abs(positionAbsolute.y - expandedRect.y))
					: 0;
			const newWidth = Math.max(
				dimensions.width,
				Math.round(expandedRect.width)
			);
			const newHeight = Math.max(
				dimensions.height,
				Math.round(expandedRect.height)
			);
			const moved = xChange > 0 || yChange > 0;
			const newAbs = {
				x: positionAbsolute.x - xChange,
				y: positionAbsolute.y - yChange
			};
			for (const child of level) {
				if (child.chained && child.parentId === parentId) {
					parentPositions.set(child.id, {
						x: child.rect.x - newAbs.x,
						y: child.rect.y - newAbs.y
					});
				}
			}
			if (moved) {
				parentPositions.set(parentId, {
					x: parent.position.x - xChange,
					y: parent.position.y - yChange
				});
				for (const sibling of parentLookup.get(parentId)?.values() ?? []) {
					if (level.some((c) => c.id === sibling.id)) continue;
					changes.push({
						id: sibling.id,
						type: "position",
						position: {
							x: sibling.position.x + xChange,
							y: sibling.position.y + yChange
						}
					});
				}
			}
			const grows =
				dimensions.width < expandedRect.width ||
				dimensions.height < expandedRect.height;
			if (grows || moved) {
				changes.push({
					id: parentId,
					type: "dimensions",
					setAttributes: true,
					dimensions: { width: newWidth, height: newHeight }
				});
				if (parent.expandParent && parent.parentId) {
					next.push({
						id: parentId,
						parentId: parent.parentId,
						rect: { ...newAbs, width: newWidth, height: newHeight },
						chained: true
					});
				}
			}
		}
		level = next;
	}
	const positionChanges: NodeChange[] = [];
	for (const [id, position] of parentPositions) {
		const current = lookup.get(id)?.position;
		if (current && current.x === position.x && current.y === position.y)
			continue;
		positionChanges.push({ id, type: "position", position });
	}
	return [...positionChanges, ...changes];
}
