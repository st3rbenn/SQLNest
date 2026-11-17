import type { Viewport, ViewportSafeArea } from "./viewport";

export interface FlowRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** Marge gardée entre le frame montré et le bord de la zone libre. */
export const REVEAL_MARGIN = 24;

/**
 * Déplacement le long d'un axe pour que le segment `[start, start + size]`
 * tienne dans `[min, max]`. Plus long que la zone, il montre son début, sauf
 * s'il la couvre déjà.
 */
function shift(start: number, size: number, min: number, max: number): number {
	const end = start + size;
	if (size > max - min) return start <= min && end >= max ? 0 : min - start;
	if (start < min) return min - start;
	if (end > max) return max - end;
	return 0;
}

/**
 * Vue qui montre `rect` en entier dans la zone libre du canvas, par le plus
 * petit déplacement et sans toucher au zoom. `null` : il y est déjà.
 */
export function revealViewport(
	from: Viewport,
	rect: FlowRect,
	container: { readonly width: number; readonly height: number },
	safeArea: ViewportSafeArea,
	margin: number = REVEAL_MARGIN
): Viewport | null {
	const dx = shift(
		rect.x * from.zoom + from.x,
		rect.width * from.zoom,
		(safeArea.left ?? 0) + margin,
		container.width - (safeArea.right ?? 0) - margin
	);
	const dy = shift(
		rect.y * from.zoom + from.y,
		rect.height * from.zoom,
		(safeArea.top ?? 0) + margin,
		container.height - (safeArea.bottom ?? 0) - margin
	);
	if (dx === 0 && dy === 0) return null;
	return { x: from.x + dx, y: from.y + dy, zoom: from.zoom };
}
