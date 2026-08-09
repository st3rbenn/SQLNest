import { ActionIcon } from "@mantine/core";
import {
	IconLayoutSidebarLeftCollapse,
	IconLayoutSidebarLeftExpand
} from "@tabler/icons-react";
import {
	useCanvasActionsCtx,
	useCanvasData,
	useCanvasFocusCtx,
	useCanvasUI
} from "../CanvasContext";
import { DrawerPane } from "../DrawerPane";
import { CanvasFilesHUD } from "./CanvasFilesHUD";

/**
 * Colonne gauche du canvas : toggle + `DrawerPane` docké (ouvert) ou
 * `CanvasFilesHUD` flottant top-left (fermé).
 *
 * Consomme les 4 contexts — 0 prop parent.
 */
export function CanvasLeftPanel() {
	const { schema, dbName, framesApi } = useCanvasData();
	const {
		focusId,
		focusFrameKey,
		focusedFrame,
		clearFocus,
		setFocusFrameKey,
		focusAndZoom
	} = useCanvasFocusCtx();
	const {
		leftDrawerVisible,
		setLeftDrawerVisible,
		leftDrawerWidth,
		drawerHandleProps,
		search,
		setSearch
	} = useCanvasUI();
	const { handleFrameRename, handleFrameDelete } = useCanvasActionsCtx();
	return (
		<>
			<ActionIcon
				variant="subtle"
				size="lg"
				radius="md"
				className="sqlnest-menu-item"
				onClick={() => setLeftDrawerVisible((x) => !x)}
				aria-label={
					leftDrawerVisible
						? "Masquer le drawer gauche"
						: "Afficher le drawer gauche"
				}
				style={{
					position: "absolute",
					top: 12,
					left: leftDrawerVisible ? leftDrawerWidth - 44 : 8,
					zIndex: 5,
					background: "transparent",
					color: "var(--sqlnest-text-secondary)",
					border: "none"
				}}
			>
				{leftDrawerVisible ? (
					<IconLayoutSidebarLeftCollapse size={16} />
				) : (
					<IconLayoutSidebarLeftExpand size={16} />
				)}
			</ActionIcon>

			{leftDrawerVisible ? (
				<DrawerPane
					schema={schema}
					dbName={dbName}
					width={leftDrawerWidth}
					handleProps={drawerHandleProps}
					search={search}
					onSearchChange={setSearch}
					framesApi={framesApi}
					focusId={focusId}
					focusFrameKey={focusFrameKey}
					focusedFrame={focusedFrame}
					onClearFocus={clearFocus}
					onClearFocusFrame={() => setFocusFrameKey(null)}
					onFocusTable={focusAndZoom}
					onFrameRename={handleFrameRename}
					onFrameDelete={handleFrameDelete}
				/>
			) : (
				<CanvasFilesHUD dbName={dbName} />
			)}
		</>
	);
}
