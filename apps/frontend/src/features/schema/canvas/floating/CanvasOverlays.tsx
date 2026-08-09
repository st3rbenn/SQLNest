import { Box } from "@mantine/core";
import { SelectionChip, Spotlight } from "@sqlnest/design-system";
import { CanvasContextMenu } from "../../CanvasContextMenu";
import {
	useCanvasActionsCtx,
	useCanvasData,
	useCanvasFocusCtx,
	useCanvasUI
} from "../CanvasContext";
import { HiddenChip } from "../HiddenChip";

/**
 * Overlays flottants du canvas : breadcrumb + chips (sélection, masqués) +
 * menu contextuel + palette Cmd+K.
 *
 * Consomme les 4 contexts — 0 prop parent.
 * Ajouter un overlay (toast persistant, saving indicator) = 1 endroit.
 */
export function CanvasOverlays() {
	const { schema, schemaLabel, framesApi, hiddenIds } = useCanvasData();
	const { focusAndZoom } = useCanvasFocusCtx();
	const { menu, setMenu, selectedTables, clearSelection } = useCanvasUI();
	const {
		createFrameFromSelection,
		hideSelected,
		hideTable,
		unhideAll,
		addTableToFrame,
		removeTableFromFrame,
		commandGroups
	} = useCanvasActionsCtx();
	return (
		<>
			{selectedTables.length > 0 ? (
				<Box
					style={{
						position: "absolute",
						left: "50%",
						transform: "translateX(-50%)",
						// Aligné vertical avec le HUD top-right et le toggle
						// sidebar (centre ~49px depuis viewport top). Chip
						// height ~36 → top:30 pour center à 48.
						top: 30,
						zIndex: 6
					}}
				>
					<SelectionChip
						count={selectedTables.length}
						label="table"
						actions={[
							{
								id: "frame",
								label: "Frame",
								hint: "F",
								onClick: () => {
									createFrameFromSelection();
									clearSelection();
								}
							},
							{
								id: "hide",
								label: "Masquer",
								onClick: () => {
									hideSelected();
									clearSelection();
								}
							}
						]}
						onClear={clearSelection}
					/>
				</Box>
			) : null}

			{hiddenIds.size > 0 ? (
				<HiddenChip count={hiddenIds.size} onUnhideAll={unhideAll} />
			) : null}

			{menu !== null ? (
				<CanvasContextMenu
					open
					position={{ x: menu.x, y: menu.y }}
					tableName={menu.tableName}
					schema={schema}
					schemaLabel={schemaLabel}
					frames={framesApi.frames}
					frameOfTable={framesApi.frameOfTable(menu.tableName)}
					onClose={() => setMenu(null)}
					onHide={hideTable}
					onFocus={focusAndZoom}
					onAddToFrame={(frameKey) => addTableToFrame(frameKey, menu.tableName)}
					onRemoveFromFrame={() => removeTableFromFrame(menu.tableName)}
				/>
			) : null}

			<Spotlight
				actions={commandGroups}
				searchProps={{
					placeholder: "Chercher une table, une action…"
				}}
				nothingFound="Aucun résultat."
				highlightQuery
				shortcut={null}
			/>
		</>
	);
}
