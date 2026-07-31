/**
 * Auto-routing des edges : détermine le meilleur couple (source-side, target-side)
 * en fonction des positions relatives des deux tables. Recalculé côté canvas à
 * chaque render (dérivé de `nodes` state), donc suit les drags en temps réel.
 */

export type Side = "top" | "right" | "bottom" | "left";

export interface Rect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/**
 * Meilleure paire de côtés pour un edge source → target : compare les
 * centres, l'axe dominant décide.
 * - `|dx| ≥ |dy|` : axe horizontal. Target à droite → source `right` /
 *   target `left`. Sinon inversé.
 * - Sinon : axe vertical. Target en-dessous → source `bottom` / target
 *   `top`. Sinon inversé.
 *
 * Les égalités strictes vont sur l'horizontal (arbitraire, cohérent avec
 * les schémas ER classiques dessinés en colonnes).
 */
export function bestHandles(
	source: Rect,
	target: Rect
): { source: Side; target: Side } {
	const sx = source.x + source.width / 2;
	const sy = source.y + source.height / 2;
	const tx = target.x + target.width / 2;
	const ty = target.y + target.height / 2;
	const dx = tx - sx;
	const dy = ty - sy;
	if (Math.abs(dx) >= Math.abs(dy)) {
		return dx >= 0
			? { source: "right", target: "left" }
			: { source: "left", target: "right" };
	}
	return dy >= 0
		? { source: "bottom", target: "top" }
		: { source: "top", target: "bottom" };
}
