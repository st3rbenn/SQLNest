import { useHotkeys } from "@mantine/hooks";
import type { CanvasTool } from "../CanvasToolbar";

export interface UseCanvasHotkeysOptions {
	readonly activeTool: CanvasTool;
	readonly setActiveTool: (tool: CanvasTool) => void;
	readonly selectedTables: readonly string[];
	readonly clearSelection: () => void;
	readonly hideSelected: () => void;
	readonly createFrameFromSelection: () => void;
	readonly createConsole: () => void;
	readonly focusedConsoleId: string | null;
	readonly exitConsoleFocus: () => void;
}

/**
 * Raccourcis du canvas. `useHotkeys` les ignore dans un champ de saisie ou
 * un contenu éditable : le renommage en place et l'éditeur gardent les leurs.
 */
export function useCanvasHotkeys({
	activeTool,
	setActiveTool,
	selectedTables,
	clearSelection,
	hideSelected,
	createFrameFromSelection,
	createConsole,
	focusedConsoleId,
	exitConsoleFocus
}: UseCanvasHotkeysOptions): void {
	const hideSelection = () => {
		if (selectedTables.length === 0) return;
		hideSelected();
		clearSelection();
	};
	useHotkeys([
		[
			"Escape",
			() => {
				// La console en plein écran d'abord, sinon l'outil frame en cours.
				if (focusedConsoleId !== null) {
					exitConsoleFocus();
					return;
				}
				if (activeTool === "frame") setActiveTool("select");
			},
			{ preventDefault: true }
		],
		["V", () => setActiveTool("select"), { preventDefault: true }],
		[
			"F",
			() => {
				// Avec une sélection : en fait un frame. Sans : passe à l'outil
				// frame (lasso).
				if (selectedTables.length > 0) {
					createFrameFromSelection();
					clearSelection();
				} else {
					setActiveTool("frame");
				}
			},
			{ preventDefault: true }
		],
		["C", createConsole, { preventDefault: true }],
		["Backspace", hideSelection, { preventDefault: true }],
		["Delete", hideSelection, { preventDefault: true }]
	]);
}
