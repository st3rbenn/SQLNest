import { useCallback, useRef, useState } from "react";

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
