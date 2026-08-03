import { type CanvasTool, CanvasToolbar } from "../../CanvasToolbar";
import { CanvasConsole } from "../../CanvasConsole";
import type { SchemaModel } from "../../schema-model";
import { AutoLayoutModal } from "../AutoLayoutModal";

export interface CanvasBottomBarProps {
	readonly schema: SchemaModel;
	/** Outil actif dans la toolbar canvas (select / frame). */
	readonly activeTool: CanvasTool;
	readonly onSelectTool: (t: CanvasTool) => void;
	/** Offset dynamique en bas — remonte la toolbar quand la console SNQL
	 * s'ouvre pour rester accessible. */
	readonly bottomOffset: number;
	/** Offset horizontal gauche pour la console — suit la largeur du drawer
	 * pour ne pas passer dessous. */
	readonly consoleLeftOffset: number;
	readonly onConsoleHeightChange: (h: number) => void;
	/** State du modal Auto-layout — géré côté parent (useCanvasActions). */
	readonly autoLayoutOpen: boolean;
	readonly onOpenAutoLayout: () => void;
	readonly onCloseAutoLayout: () => void;
	readonly onConfirmAutoLayout: () => void;
}

/**
 * Barre du bas : toolbar canvas (Select/Frame + Auto-layout button) + modal
 * de confirmation Auto-layout + console SNQL escamotable.
 *
 * Regroupé ici parce que ces 3 éléments partagent la « bande basse » du
 * canvas et se coordonnent visuellement (la toolbar remonte quand la
 * console s'ouvre). Ajouter un nouvel élément bas (ex: barre de statut) =
 * 1 endroit à modifier.
 */
export function CanvasBottomBar({
	schema,
	activeTool,
	onSelectTool,
	bottomOffset,
	consoleLeftOffset,
	onConsoleHeightChange,
	autoLayoutOpen,
	onOpenAutoLayout,
	onCloseAutoLayout,
	onConfirmAutoLayout
}: CanvasBottomBarProps) {
	return (
		<>
			<CanvasToolbar
				onAutoLayout={onOpenAutoLayout}
				bottomOffset={bottomOffset}
				activeTool={activeTool}
				onSelectTool={onSelectTool}
			/>
			<AutoLayoutModal
				opened={autoLayoutOpen}
				onClose={onCloseAutoLayout}
				onConfirm={onConfirmAutoLayout}
			/>
			<CanvasConsole
				engine={schema.engine as "postgres" | "mongodb"}
				leftOffset={consoleLeftOffset}
				onHeightChange={onConsoleHeightChange}
				schema={schema}
			/>
		</>
	);
}
