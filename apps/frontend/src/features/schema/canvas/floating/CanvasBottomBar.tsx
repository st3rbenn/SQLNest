import { useMemo } from "react";
import { CanvasToolbar } from "../../CanvasToolbar";
import { canApply } from "../../editor/editMode";
import { shouldOfferInference } from "../../relation-inference/candidates";
import { AutoLayoutModal } from "../AutoLayoutModal";
import {
	useCanvasActionsCtx,
	useCanvasData,
	useCanvasUI
} from "../CanvasContext";

/**
 * Barre du bas : toolbar canvas (Select/Frame/Console + Auto-layout
 * button) + modal de confirmation Auto-layout.
 */
export function CanvasBottomBar() {
	const { schema, editMode } = useCanvasData();
	const {
		setGesture,
		activeTool,
		setActiveTool,
		layoutConfirmOpen,
		setLayoutConfirmOpen,
		inferencePanelOpen,
		setInferencePanelOpen
	} = useCanvasUI();
	const { relayoutAll, createConsole } = useCanvasActionsCtx();
	// Le bouton d'inférence n'apparaît que sur une base sans relation où des
	// candidats existent — sinon il n'y a rien à inférer.
	const canInfer = useMemo(() => shouldOfferInference(schema), [schema]);
	return (
		<>
			<CanvasToolbar
				onAutoLayout={() => setLayoutConfirmOpen(true)}
				onCreateConsole={createConsole}
				{...(canApply(editMode)
					? { onCreateTable: () => setGesture({ kind: "create-table" }) }
					: {})}
				bottomOffset={0}
				activeTool={activeTool}
				onSelectTool={setActiveTool}
				{...(canInfer
					? { onToggleInference: () => setInferencePanelOpen((v) => !v) }
					: {})}
				inferenceActive={inferencePanelOpen}
			/>
			<AutoLayoutModal
				opened={layoutConfirmOpen}
				onClose={() => setLayoutConfirmOpen(false)}
				onConfirm={relayoutAll}
			/>
		</>
	);
}
