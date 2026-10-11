import { createContext, useContext, useRef, useSyncExternalStore } from "react";
import type { CanvasState, CanvasStore } from "./store";

export const StoreContext = createContext<CanvasStore | null>(null);
/** Id du node en cours de rendu — lu par `Handle` et `NodeResizer`. */
export const NodeIdContext = createContext<string | null>(null);

export function useStoreApi(): CanvasStore {
	const store = useContext(StoreContext);
	if (store === null) {
		throw new Error(
			"@sqlnest/canvas : hook appelé hors de <NestCanvas> / <NestCanvasProvider>."
		);
	}
	return store;
}

export function useNodeId(): string | null {
	return useContext(NodeIdContext);
}

export function shallow<T>(a: T, b: T): boolean {
	if (Object.is(a, b)) return true;
	if (
		typeof a !== "object" ||
		a === null ||
		typeof b !== "object" ||
		b === null
	)
		return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const ka = Object.keys(a);
	if (ka.length !== Object.keys(b).length) return false;
	for (const key of ka) {
		if (
			!Object.hasOwn(b, key) ||
			!Object.is(
				(a as Record<string, unknown>)[key],
				(b as Record<string, unknown>)[key]
			)
		) {
			return false;
		}
	}
	return true;
}

type Memo<U> = {
	state: CanvasState;
	selector: (s: CanvasState) => U;
	value: U;
};

/**
 * Abonnement sélectif au store : ne re-rend que si la sélection change selon
 * `equality` — un node ne se re-rend pas quand un autre bouge.
 */
export function useNestStore<U>(
	selector: (s: CanvasState) => U,
	equality: (a: U, b: U) => boolean = Object.is
): U {
	const store = useStoreApi();
	const memo = useRef<Memo<U> | null>(null);
	const getSnapshot = () => {
		const state = store.getState();
		const m = memo.current;
		if (m !== null && m.state === state && m.selector === selector)
			return m.value;
		const next = selector(state);
		if (m !== null && equality(m.value, next)) {
			memo.current = { state, selector, value: m.value };
			return m.value;
		}
		memo.current = { state, selector, value: next };
		return next;
	};
	return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
