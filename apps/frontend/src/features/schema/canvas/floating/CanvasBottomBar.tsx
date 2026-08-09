import { CanvasToolbar } from "../../CanvasToolbar";
import { AutoLayoutModal } from "../AutoLayoutModal";
import { useCanvasActionsCtx, useCanvasUI } from "../CanvasContext";

/**
 * Barre du bas : toolbar canvas (Select/Frame + Auto-layout button) +
 * modal de confirmation Auto-layout.
 *
 * La console SNQL est retirée du canvas — un nouveau design d'intégration
 * arrive (issue tracked hors canvas). Le composant `CanvasConsole` reste
 * dans `features/schema/CanvasConsole.tsx` pour être ré-utilisé quand le
 * nouveau flow sera prêt.
 */
export function CanvasBottomBar() {
	const { activeTool, setActiveTool, layoutConfirmOpen, setLayoutConfirmOpen } =
		useCanvasUI();
	const { relayoutAll } = useCanvasActionsCtx();
	return (
		<>
			<CanvasToolbar
				onAutoLayout={() => setLayoutConfirmOpen(true)}
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
