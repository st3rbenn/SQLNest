import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Frame } from "../frames";
import type { SchemaModel } from "../schema-model";

export interface UseCanvasFocusOptions {
	/** Appelé à la fin de clearFocus() — le parent y réapplique l'overview. */
	onClear?: () => void;
}

export interface UseCanvasFocusReturn {
	focusId: string | null;
	focusFrameKey: string | null;
	/** Setter direct — pour les cas fins (effets de synchro, hideTable, …). */
	setFocusId: React.Dispatch<React.SetStateAction<string | null>>;
	/** Setter direct — idem, exposé pour les usages inline (delete frame, …). */
	setFocusFrameKey: React.Dispatch<React.SetStateAction<string | null>>;
	focusNode: (id: string) => void;
	focusFrame: (key: string) => void;
	clearFocus: () => void;
}

/**
 * Focus canvas — table (`focusId`) OU frame (`focusFrameKey`), mutuellement
 * exclusifs (un seul drawer détails à la fois). `clearFocus` déclenche le
 * callback `onClear` pour laisser le parent réappliquer l'overview.
 *
 * `onClear` est mémoïsé via ref → `clearFocus` reste stable même si le parent
 * passe une closure recréée à chaque render.
 */
export function useCanvasFocus(
	options: UseCanvasFocusOptions = {}
): UseCanvasFocusReturn {
	const [focusId, setFocusId] = useState<string | null>(null);
	const [focusFrameKey, setFocusFrameKey] = useState<string | null>(null);
	const onClearRef = useRef(options.onClear);
	onClearRef.current = options.onClear;

	const focusNode = useCallback((id: string) => {
		setFocusId(id);
		setFocusFrameKey(null);
	}, []);
	const focusFrame = useCallback((key: string) => {
		setFocusFrameKey(key);
		setFocusId(null);
	}, []);
	const clearFocus = useCallback(() => {
		setFocusId(null);
		setFocusFrameKey(null);
		onClearRef.current?.();
	}, []);

	return {
		focusId,
		focusFrameKey,
		setFocusId,
		setFocusFrameKey,
		focusNode,
		focusFrame,
		clearFocus
	};
}

/**
 * Frame dont le drawer montre les détails. Supprimé pendant qu'il est
 * affiché, il n'existe plus : le focus est levé.
 */
export function useFocusedFrame(
	frames: readonly Frame[],
	focusFrameKey: string | null,
	setFocusFrameKey: (key: string | null) => void
): Frame | undefined {
	const focusedFrame = useMemo(
		() =>
			focusFrameKey !== null
				? frames.find((f) => f.key === focusFrameKey)
				: undefined,
		[focusFrameKey, frames]
	);
	useEffect(() => {
		if (focusFrameKey !== null && focusedFrame === undefined) {
			setFocusFrameKey(null);
		}
	}, [focusFrameKey, focusedFrame, setFocusFrameKey]);
	return focusedFrame;
}

/**
 * Table focalisée puis supprimée : sans focus à tenir, le reste du canvas
 * resterait estompé. La vue ne bouge pas (pas de retour à la vue d'ensemble).
 */
export function useReleaseMissingFocus(
	schema: SchemaModel,
	focusId: string | null,
	setFocusId: (id: string | null) => void
): void {
	useEffect(() => {
		if (
			focusId !== null &&
			!schema.collections.some((c) => c.name === focusId)
		) {
			setFocusId(null);
		}
	}, [schema, focusId, setFocusId]);
}
