import type { Node, NodeChange } from "@sqlnest/canvas";
import type { Frame, FrameRect } from "../frames";
import { NODE_WIDTH, nodeHeight, type TableNodeType } from "../TableNode";

/**
 * Frames imbriqués (ADR-034). L'app garde tout en coordonnées absolues
 * (positions des tables, `rect` des frames — comme le payload persisté) ;
 * le moteur, lui, raisonne en positions relatives au parent. Ce module fait
 * le pont dans les deux sens.
 */

export const FRAME_ID_PREFIX = "frame:";
export const frameNodeId = (key: string) => `${FRAME_ID_PREFIX}${key}`;
export const frameKeyOf = (id: string): string | null =>
	id.startsWith(FRAME_ID_PREFIX) ? id.slice(FRAME_ID_PREFIX.length) : null;

type XY = { x: number; y: number };

/** Tables et frames vont dans des frames ; consoles et nodes système non. */
export function canReparentNode(node: Node, parent: Node | null): boolean {
	if (node.type !== "table" && node.type !== "frame") return false;
	return parent === null || parent.type === "frame";
}

/**
 * Seul le lien fautif est coupé : `parentKey` vers un frame absent, ou lien
 * qui ferme un cycle. Le reste de l'arbre est conservé.
 */
export function normalizeFrames(frames: readonly Frame[]): readonly Frame[] {
	const keys = new Set(frames.map((f) => f.key));
	const parentOf = new Map<string, string>();
	for (const f of frames) {
		if (f.parentKey !== undefined && keys.has(f.parentKey)) {
			parentOf.set(f.key, f.parentKey);
		}
	}
	for (const f of frames) {
		const seen = new Set<string>();
		let current = parentOf.get(f.key);
		while (current !== undefined && !seen.has(current)) {
			if (current === f.key) {
				parentOf.delete(f.key);
				break;
			}
			seen.add(current);
			current = parentOf.get(current);
		}
	}
	let changed = false;
	const out = frames.map((frame) => {
		const parentKey = parentOf.get(frame.key);
		if (parentKey === frame.parentKey) return frame;
		changed = true;
		const { parentKey: _dropped, ...root } = frame;
		return parentKey === undefined ? root : { ...root, parentKey };
	});
	return changed ? out : frames;
}

/** Frame direct de chaque table. */
export function tableParents(frames: readonly Frame[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const f of frames) for (const c of f.collections) out.set(c, f.key);
	return out;
}

/** Descendants d'un frame : sous-frames (toutes profondeurs) et leurs tables. */
export function frameDescendants(
	frames: readonly Frame[],
	key: string
): { frames: Set<string>; tables: Set<string> } {
	const childrenOf = new Map<string, string[]>();
	for (const f of frames) {
		if (f.parentKey === undefined) continue;
		const list = childrenOf.get(f.parentKey) ?? [];
		list.push(f.key);
		childrenOf.set(f.parentKey, list);
	}
	const byKey = new Map(frames.map((f) => [f.key, f]));
	const outFrames = new Set<string>();
	const outTables = new Set<string>();
	const stack = [key];
	while (stack.length > 0) {
		const current = stack.pop() as string;
		for (const t of byKey.get(current)?.collections ?? []) outTables.add(t);
		for (const child of childrenOf.get(current) ?? []) {
			if (outFrames.has(child)) continue;
			outFrames.add(child);
			stack.push(child);
		}
	}
	return { frames: outFrames, tables: outTables };
}

const tableSize = (n: TableNodeType) => ({
	width: n.width ?? NODE_WIDTH,
	height: n.height ?? nodeHeight(n.data.collection)
});

// Même table, même frame au même endroit → même objet : le moteur ne re-rend
// pas toutes les tables d'un frame à chaque tick quand une seule bouge.
const relativeCache = new WeakMap<
	TableNodeType,
	{ parentId: string; x: number; y: number; node: TableNodeType }
>();

/** Tables dans le repère de leur frame : `parentId`, position relative. */
export function withFrameParents<T extends TableNodeType>(
	tables: readonly T[],
	frames: readonly Frame[]
): T[] {
	const byKey = new Map(frames.map((f) => [f.key, f]));
	const parents = tableParents(frames);
	return tables.map((table) => {
		const key = parents.get(table.id);
		const rect = key === undefined ? undefined : byKey.get(key)?.rect;
		if (key === undefined || rect === undefined) return table;
		const parentId = frameNodeId(key);
		const cached = relativeCache.get(table);
		if (
			cached !== undefined &&
			cached.parentId === parentId &&
			cached.x === rect.x &&
			cached.y === rect.y
		) {
			return cached.node as T;
		}
		const node = {
			...table,
			parentId,
			expandParent: true,
			position: {
				x: table.position.x - rect.x,
				y: table.position.y - rect.y
			}
		};
		relativeCache.set(table, { parentId, x: rect.x, y: rect.y, node });
		return node;
	});
}

/** Position d'un frame dans le repère de son parent. */
export function frameRelativePosition(
	frame: Frame & { rect: FrameRect },
	frames: readonly Frame[]
): XY {
	const parent =
		frame.parentKey === undefined
			? undefined
			: frames.find((f) => f.key === frame.parentKey)?.rect;
	if (parent === undefined) return { x: frame.rect.x, y: frame.rect.y };
	return { x: frame.rect.x - parent.x, y: frame.rect.y - parent.y };
}

export type AppliedCanvasChanges = {
	/** Frames mis à jour (même référence si rien n'a changé). */
	readonly frames: readonly Frame[];
	/** Changes à appliquer aux tables, positions en absolu. */
	readonly tableChanges: NodeChange<TableNodeType>[];
	/** Nouvelle position absolue des tables déplacées par ce lot. */
	readonly moved: Map<string, XY>;
};

/**
 * Ramène un lot de changes du moteur (positions relatives au parent,
 * re-parentages, agrandissements) en coordonnées absolues. Les positions
 * absolues sont recalculées de haut en bas : déplacer un frame déplace tout
 * son contenu, un enfant qui reçoit sa propre position la garde.
 */
export function applyCanvasChanges(
	changes: readonly NodeChange<TableNodeType>[],
	frames: readonly Frame[],
	tables: readonly TableNodeType[]
): AppliedCanvasChanges {
	const frameByKey = new Map(frames.map((f) => [f.key, f]));
	const tableById = new Map(tables.map((t) => [t.id, t]));
	const parentOfTable = tableParents(frames);
	const parentOfFrame = new Map<string, string | undefined>(
		frames.map((f) => [f.key, f.parentKey])
	);
	const absFrame = (key: string | undefined): XY => {
		const rect = key === undefined ? undefined : frameByKey.get(key)?.rect;
		return rect ? { x: rect.x, y: rect.y } : { x: 0, y: 0 };
	};

	// Repère relatif de départ.
	const relFrame = new Map<string, XY>();
	const sizeFrame = new Map<string, { width: number; height: number }>();
	for (const f of frames) {
		if (!f.rect) continue;
		const parent = absFrame(f.parentKey);
		relFrame.set(f.key, { x: f.rect.x - parent.x, y: f.rect.y - parent.y });
		sizeFrame.set(f.key, { width: f.rect.width, height: f.rect.height });
	}
	const relTable = new Map<string, XY>();
	for (const t of tables) {
		const parent = absFrame(parentOfTable.get(t.id));
		relTable.set(t.id, {
			x: t.position.x - parent.x,
			y: t.position.y - parent.y
		});
	}

	let framesTouched = false;
	let membershipTouched = false;
	const dragging = new Map<string, boolean | undefined>();
	const passthrough: NodeChange<TableNodeType>[] = [];
	for (const c of changes) {
		const id = c.type === "add" ? c.item.id : c.id;
		const frameKey = frameKeyOf(id);
		if (frameKey !== null) {
			if (!frameByKey.get(frameKey)?.rect) continue;
			if (c.type === "position" && c.position) {
				relFrame.set(frameKey, c.position);
				framesTouched = true;
			} else if (c.type === "parent") {
				parentOfFrame.set(
					frameKey,
					c.parentId ? (frameKeyOf(c.parentId) ?? undefined) : undefined
				);
				relFrame.set(frameKey, c.position);
				framesTouched = true;
				membershipTouched = true;
			} else if (
				c.type === "dimensions" &&
				c.dimensions &&
				(c.resizing === true || c.setAttributes)
			) {
				sizeFrame.set(frameKey, { ...c.dimensions });
				framesTouched = true;
			}
			continue;
		}
		if (!tableById.has(id)) {
			passthrough.push(c);
			continue;
		}
		if (c.type === "position" && c.position) {
			relTable.set(id, c.position);
			dragging.set(id, c.dragging);
		} else if (c.type === "parent") {
			const key = c.parentId ? frameKeyOf(c.parentId) : null;
			if (key) parentOfTable.set(id, key);
			else parentOfTable.delete(id);
			relTable.set(id, c.position);
			dragging.set(id, c.dragging);
			membershipTouched = true;
		} else {
			passthrough.push(c);
		}
	}

	// Positions absolues de haut en bas.
	const nextAbsFrame = new Map<string, XY>();
	const resolveFrame = (key: string, depth: number): XY => {
		const known = nextAbsFrame.get(key);
		if (known) return known;
		const rel = relFrame.get(key) ?? { x: 0, y: 0 };
		const parentKey = parentOfFrame.get(key);
		const parent =
			parentKey !== undefined &&
			relFrame.has(parentKey) &&
			depth < frames.length
				? resolveFrame(parentKey, depth + 1)
				: { x: 0, y: 0 };
		const abs = { x: parent.x + rel.x, y: parent.y + rel.y };
		nextAbsFrame.set(key, abs);
		return abs;
	};
	for (const key of relFrame.keys()) resolveFrame(key, 0);

	let nextFrames = frames;
	if (framesTouched || membershipTouched) {
		const members = new Map<string, string[]>();
		for (const [table, key] of parentOfTable) {
			const list = members.get(key) ?? [];
			list.push(table);
			members.set(key, list);
		}
		nextFrames = frames.map((f) => {
			const abs = nextAbsFrame.get(f.key);
			const size = sizeFrame.get(f.key);
			const parentKey = parentOfFrame.get(f.key);
			const collections = membershipTouched
				? f.collections
						.filter((c) => parentOfTable.get(c) === f.key)
						.concat(
							(members.get(f.key) ?? []).filter(
								(c) => !f.collections.includes(c)
							)
						)
				: f.collections;
			const rect =
				abs && size && f.rect
					? { x: abs.x, y: abs.y, width: size.width, height: size.height }
					: f.rect;
			const sameRect =
				rect === f.rect ||
				(rect !== undefined &&
					f.rect !== undefined &&
					rect.x === f.rect.x &&
					rect.y === f.rect.y &&
					rect.width === f.rect.width &&
					rect.height === f.rect.height);
			const sameMembers =
				collections.length === f.collections.length &&
				collections.every((c, i) => c === f.collections[i]);
			if (sameRect && sameMembers && parentKey === f.parentKey) return f;
			const { parentKey: _old, ...rest } = f;
			return {
				...rest,
				collections,
				...(rect ? { rect } : {}),
				...(parentKey !== undefined ? { parentKey } : {})
			};
		});
	}

	const tableChanges: NodeChange<TableNodeType>[] = [...passthrough];
	const moved = new Map<string, XY>();
	for (const t of tables) {
		const parent = nextAbsFrame.get(parentOfTable.get(t.id) ?? "") ?? {
			x: 0,
			y: 0
		};
		const rel = relTable.get(t.id) ?? t.position;
		const abs = { x: parent.x + rel.x, y: parent.y + rel.y };
		if (abs.x === t.position.x && abs.y === t.position.y && !dragging.has(t.id))
			continue;
		moved.set(t.id, abs);
		const flag = dragging.get(t.id);
		tableChanges.push({
			id: t.id,
			type: "position",
			position: abs,
			...(flag !== undefined ? { dragging: flag } : {})
		});
	}
	return { frames: nextFrames, tableChanges, moved };
}

/** Le frame le plus profond qui contient entièrement `rect`. */
export function deepestFrameContaining(
	frames: readonly Frame[],
	rect: FrameRect,
	exclude: ReadonlySet<string> = new Set()
): Frame | null {
	const depth = (f: Frame) => {
		let d = 0;
		let current = f.parentKey;
		const byKey = new Map(frames.map((x) => [x.key, x]));
		while (current !== undefined && d <= frames.length) {
			d += 1;
			current = byKey.get(current)?.parentKey;
		}
		return d;
	};
	let best: Frame | null = null;
	let bestDepth = -1;
	for (const f of frames) {
		if (!f.rect || exclude.has(f.key)) continue;
		const r = f.rect;
		if (
			rect.x >= r.x &&
			rect.y >= r.y &&
			rect.x + rect.width <= r.x + r.width &&
			rect.y + rect.height <= r.y + r.height
		) {
			const d = depth(f);
			if (d > bestDepth) {
				best = f;
				bestDepth = d;
			}
		}
	}
	return best;
}

const union = (a: FrameRect, b: FrameRect): FrameRect => {
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return {
		x,
		y,
		width: Math.max(a.x + a.width, b.x + b.width) - x,
		height: Math.max(a.y + a.height, b.y + b.height) - y
	};
};

/**
 * Agrandit `key` puis ses ancêtres pour contenir `rect` (marge `pad`), sans
 * jamais les rétrécir. Sert quand une table ou un frame rejoint un frame
 * hors de ses bords autrement que par un drag.
 */
export function growFramesToContain(
	frames: readonly Frame[],
	key: string,
	rect: FrameRect,
	pad: number
): readonly Frame[] {
	const byKey = new Map(frames.map((f) => [f.key, f]));
	const grown = new Map<string, FrameRect>();
	let current: string | undefined = key;
	let target = {
		x: rect.x - pad,
		y: rect.y - pad,
		width: rect.width + pad * 2,
		height: rect.height + pad * 2
	};
	let guard = 0;
	while (current !== undefined && guard <= frames.length) {
		const frame = byKey.get(current);
		if (!frame?.rect) break;
		const next = union(frame.rect, target);
		if (
			next.x === frame.rect.x &&
			next.y === frame.rect.y &&
			next.width === frame.rect.width &&
			next.height === frame.rect.height
		) {
			break;
		}
		grown.set(current, next);
		target = {
			x: next.x - pad,
			y: next.y - pad,
			width: next.width + pad * 2,
			height: next.height + pad * 2
		};
		current = frame.parentKey;
		guard += 1;
	}
	if (grown.size === 0) return frames;
	return frames.map((f) => {
		const rectNext = grown.get(f.key);
		return rectNext ? { ...f, rect: rectNext } : f;
	});
}

/** Rect absolu d'une table (taille par défaut si non mesurée). */
export function tableRect(table: TableNodeType): FrameRect {
	return { x: table.position.x, y: table.position.y, ...tableSize(table) };
}

/**
 * Rects recalculés de bas en haut après un auto-layout : un frame englobe
 * ses tables et ses sous-frames (marge `pad`). Un frame sans contenu garde
 * son rect.
 */
export function frameRectsFromContent(
	frames: readonly Frame[],
	tables: readonly TableNodeType[],
	pad: number
): readonly Frame[] {
	const tableById = new Map(tables.map((t) => [t.id, t]));
	const byKey = new Map(frames.map((f) => [f.key, f]));
	const done = new Map<string, FrameRect | null>();
	const compute = (key: string, depth: number): FrameRect | null => {
		if (done.has(key)) return done.get(key) ?? null;
		const frame = byKey.get(key);
		if (!frame || depth > frames.length) return null;
		let bounds: FrameRect | null = null;
		for (const name of frame.collections) {
			const t = tableById.get(name);
			if (!t) continue;
			const r = tableRect(t);
			bounds = bounds ? union(bounds, r) : r;
		}
		for (const child of frames) {
			if (child.parentKey !== key) continue;
			const r = compute(child.key, depth + 1);
			if (r) bounds = bounds ? union(bounds, r) : r;
		}
		const rect = bounds
			? {
					x: bounds.x - pad,
					y: bounds.y - pad,
					width: bounds.width + pad * 2,
					height: bounds.height + pad * 2
				}
			: (frame.rect ?? null);
		done.set(key, rect);
		return rect;
	};
	return frames.map((f) => {
		const rect = compute(f.key, 0);
		return rect ? { ...f, rect } : f;
	});
}
