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
	/**
	 * Callback invoqué APRÈS l'application d'un snapshot restauré (undo/redo).
	 *
	 * Pourquoi c'est nécessaire — le hook restore les 4 sources qu'il détient
	 * (positions/sizes/frames/hiddenIds) via `replaceAll`, mais React Flow
	 * garde son propre state `nodes` (via `useNodesState` dans SchemaCanvas)
	 * qui n'est PAS dans l'API du hook. Sans ce callback, restaurer les
	 * positions ne bouge visuellement rien — les `nodes` RF gardent les
	 * positions post-drag.
	 *
	 * Le consommateur s'en sert typiquement pour appliquer
	 * `snapshot.positions` / `snapshot.sizes` sur son `setNodes` local, avec
	 * fallback sur le layout d'origine pour les nodes absents du snapshot.
	 */
	readonly onRestore?: (snapshot: CanvasSnapshot) => void;
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
 * (no-op). On maintient donc une ref `prevRef` qui porte l'état
 * pré-mutation ; `historySnapshot` la retourne au moment du push. Le sync
 * de `prevRef` vers l'état courant post-commit doit se faire APRÈS le push,
 * pas librement à chaque commit — sinon un geste continu (drag frame,
 * resize) qui dispatche N mutations avant le push final overwrite prevRef
 * à chaque commit intermédiaire et capture au drag-stop un snapshot
 * dégénéré (état intermédiaire, pas pré-geste). D'où le `pendingSyncRef`
 * qui gate l'update de prevRef : le push arme le sync, le useEffect qui
 * suit le commit du bump (ou du batch mutation+push) désarme et applique.
 * Entre deux pushes, prevRef reste stable — les commits intermédiaires
 * d'un geste continu passent sans effet.
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

	// `prevRef` = snapshot du dernier push validé (ou init si aucun push
	// n'a eu lieu). Ne bouge PAS librement entre deux pushes : les commits
	// intermédiaires d'un geste continu (drag/resize) sont ignorés.
	const prevRef = useRef<CanvasSnapshot>(captureNow());

	// `pendingSyncRef` = gate du sync post-push. Armé au push, désarmé au
	// prochain commit qui trouve opts à jour. Sans ce gate, chaque commit
	// (dont ceux d'un drag continu) écraserait prevRef vers l'état
	// intermédiaire.
	const pendingSyncRef = useRef(false);

	useEffect(() => {
		if (!pendingSyncRef.current) return;
		prevRef.current = {
			positions: opts.tablePositions.positions,
			sizes: opts.tableSizes.sizes,
			frames: opts.framesApi.frames,
			hiddenIds: Array.from(opts.hiddenIds)
		};
		pendingSyncRef.current = false;
	}, [
		opts.tablePositions.positions,
		opts.tableSizes.sizes,
		opts.framesApi.frames,
		opts.hiddenIds
	]);

	const historySnapshot = useCallback(() => prevRef.current, []);
	const historyRestore = useCallback((s: CanvasSnapshot) => {
		const { tablePositions, tableSizes, framesApi, setHiddenIds, onRestore } =
			optsRef.current;
		tablePositions.replaceAll(s.positions);
		tableSizes.replaceAll(s.sizes);
		framesApi.replaceAll(s.frames);
		setHiddenIds(new Set(s.hiddenIds));
		// Après un restore, l'état canvas est le snapshot restauré — sync
		// prevRef en direct (pas via le gate). Sans ça, le prochain push()
		// pousserait l'ancien prevRef (pré-restore) dans past → chaîne
		// past/future corrompue. On désarme aussi le pending sync : le
		// commit qui suit ne doit pas re-écraser prevRef sur base d'un opts
		// stale.
		prevRef.current = s;
		pendingSyncRef.current = false;
		// Signale au consommateur pour qu'il resync ses états externes
		// (typiquement le `nodes` RF). Voir docblock de `onRestore`.
		onRestore?.(s);
	}, []);

	const stack = useHistoryStack<CanvasSnapshot>({
		snapshot: historySnapshot,
		restore: historyRestore
	});

	// Wrapper push : arme le sync post-commit. `stack.push()` lit
	// `historySnapshot` = prevRef courant (l'état pré-geste depuis le
	// dernier push validé), et le pousse dans `past`. Au commit du bump
	// (ou du batch mutation+push si tout s'est fait dans un handler), le
	// useEffect ci-dessus met prevRef à jour vers l'état post-geste.
	const push = useCallback(() => {
		stack.push();
		pendingSyncRef.current = true;
	}, [stack.push]);

	return {
		push,
		undo: stack.undo,
		redo: stack.redo,
		canUndo: stack.canUndo,
		canRedo: stack.canRedo
	};
}
