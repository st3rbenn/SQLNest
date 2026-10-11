import { type ReactNode, useState } from "react";
import { StoreContext } from "../context";
import { type CanvasStore, createCanvasStore } from "../store";

export const DEFAULT_MIN_ZOOM = 0.5;
export const DEFAULT_MAX_ZOOM = 2;

export function newStore(
	minZoom = DEFAULT_MIN_ZOOM,
	maxZoom = DEFAULT_MAX_ZOOM
): CanvasStore {
	return createCanvasStore({ minZoom, maxZoom, transform: [0, 0, 1] });
}

/**
 * Store partagé entre `<NestCanvas>` et des composants rendus à côté de lui
 * (panneaux, drawers) qui ont besoin de `useNestCanvas()`.
 */
export function NestCanvasProvider({ children }: { children: ReactNode }) {
	const [store] = useState(() => newStore());
	return (
		<StoreContext.Provider value={store}>{children}</StoreContext.Provider>
	);
}
