import { useCallback, useRef, useState } from "react";

export interface UseHistoryStackOptions<S> {
	/** Fabrique un snapshot du state courant. Appelé au push() et au premier mount. */
	snapshot: () => S;
	/** Applique un snapshot précédent. Doit être synchrone (setState immédiat). */
	restore: (s: S) => void;
	/** Taille max du stack (défaut 50). Trim par la tête (les plus vieux d'abord). */
	max?: number;
	/** Comparaison pour dédupe : si push() reçoit un snapshot égal au top, no-op.
	 *  Défaut : JSON.stringify equality. */
	equals?: (a: S, b: S) => boolean;
}

export interface UseHistoryStackReturn {
	readonly push: () => void;
	readonly undo: () => void;
	readonly redo: () => void;
	readonly canUndo: boolean;
	readonly canRedo: boolean;
}

const DEFAULT_MAX = 50;

function defaultEquals<S>(a: S, b: S): boolean {
	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch {
		return a === b;
	}
}

/**
 * Hook générique undo/redo par snapshot.
 *
 * L'état interne est `{ past, future }` — le "présent" n'est jamais dans le
 * stack : on l'obtient à la demande via `snapshot()`. Un undo pop `past`,
 * pousse le présent courant dans `future`, puis restore le pop. Redo est
 * symétrique.
 *
 * Le stack est trimmé par la tête (les plus vieux d'abord) au-dessus de
 * `max` (défaut 50). `push()` dédupe si le nouveau snapshot est égal au
 * dernier de `past` (via `equals` fourni ou JSON.stringify par défaut).
 *
 * Un `isRestoringRef` interne garantit qu'un `push()` déclenché
 * indirectement pendant `restore()` (ex : consommateur qui wire push sur
 * un event de commit d'état) devient un no-op — évite d'écraser l'historique
 * pendant qu'on le rejoue.
 */
export function useHistoryStack<S>(
	opts: UseHistoryStackOptions<S>
): UseHistoryStackReturn {
	// On garde les options dans un ref pour permettre au consommateur de
	// passer des closures qui capturent du state courant sans avoir à
	// remémoriser les callbacks retournés par le hook.
	const optsRef = useRef(opts);
	optsRef.current = opts;

	// Source de vérité : ref, pour éviter des side effects dans un updater
	// setState (React 18 strict mode peut rejouer les updaters). setTick
	// sert uniquement à déclencher un re-render pour rafraîchir canUndo/Redo.
	const stackRef = useRef<{ past: S[]; future: S[] }>({
		past: [],
		future: []
	});
	const [, setTick] = useState(0);
	const bump = useCallback(() => setTick((n) => (n + 1) | 0), []);

	// Gate anti-boucle pendant restore(). Positionné true juste avant restore,
	// remis à false immédiatement après. Un push() manuel du consommateur reste
	// possible tout de suite après ; mais un push déclenché en cascade dans
	// restore() sera absorbé — c'est le comportement voulu.
	const isRestoringRef = useRef(false);

	const eq = useCallback((a: S, b: S) => {
		const custom = optsRef.current.equals;
		return custom ? custom(a, b) : defaultEquals(a, b);
	}, []);

	const push = useCallback(() => {
		if (isRestoringRef.current) return;
		const snap = optsRef.current.snapshot();
		const { past } = stackRef.current;
		const top = past.length > 0 ? past[past.length - 1] : undefined;
		if (past.length > 0 && top !== undefined && eq(top, snap)) return;
		const cap = optsRef.current.max ?? DEFAULT_MAX;
		let nextPast = past.concat(snap);
		if (nextPast.length > cap) {
			nextPast = nextPast.slice(nextPast.length - cap);
		}
		stackRef.current = { past: nextPast, future: [] };
		bump();
	}, [bump, eq]);

	const undo = useCallback(() => {
		const { past, future } = stackRef.current;
		if (past.length === 0) return;
		const current = optsRef.current.snapshot();
		const restored = past[past.length - 1] as S;
		stackRef.current = {
			past: past.slice(0, -1),
			future: future.concat(current)
		};
		isRestoringRef.current = true;
		try {
			optsRef.current.restore(restored);
		} finally {
			isRestoringRef.current = false;
		}
		bump();
	}, [bump]);

	const redo = useCallback(() => {
		const { past, future } = stackRef.current;
		if (future.length === 0) return;
		const current = optsRef.current.snapshot();
		const restored = future[future.length - 1] as S;
		stackRef.current = {
			past: past.concat(current),
			future: future.slice(0, -1)
		};
		isRestoringRef.current = true;
		try {
			optsRef.current.restore(restored);
		} finally {
			isRestoringRef.current = false;
		}
		bump();
	}, [bump]);

	return {
		push,
		undo,
		redo,
		canUndo: stackRef.current.past.length > 0,
		canRedo: stackRef.current.future.length > 0
	};
}
