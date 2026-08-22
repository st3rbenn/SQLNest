import type { FrameNodeType } from "../FrameNode";
import type { Frame, FrameRect } from "../frames";
import { NODE_WIDTH, type TableNodeType } from "../TableNode";

export const FRAME_PAD = 24;

/**
 * Bounds initiaux d'un frame à partir des positions des tables sélectionnées.
 * Sert au `createFrame` (rect stocké dans le frame) — après quoi le rect reste
 * fixe (drag/ajout/retrait de tables ne le déforme plus).
 */
export function boundsOfTables(
	tables: readonly TableNodeType[],
	pad: number
): { x: number; y: number; width: number; height: number } | null {
	if (tables.length === 0) return null;
	const minX = Math.min(...tables.map((n) => n.position.x));
	const minY = Math.min(...tables.map((n) => n.position.y));
	const maxX = Math.max(
		...tables.map((n) => n.position.x + (n.width ?? NODE_WIDTH))
	);
	const maxY = Math.max(...tables.map((n) => n.position.y + (n.height ?? 200)));
	return {
		x: minX - pad,
		y: minY - pad,
		width: maxX - minX + pad * 2,
		height: maxY - minY + pad * 2
	};
}

export function computeFrameNodes(
	frames: readonly Frame[],
	tableNodes: readonly TableNodeType[],
	onFrameResizeEnd: (key: string, rect: FrameRect) => void,
	onFrameRename: (key: string, label: string) => void,
	onFrameDelete: (key: string) => void,
	onFrameFocus: (key: string) => void
): FrameNodeType[] {
	if (frames.length === 0) return [];
	const byId = new Map(tableNodes.map((n) => [n.id, n]));
	return frames.flatMap((frame) => {
		// Rect explicite (user-defined avec `rect` posé) → utilisé tel quel.
		// Sinon → calcul dynamique à partir des membres (frames-seed hérités).
		let rect = frame.rect;
		if (!rect) {
			const members = frame.collections
				.map((c) => byId.get(c))
				.filter((n): n is TableNodeType => n !== undefined);
			rect = boundsOfTables(members, FRAME_PAD) ?? undefined;
			if (!rect) return [];
		}
		return [
			{
				id: `frame:${frame.key}`,
				type: "frame" as const,
				position: { x: rect.x, y: rect.y },
				width: rect.width,
				height: rect.height,
				// Callbacks passés BRUTS (stables via useCallback côté hook).
				// FrameNode les rappellera avec `frame.key` en premier arg — ça
				// évite de recréer des closures inline `(r) => handler(key, r)`
				// à chaque render, qui faisaient RF re-mesurer tous les frames
				// en boucle (re-mesures pendant un drag NodeResizer
				// réinitialisaient son état interne → axes qui sautaient).
				data: {
					frame,
					onResizeEnd: onFrameResizeEnd,
					onRename: onFrameRename,
					onDelete: onFrameDelete,
					onFocus: onFrameFocus
				},
				// Draggable pour déplacer le frame + ses tables ensemble
				// (handler `onNodeDrag` applique le delta aux membres).
				// NON sélectionnable : au lasso ou au clic, le frame est
				// ignoré (le user manipule les frames via drag + resize
				// handles NodeResizer toujours visibles).
				draggable: true,
				selectable: false,
				connectable: false,
				zIndex: -1
			}
		];
	});
}
