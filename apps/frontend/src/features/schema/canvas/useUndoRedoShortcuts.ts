import { useEffect } from "react";

export interface UseUndoRedoShortcutsOptions {
	readonly onUndo: () => void;
	readonly onRedo: () => void;
}

/**
 * Écoute Cmd/Ctrl+Z (undo) et Cmd/Ctrl+Shift+Z ou Cmd/Ctrl+Y (redo)
 * au niveau document.
 *
 * `preventDefault()` est **critique** : sans lui, Chrome/Safari
 * associent Cmd+Z à « restore une tab fermée » — l'utilisateur perd
 * complètement son geste (aucun undo canvas, et un tab aléatoire
 * réapparaît).
 *
 * SKIP quand le focus est dans un input, textarea ou contenteditable :
 * l'undo natif du champ (rename inline d'un frame, éditeur SNQL) doit
 * rester fonctionnel — sinon on kidnappe le comportement attendu.
 *
 * Cross-platform via `e.metaKey || e.ctrlKey`. Le raccourci `Cmd+Y`
 * (Windows-ish, souvent Cmd+Y = « history » sur macOS Chrome) est
 * accepté aussi pour couvrir les habitudes des deux camps.
 */
export function useUndoRedoShortcuts(opts: UseUndoRedoShortcutsOptions): void {
	const { onUndo, onRedo } = opts;
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			const mod = e.metaKey || e.ctrlKey;
			if (!mod) return;
			const key = e.key.toLowerCase();
			if (key !== "z" && key !== "y") return;

			// Skip si focus dans un champ éditable — préserve l'undo natif.
			const target = e.target as HTMLElement | null;
			if (
				target &&
				(target.tagName === "INPUT" ||
					target.tagName === "TEXTAREA" ||
					target.isContentEditable)
			) {
				return;
			}

			// Redo : Cmd/Ctrl+Shift+Z OU Cmd/Ctrl+Y
			if ((key === "z" && e.shiftKey) || (key === "y" && !e.shiftKey)) {
				e.preventDefault();
				onRedo();
				return;
			}
			// Undo : Cmd/Ctrl+Z sans Shift
			if (key === "z" && !e.shiftKey) {
				e.preventDefault();
				onUndo();
			}
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onUndo, onRedo]);
}
