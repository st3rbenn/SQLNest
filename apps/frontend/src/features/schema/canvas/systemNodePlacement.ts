import type { XY } from "../useTablePositions";

export interface Rect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** Espace laissé entre un node système et ce qui l'entoure. */
const GAP = 60;

function intersects(a: Rect, b: Rect): boolean {
	return (
		a.x < b.x + b.width &&
		b.x < a.x + a.width &&
		a.y < b.y + b.height &&
		b.y < a.y + a.height
	);
}

/**
 * Place d'un node système qui n'en a pas encore : dans une colonne à gauche
 * de tout le contenu du canvas (tables et frames), donc sur rien. Dans la
 * colonne, il descend sous les nodes système déjà là (`taken`).
 * `null` tant que le canvas n'a pas de contenu : rien à éviter.
 */
export function placeBesideContent(
	content: readonly Rect[],
	taken: readonly Rect[],
	size: { readonly width: number; readonly height: number }
): XY | null {
	if (content.length === 0) return null;
	const left = Math.min(...content.map((r) => r.x));
	const top = Math.min(...content.map((r) => r.y));
	const x = left - GAP - size.width;
	let y = top;
	for (;;) {
		const candidate = { x, y, width: size.width, height: size.height };
		const hit = taken.find((r) => intersects(r, candidate));
		if (hit === undefined) return { x, y };
		y = hit.y + hit.height + GAP;
	}
}
