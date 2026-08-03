import { CanvasToolbar } from "../../CanvasToolbar";
import { CanvasConsole } from "../../CanvasConsole";
import { AutoLayoutModal } from "../AutoLayoutModal";
import {
	useCanvasActionsCtx,
	useCanvasData,
	useCanvasUI
} from "../CanvasContext";

/**
 * Barre du bas : toolbar canvas (Select/Frame + Auto-layout button) + modal
 * de confirmation Auto-layout + console SNQL escamotable.
 *
 * Consomme directement les 3 contexts nécessaires — aucun prop parent.
 * Ajouter un élément bas (barre de statut, autre bouton) = édit ici, sans
 * toucher SchemaCanvas.
 */
export function CanvasBottomBar() {
	const { schema } = useCanvasData();
	const {
		activeTool,
		setActiveTool,
		consoleHeight,
		setConsoleHeight,
		consoleGap,
		leftPadding,
		layoutConfirmOpen,
		setLayoutConfirmOpen
	} = useCanvasUI();
	const { relayoutAll } = useCanvasActionsCtx();
	return (
		<>
			<CanvasToolbar
				onAutoLayout={() => setLayoutConfirmOpen(true)}
				bottomOffset={consoleHeight + consoleGap}
				activeTool={activeTool}
				onSelectTool={setActiveTool}
			/>
			<AutoLayoutModal
				opened={layoutConfirmOpen}
				onClose={() => setLayoutConfirmOpen(false)}
				onConfirm={relayoutAll}
			/>
			<CanvasConsole
				engine={schema.engine as "postgres" | "mongodb"}
				leftOffset={leftPadding}
				onHeightChange={setConsoleHeight}
				schema={schema}
			/>
		</>
	);
}
