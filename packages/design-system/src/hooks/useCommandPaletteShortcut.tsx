import { useEffect } from "react";

/**
 * Binds Cmd/Ctrl+K globally to trigger the command palette.
 *
 * Fires even when an input has focus — the palette is a top-level tool,
 * reachable from anywhere. Preventing the browser default (Chrome's address-
 * bar focus on Cmd+L is out of scope; Cmd+K is unclaimed in most browsers,
 * but Firefox binds it to search bar → preventDefault is the safe move).
 */
export function useCommandPaletteShortcut(onOpen: () => void): void {
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			const isMod = e.metaKey || e.ctrlKey;
			if (!isMod) return;
			if (e.key !== "k" && e.key !== "K") return;
			e.preventDefault();
			onOpen();
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [onOpen]);
}
