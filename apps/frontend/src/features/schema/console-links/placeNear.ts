export interface Rect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export type Side = "right" | "below" | "left" | "above";

export interface PlaceNearOptions {
	/** Écart entre l'ancre et le frame posé. */
	readonly gap: number;
	/** Marge gardée avec les autres frames. */
	readonly clearance: number;
	/** Côtés essayés, du préféré au moins bon : à distance égale, le
	 * premier l'emporte. */
	readonly prefer: readonly Side[];
	/** `center` : centré sur l'ancre le long du côté choisi (dessous : au
	 * milieu de sa largeur). `start`, par défaut : aligné sur son coin
	 * haut-gauche. */
	readonly align?: "start" | "center";
}

const MAX_HOPS = 64;

function overlaps(a: Rect, b: Rect, clearance: number): boolean {
	return (
		a.x < b.x + b.width + clearance &&
		a.x + a.width + clearance > b.x &&
		a.y < b.y + b.height + clearance &&
		a.y + a.height + clearance > b.y
	);
}

/** Position de départ d'un frame collé à `side` de l'ancre. */
function beside(
	anchor: Rect,
	size: { readonly width: number; readonly height: number },
	side: Side,
	gap: number,
	align: "start" | "center"
): { x: number; y: number } {
	const centred = align === "center";
	const x = centred ? anchor.x + (anchor.width - size.width) / 2 : anchor.x;
	const y = centred ? anchor.y + (anchor.height - size.height) / 2 : anchor.y;
	if (side === "right") return { x: anchor.x + anchor.width + gap, y };
	if (side === "left") return { x: anchor.x - gap - size.width, y };
	if (side === "below") return { x, y: anchor.y + anchor.height + gap };
	return { x, y: anchor.y - gap - size.height };
}

/**
 * Place libre la plus proche de `anchor` pour un frame de taille `size`,
 * sans recouvrir aucun des frames de `taken`. De chaque côté de l'ancre, le
 * frame part collé à elle et saute par-dessus ce qui le gêne, en s'éloignant ;
 * le côté qui demande le moins de chemin gagne.
 */
export function placeNear(
	anchor: Rect,
	size: { readonly width: number; readonly height: number },
	taken: readonly Rect[],
	{ gap, clearance, prefer, align = "start" }: PlaceNearOptions
): { x: number; y: number } {
	let best: { x: number; y: number } | null = null;
	let bestCost = Number.POSITIVE_INFINITY;
	for (const side of prefer) {
		const start = beside(anchor, size, side, gap, align);
		const at = { ...start };
		let free = false;
		for (let hop = 0; hop < MAX_HOPS; hop++) {
			const rect = { ...at, ...size };
			const blocker = taken.find((t) => overlaps(rect, t, clearance));
			if (blocker === undefined) {
				free = true;
				break;
			}
			if (side === "right") at.x = blocker.x + blocker.width + clearance;
			else if (side === "left") at.x = blocker.x - clearance - size.width;
			else if (side === "below") at.y = blocker.y + blocker.height + clearance;
			else at.y = blocker.y - clearance - size.height;
		}
		if (!free) continue;
		const cost = Math.abs(at.x - start.x) + Math.abs(at.y - start.y);
		if (cost < bestCost) {
			best = at;
			bestCost = cost;
		}
	}
	// Tout est pris jusqu'au bout de la recherche : collé au côté préféré.
	return best ?? beside(anchor, size, prefer[0] ?? "right", gap, align);
}
