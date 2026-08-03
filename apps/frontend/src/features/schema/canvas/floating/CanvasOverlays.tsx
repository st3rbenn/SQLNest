import { Box } from "@mantine/core";
import {
	SelectionChip,
	Spotlight,
	type SpotlightActionGroupData
} from "@sqlnest/design-system";
import { CanvasContextMenu } from "../../CanvasContextMenu";
import type { SchemaModel } from "../../schema-model";
import type { FramesApi } from "../../useFrames";
import { CanvasBreadcrumb } from "../CanvasBreadcrumb";
import { HiddenChip } from "../HiddenChip";

export interface CanvasContextMenuState {
	readonly x: number;
	readonly y: number;
	readonly tableName: string;
}

export interface CanvasOverlaysProps {
	readonly schema: SchemaModel;
	readonly schemaLabel?: string | undefined;
	readonly framesApi: FramesApi;

	/** Sélection multi-tables — le chip haut-centre expose les actions
	 * Frame / Masquer / clear. Rendu conditionnel sur `> 0`. */
	readonly selectedTables: readonly string[];
	readonly onCreateFrame: () => void;
	readonly onHideSelected: () => void;
	readonly onClearSelection: () => void;

	/** Tables masquées — chip visible dès qu'≥1 table est cachée. */
	readonly hiddenIds: ReadonlySet<string>;
	readonly onUnhideAll: () => void;

	/** Menu contextuel — position + tableName ancrés au right-click sur une
	 * table. `null` = fermé. */
	readonly menu: CanvasContextMenuState | null;
	readonly onCloseMenu: () => void;
	readonly onHide: (name: string) => void;
	readonly onFocus: (name: string) => void;
	readonly onAddToFrame: (frameKey: string) => void;
	readonly onRemoveFromFrame: () => void;

	/** Palette Cmd+K — commandes construites par `useCanvasCommands`. */
	readonly commandGroups: SpotlightActionGroupData[];
}

/**
 * Overlays flottants du canvas : breadcrumb + chips (sélection, masqués) +
 * menu contextuel + palette Cmd+K.
 *
 * Regroupés parce que ces 5 éléments partagent la caractéristique « rendu
 * conditionnel selon un state », en couche au-dessus du ReactFlow. Ils
 * n'ont pas de position fixe géographique — chacun se positionne selon sa
 * propre logique (top-center, bottom-right, curseur).
 *
 * Ajouter un nouvel overlay (ex: toast persistant, indicator de saving) =
 * 1 endroit à modifier.
 */
export function CanvasOverlays({
	schema,
	schemaLabel,
	framesApi,
	selectedTables,
	onCreateFrame,
	onHideSelected,
	onClearSelection,
	hiddenIds,
	onUnhideAll,
	menu,
	onCloseMenu,
	onHide,
	onFocus,
	onAddToFrame,
	onRemoveFromFrame,
	commandGroups
}: CanvasOverlaysProps) {
	return (
		<>
			<CanvasBreadcrumb
				engine={schema.engine as "postgres" | "mongodb"}
				schemaLabel={
					schema.engine === "postgres" ? (schemaLabel ?? "public") : undefined
				}
				tableCount={schema.collections.length}
			/>

			{selectedTables.length > 0 ? (
				<Box
					style={{
						position: "absolute",
						left: "50%",
						transform: "translateX(-50%)",
						top: 60,
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
									onCreateFrame();
									onClearSelection();
								}
							},
							{
								id: "hide",
								label: "Masquer",
								onClick: () => {
									onHideSelected();
									onClearSelection();
								}
							}
						]}
						onClear={onClearSelection}
					/>
				</Box>
			) : null}

			{hiddenIds.size > 0 ? (
				<HiddenChip count={hiddenIds.size} onUnhideAll={onUnhideAll} />
			) : null}

			{menu !== null ? (
				<CanvasContextMenu
					open
					position={{ x: menu.x, y: menu.y }}
					tableName={menu.tableName}
					frames={framesApi.frames}
					frameOfTable={framesApi.frameOfTable(menu.tableName)}
					onClose={onCloseMenu}
					onHide={onHide}
					onFocus={onFocus}
					onAddToFrame={onAddToFrame}
					onRemoveFromFrame={onRemoveFromFrame}
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
