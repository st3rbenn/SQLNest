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

/**
 * Répartit N points le long d'un segment centré sur 0. Pas fixe entre slots
 * (`SPACING`) → petits N restent groupés proche du mid, gros N s'écartent
 * jusqu'à un plafond (`±CAP`) puis se resserrent au-delà.
 *
 * Utilisé pour offset les endpoints d'edges qui partagent un même côté :
 * sans ça, plusieurs arrows se superposent au mid-side, impossibles à
 * cibler individuellement.
 *
 * - N=0 → []
 * - N=1 → [0]
 * - N=2 → [-0.1, +0.1] (grappe serrée)
 * - N=3 → [-0.2, 0, +0.2]
 * - N=5 → [-0.4, -0.2, 0, +0.2, +0.4] (au plafond)
 * - N>5 → équidistants dans [-0.4, +0.4], plus resserrés
 */
export function spreadOffsets(n: number): number[] {
	if (n <= 0) return [];
	if (n === 1) return [0];
	const SPACING = 0.2;
	const CAP = 0.4;
	const idealSpan = (n - 1) * SPACING;
	const span = Math.min(idealSpan, 2 * CAP);
	const step = span / (n - 1);
	return Array.from({ length: n }, (_, i) => -span / 2 + i * step);
}

/**
 * Côté d'un rect le plus proche d'un point (en coord monde). Utilisé quand
 * l'utilisateur relâche un endpoint d'edge sur le canvas : on snappe au
 * côté du rect target dont le milieu est le plus proche du curseur.
 *
 * Distance calculée du point au milieu de chaque côté — plus intuitive
 * qu'une distance perpendiculaire (qui privilégierait toujours la face
 * la plus proche même si le curseur est très hors du rect sur l'axe
 * complémentaire). Le mid-side reflète où le handle finit visuellement.
 */
export function closestSide(point: { x: number; y: number }, rect: Rect): Side {
	const midTop = { x: rect.x + rect.width / 2, y: rect.y };
	const midRight = { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
	const midBottom = { x: rect.x + rect.width / 2, y: rect.y + rect.height };
	const midLeft = { x: rect.x, y: rect.y + rect.height / 2 };
	const d = (a: { x: number; y: number }): number => {
		const dx = a.x - point.x;
		const dy = a.y - point.y;
		return dx * dx + dy * dy;
	};
	const scored: readonly { side: Side; dist: number }[] = [
		{ side: "top", dist: d(midTop) },
		{ side: "right", dist: d(midRight) },
		{ side: "bottom", dist: d(midBottom) },
		{ side: "left", dist: d(midLeft) }
	];
	let best = scored[0];
	if (!best) return "top";
	for (const s of scored) {
		if (s.dist < best.dist) best = s;
	}
	return best.side;
}
