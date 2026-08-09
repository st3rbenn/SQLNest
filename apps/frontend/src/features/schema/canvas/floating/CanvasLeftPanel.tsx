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

/**
 * Colonne gauche du canvas : toggle button flottant + `DrawerPane` docké.
 *
 * Consomme les 4 contexts — 0 prop parent.
 * Ajouter un contrôle gauche (2e drawer, tabs verticaux) = 1 endroit.
 */
export function CanvasLeftPanel() {
	const { schema, framesApi } = useCanvasData();
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
				variant="filled"
				size="lg"
				radius="md"
				onClick={() => setLeftDrawerVisible((x) => !x)}
				aria-label={
					leftDrawerVisible
						? "Masquer le drawer gauche"
						: "Afficher le drawer gauche"
				}
				style={{
					// Aligné vertical avec le HUD top-right et le SelectionChip
					// (centre ~49px depuis le viewport top — HUD height 44 +
					// Panel offset). Height du toggle btn = 34, donc top:32.
					position: "absolute",
					top: 32,
					left: leftDrawerVisible ? leftDrawerWidth - 18 : 8,
					zIndex: 5,
					background: "var(--sqlnest-surface)",
					color: "var(--sqlnest-text-secondary)",
					border: "1px solid var(--sqlnest-border)",
					boxShadow: "var(--sqlnest-shadow-floating)"
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
			) : null}
		</>
	);
}
