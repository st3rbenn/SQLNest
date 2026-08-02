/**
 * Sérialisation / désérialisation de l'état canvas ↔ payload plat JSON-safe.
 *
 * Le backend traite le payload comme opaque (`z.record(z.unknown())`). C'est
 * ce fichier qui gère la forme concrète : positions, sizes, frames, hidden.
 * On garde le format volontairement simple (mêmes clés côté in-memory et côté
 * serveur) — pas de versioning au v1, si le format doit évoluer on ajoutera
 * un champ `version` et un migrator dans `deserialize`.
 */

import type { Frame } from "../frames";
import type { AnchorMap } from "../useEdgeAnchors";
import type { PositionsMap } from "../useTablePositions";
import type { SizesMap } from "../useTableSizes";

/** État canvas vivant (celui manipulé par les 5 hooks). */
export interface CanvasSources {
	readonly positions: PositionsMap;
	readonly sizes: SizesMap;
	readonly frames: readonly Frame[];
	readonly hidden: ReadonlySet<string>;
	readonly edgeAnchors: AnchorMap;
}

/** État canvas remis en forme JSON-safe (Set → Array). */
export interface CanvasPayload {
	readonly positions: PositionsMap;
	readonly sizes: SizesMap;
	readonly frames: readonly Frame[];
	readonly hidden: readonly string[];
	readonly edgeAnchors: AnchorMap;
}

/**
 * Convertit les 4 slices vivants en payload JSON-safe (Set devient Array).
 * Les positions / sizes / frames sont déjà des structures JSON-safe — on
 * les propage tels quels sans copie profonde (l'appelant s'en occupe s'il
 * en a besoin, typiquement via `JSON.stringify`).
 */
export function serialize(sources: CanvasSources): CanvasPayload {
	return {
		positions: sources.positions,
		sizes: sources.sizes,
		frames: sources.frames,
		hidden: Array.from(sources.hidden),
		edgeAnchors: sources.edgeAnchors
	};
}

/**
 * Extrait les 4 slices depuis un payload serveur potentiellement partiel
 * (schéma corrompu, ancienne version, champ manquant). Defaults robustes :
 * un champ absent ou de mauvais type retombe sur la valeur vide.
 *
 * Ne throw JAMAIS — si le payload est complètement cassé, on doit livrer un
 * canvas vide plutôt que de casser la page.
 */
export function deserialize(payload: Record<string, unknown>): CanvasSources {
	const positions = isPlainRecord(payload.positions)
		? (payload.positions as PositionsMap)
		: {};
	const sizes = isPlainRecord(payload.sizes) ? (payload.sizes as SizesMap) : {};
	const frames: readonly Frame[] = Array.isArray(payload.frames)
		? (payload.frames as Frame[])
		: [];
	const hiddenList: readonly string[] = Array.isArray(payload.hidden)
		? (payload.hidden as unknown[]).filter(
				(x): x is string => typeof x === "string"
			)
		: [];
	const edgeAnchors = isPlainRecord(payload.edgeAnchors)
		? (payload.edgeAnchors as AnchorMap)
		: ({} as AnchorMap);
	return {
		positions,
		sizes,
		frames,
		hidden: new Set(hiddenList),
		edgeAnchors
	};
}

/** Garde-fou : true si la valeur est un objet plain (pas array, pas null). */
function isPlainRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
