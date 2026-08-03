import { useHotkeys } from "@mantine/hooks";

export interface UseUndoRedoShortcutsOptions {
	readonly onUndo: () => void;
	readonly onRedo: () => void;
}

/**
 * Cmd/Ctrl+Z (undo) · Cmd/Ctrl+Shift+Z ou Cmd/Ctrl+Y (redo).
 *
 * `mod` = Cmd (Mac) / Ctrl (Win/Linux) — OS-adaptatif built-in Mantine.
 *
 * `preventDefault: true` critique : sans lui, Chrome/Safari associent
 * Cmd+Z à « restore une tab fermée » — l'utilisateur perd complètement
 * son geste (aucun undo canvas, et un tab aléatoire réapparaît).
 *
 * Skip auto sur INPUT/TEXTAREA/SELECT (défaut Mantine) + on ajoute
 * `triggerOnContentEditable: false` pour préserver l'undo natif d'un
 * champ rename inline (frame label, éditeur SNQL).
 */
export function useUndoRedoShortcuts(opts: UseUndoRedoShortcutsOptions): void {
	useHotkeys([
		["mod+Z", () => opts.onUndo(), { preventDefault: true }],
		["mod+shift+Z", () => opts.onRedo(), { preventDefault: true }],
		["mod+Y", () => opts.onRedo(), { preventDefault: true }]
	]);
}
