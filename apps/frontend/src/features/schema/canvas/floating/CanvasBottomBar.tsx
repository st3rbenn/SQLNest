import { CanvasToolbar } from "../../CanvasToolbar";
import { AutoLayoutModal } from "../AutoLayoutModal";
import { useCanvasActionsCtx, useCanvasUI } from "../CanvasContext";

/**
 * Barre du bas : toolbar canvas (Select/Frame/Console + Auto-layout
 * button) + modal de confirmation Auto-layout.
 */
export function CanvasBottomBar() {
	const {
		activeTool,
		setActiveTool,
		layoutConfirmOpen,
		setLayoutConfirmOpen,
		setHistoryDrawerOpen
	} = useCanvasUI();
	const { relayoutAll, createConsole } = useCanvasActionsCtx();
	return (
		<>
			<CanvasToolbar
				onAutoLayout={() => setLayoutConfirmOpen(true)}
				onCreateConsole={createConsole}
				onOpenHistory={() => setHistoryDrawerOpen(true)}
				bottomOffset={0}
				activeTool={activeTool}
				onSelectTool={setActiveTool}
			/>
			<AutoLayoutModal
				opened={layoutConfirmOpen}
				onClose={() => setLayoutConfirmOpen(false)}
				onConfirm={relayoutAll}
			/>
		</>
	);
}
