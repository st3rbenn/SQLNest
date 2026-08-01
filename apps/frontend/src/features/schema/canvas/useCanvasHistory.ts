import { useCallback, useEffect, useRef } from "react";
import type { Frame } from "../frames";
import type { FramesApi } from "../useFrames";
import type { PositionsApi, PositionsMap } from "../useTablePositions";
import type { SizesApi, SizesMap } from "../useTableSizes";
import { useHistoryStack, type UseHistoryStackReturn } from "./useHistoryStack";

export interface CanvasSnapshot {
	readonly positions: PositionsMap;
	readonly sizes: SizesMap;
	readonly frames: readonly Frame[];
	readonly hiddenIds: readonly string[];
}

export interface UseCanvasHistoryOptions {
	readonly tablePositions: PositionsApi;
	readonly tableSizes: SizesApi;
	readonly framesApi: FramesApi;
	readonly hiddenIds: ReadonlySet<string>;
	readonly setHiddenIds: React.Dispatch<
		React.SetStateAction<ReadonlySet<string>>
	>;
}

export interface UseCanvasHistoryReturn extends UseHistoryStackReturn {}

/**
 * Composition d'`useHistoryStack` avec les 3 hooks de persistance canvas
 * (positions / sizes / frames) + les tables masquées. Un snapshot capture
 * l'union de ces 4 sources ; `restore` re-écrit chacune atomiquement via
 * `replaceAll` (setter dédié qui bypass le merge des setters incrémentaux).
 *
 * Timing du push — le consommateur appelle `push()` **après** ses mutations
 * (drag stop, resize end, create/remove/rename frame, hide, auto-layout).
 * L'entrée sauvegardée dans `past` doit alors être l'état **avant** la
 * mutation — sinon undo restaurerait ce que l'utilisateur vient de faire
 * (no-op). On maintient donc une ref `prevRef` qui suit les valeurs
 * COMMITTED (mise à jour dans un `useEffect` post-render) et `snapshot`
 * la retourne. Quand `push()` fire synchrone après un `setState`, l'effet
 * de resync n'a pas encore tourné → `prevRef` contient bien l'état
 * pré-mutation. C'est le contrat qui rend « push après mutation » viable
 * malgré la sémantique classique undo/redo.
 */
export function useCanvasHistory(
	opts: UseCanvasHistoryOptions
): UseCanvasHistoryReturn {
	const optsRef = useRef(opts);
	optsRef.current = opts;

	const captureNow = useCallback((): CanvasSnapshot => {
		const { tablePositions, tableSizes, framesApi, hiddenIds } = optsRef.current;
		return {
			positions: tablePositions.positions,
			sizes: tableSizes.sizes,
			frames: framesApi.frames,
			hiddenIds: Array.from(hiddenIds)
		};
	}, []);

	// `prevRef` = dernier état effectivement commit à React. Sert de source
	// à `snapshot()` (voir docblock du hook). Initialisé au 1er render à
	// partir de l'état courant — au tout premier mount, past est vide donc
	// aucun undo n'est possible tant qu'un push() n'a pas eu lieu.
	const prevRef = useRef<CanvasSnapshot>(captureNow());

	// Resync post-commit. Chaque changement d'une des 4 sources → cet effet
	// tourne APRÈS `push()` (qui aura consommé `prevRef` = état pré-mutation),
	// et met à jour `prevRef` avec le nouvel état pour le prochain push.
	useEffect(() => {
		prevRef.current = {
			positions: opts.tablePositions.positions,
			sizes: opts.tableSizes.sizes,
			frames: opts.framesApi.frames,
			hiddenIds: Array.from(opts.hiddenIds)
		};
	}, [
		opts.tablePositions.positions,
		opts.tableSizes.sizes,
		opts.framesApi.frames,
		opts.hiddenIds
	]);

	const historySnapshot = useCallback(() => prevRef.current, []);
	const historyRestore = useCallback((s: CanvasSnapshot) => {
		const { tablePositions, tableSizes, framesApi, setHiddenIds } =
			optsRef.current;
		tablePositions.replaceAll(s.positions);
		tableSizes.replaceAll(s.sizes);
		framesApi.replaceAll(s.frames);
		setHiddenIds(new Set(s.hiddenIds));
	}, []);

	return useHistoryStack<CanvasSnapshot>({
		snapshot: historySnapshot,
		restore: historyRestore
	});
}
