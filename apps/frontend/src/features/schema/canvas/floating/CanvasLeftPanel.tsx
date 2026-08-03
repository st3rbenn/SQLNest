import { ActionIcon } from "@mantine/core";
import {
	IconLayoutSidebarLeftCollapse,
	IconLayoutSidebarLeftExpand
} from "@tabler/icons-react";
import type { Frame } from "../../frames";
import type { SchemaModel } from "../../schema-model";
import type { FramesApi } from "../../useFrames";
import { DrawerPane } from "../DrawerPane";

interface ResizableDrawerHandleProps {
	readonly onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
	readonly onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
	readonly onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
	readonly onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void;
}

export interface CanvasLeftPanelProps {
	readonly schema: SchemaModel;
	/** Visibilité du drawer (`false` = seul le toggle button reste, coin
	 * canvas gauche). */
	readonly visible: boolean;
	readonly onToggleVisible: () => void;
	/** Largeur courante du drawer — vient de `useResizableDrawer`. Aussi
	 * utilisée pour positionner le toggle button (bord du drawer). */
	readonly width: number;
	readonly handleProps: ResizableDrawerHandleProps;
	readonly search: string;
	readonly onSearchChange: (v: string) => void;
	readonly framesApi: FramesApi;
	readonly focusId: string | null;
	readonly focusFrameKey: string | null;
	readonly focusedFrame: Frame | undefined;
	readonly onClearFocus: () => void;
	readonly onClearFocusFrame: () => void;
	readonly onFocusTable: (id: string) => void;
	readonly onFrameRename: (key: string, label: string) => void;
	readonly onFrameDelete: (key: string) => void;
}

/**
 * Colonne gauche du canvas : toggle button flottant + `DrawerPane` docké.
 *
 * Le toggle button reste toujours visible (basculé sur le bord du drawer
 * quand ouvert, au coin canvas quand masqué). Le DrawerPane est rendu
 * conditionnellement selon `visible`.
 *
 * Ajouter un nouvel élément dans la colonne gauche (ex: 2e drawer, tabs
 * verticaux, bouton favoris) = 1 endroit à modifier.
 */
export function CanvasLeftPanel({
	schema,
	visible,
	onToggleVisible,
	width,
	handleProps,
	search,
	onSearchChange,
	framesApi,
	focusId,
	focusFrameKey,
	focusedFrame,
	onClearFocus,
	onClearFocusFrame,
	onFocusTable,
	onFrameRename,
	onFrameDelete
}: CanvasLeftPanelProps) {
	return (
		<>
			<ActionIcon
				variant="filled"
				size="lg"
				radius="md"
				onClick={onToggleVisible}
				aria-label={
					visible ? "Masquer le drawer gauche" : "Afficher le drawer gauche"
				}
				style={{
					position: "absolute",
					top: 12,
					left: visible ? width - 18 : 8,
					zIndex: 5,
					background: "var(--sqlnest-surface)",
					color: "var(--sqlnest-text-secondary)",
					border: "1px solid var(--sqlnest-border)",
					boxShadow: "0 2px 6px rgba(0,0,0,0.32)"
				}}
			>
				{visible ? (
					<IconLayoutSidebarLeftCollapse size={16} />
				) : (
					<IconLayoutSidebarLeftExpand size={16} />
				)}
			</ActionIcon>

			{visible ? (
				<DrawerPane
					schema={schema}
					width={width}
					handleProps={handleProps}
					search={search}
					onSearchChange={onSearchChange}
					framesApi={framesApi}
					focusId={focusId}
					focusFrameKey={focusFrameKey}
					focusedFrame={focusedFrame}
					onClearFocus={onClearFocus}
					onClearFocusFrame={onClearFocusFrame}
					onFocusTable={onFocusTable}
					onFrameRename={onFrameRename}
					onFrameDelete={onFrameDelete}
				/>
			) : null}
		</>
	);
}
