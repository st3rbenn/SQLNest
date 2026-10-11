import { useEffect, useMemo, useRef, useState } from "react";

export type KeyCode = string | string[] | null;

const INPUT_TAGS = ["INPUT", "SELECT", "TEXTAREA"];

/** Cible = champ éditable (ou dans `.nokey`) : les raccourcis canvas s'effacent. */
export function isInputEvent(event: Event): boolean {
	const target = (event.composedPath?.()[0] ?? event.target) as Element | null;
	if (target?.nodeType !== 1) return false;
	return (
		INPUT_TAGS.includes(target.nodeName) ||
		target.hasAttribute("contenteditable") ||
		target.closest(".nokey") !== null
	);
}

/** `"a+b"` → `["a", "b"]`, `"a++"` → `["a", "+"]`. */
function parseCombos(keyCode: KeyCode): string[][] {
	if (keyCode === null) return [];
	const list = Array.isArray(keyCode) ? keyCode : [keyCode];
	return list.map((kc) =>
		kc.replace("+", "\n").replace("\n\n", "\n+").split("\n")
	);
}

function matches(
	combos: string[][],
	pressed: Set<string>,
	isUp: boolean
): boolean {
	return combos
		.filter((keys) => isUp || keys.length === pressed.size)
		.some((keys) => keys.every((k) => pressed.has(k)));
}

/**
 * Suit l'appui d'une touche (ou combinaison) sur le document. Une touche
 * listée comme `code` (`"Space"`, `"KeyA"`) est comparée à `event.code`,
 * sinon à `event.key`. Ignore les champs éditables sauf avec un modificateur
 * (`actInsideInputWithModifier`).
 */
export function useKeyPress(
	keyCode: KeyCode,
	options: {
		actInsideInputWithModifier?: boolean;
		preventDefault?: boolean;
		target?: "document" | "window";
	} = {}
): boolean {
	const [pressed, setPressed] = useState(false);
	const pressedKeys = useRef(new Set<string>());
	const modifierPressed = useRef(false);
	const actInsideInputWithModifier = options.actInsideInputWithModifier ?? true;
	const preventDefault = options.preventDefault ?? true;
	const targetKind = options.target ?? "document";
	const [combos, watched] = useMemo(() => {
		const c = parseCombos(keyCode);
		return [c, c.flat()];
	}, [keyCode]);

	useEffect(() => {
		if (keyCode === null) return;
		const keyOf = (event: KeyboardEvent) =>
			watched.includes(event.code) ? event.code : event.key;
		const down = (event: KeyboardEvent) => {
			modifierPressed.current =
				event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;
			if (
				(!modifierPressed.current || !actInsideInputWithModifier) &&
				isInputEvent(event)
			) {
				return;
			}
			pressedKeys.current.add(keyOf(event));
			if (matches(combos, pressedKeys.current, false)) {
				const target = (event.composedPath?.()[0] ??
					event.target) as Element | null;
				const interactive =
					target?.nodeName === "BUTTON" || target?.nodeName === "A";
				if (preventDefault && (modifierPressed.current || !interactive)) {
					event.preventDefault();
				}
				setPressed(true);
			}
		};
		const up = (event: KeyboardEvent) => {
			if (matches(combos, pressedKeys.current, true)) {
				setPressed(false);
				pressedKeys.current.clear();
			} else {
				pressedKeys.current.delete(keyOf(event));
			}
			// macOS : Cmd enfoncé, les keyup des autres touches ne partent pas.
			if (event.key === "Meta") pressedKeys.current.clear();
			modifierPressed.current = false;
		};
		const reset = () => {
			pressedKeys.current.clear();
			setPressed(false);
		};
		const target: Document | Window =
			targetKind === "window" ? window : document;
		target.addEventListener("keydown", down as EventListener);
		target.addEventListener("keyup", up as EventListener);
		window.addEventListener("blur", reset);
		window.addEventListener("contextmenu", reset);
		return () => {
			target.removeEventListener("keydown", down as EventListener);
			target.removeEventListener("keyup", up as EventListener);
			window.removeEventListener("blur", reset);
			window.removeEventListener("contextmenu", reset);
		};
	}, [
		keyCode,
		combos,
		watched,
		actInsideInputWithModifier,
		preventDefault,
		targetKind
	]);

	return pressed;
}
