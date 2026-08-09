import {
	useCanvasActionsCtx,
	useCanvasData,
	useCanvasFocusCtx,
	useCanvasUI
} from "../CanvasContext";
import { DrawerPane } from "../DrawerPane";
import { CanvasFilesHUD } from "./CanvasFilesHUD";

/**
 * Colonne gauche du canvas : `DrawerPane` docké (ouvert) ou
 * `CanvasFilesHUD` flottant top-left (fermé). Le toggle du drawer est
 * intégré au HUD (à droite du nom de la DB) dans les 2 états.
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
		setSearch,
		setHoveredTableName
	} = useCanvasUI();
	const { handleFrameRename, handleFrameDelete } = useCanvasActionsCtx();
	const toggleDrawer = () => setLeftDrawerVisible((x) => !x);
	if (leftDrawerVisible) {
		return (
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
				onHoverTable={setHoveredTableName}
				onFrameRename={handleFrameRename}
				onFrameDelete={handleFrameDelete}
				topBar={
					<CanvasFilesHUD
						dbName={dbName}
						drawerVisible={true}
						onToggleDrawer={toggleDrawer}
						variant="embedded"
					/>
				}
			/>
		);
	}
	return (
		<CanvasFilesHUD
			dbName={dbName}
			drawerVisible={false}
			onToggleDrawer={toggleDrawer}
			variant="floating"
		/>
	);
}
