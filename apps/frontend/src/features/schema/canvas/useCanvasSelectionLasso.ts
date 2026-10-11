import { useNestCanvas, useStoreApi } from "@sqlnest/canvas";
import { showNotification } from "@sqlnest/design-system";
import { useCallback, useRef } from "react";
import type { CanvasTool } from "../CanvasToolbar";
import type { FramesApi } from "../useFrames";
import { FRAME_PAD } from "./computeFrameNodes";
import { deepestFrameContaining, growRectToContain } from "./frameTree";

const MIN_FRAME_LASSO = 40;

export interface UseCanvasSelectionLassoOptions {
	readonly activeTool: CanvasTool;
	readonly setActiveTool: React.Dispatch<React.SetStateAction<CanvasTool>>;
	readonly framesApi: FramesApi;
	readonly history: { readonly push: () => void };
	readonly clearSelection: () => void;
}

export interface UseCanvasSelectionLassoReturn {
	/** Handler `<NestCanvas onSelectionStart>` — snapshot du point de départ
	 * du lasso quand `activeTool === "frame"`. No-op sinon. */
	readonly handleSelectionStart: (event: React.MouseEvent) => void;
	/** Handler `<NestCanvas onSelectionEnd>` — crée un frame dont le rect
	 * correspond au lasso (pas au bounds des tables) quand `activeTool ===
	 * "frame"`. Sort ensuite du mode frame (retour à `select`). */
	readonly handleSelectionEnd: (event: React.MouseEvent) => void;
}

/**
 * Mode « frame » de la toolbar canvas — lasso qui crée un frame :
 *   - Le RECT du frame = le lasso lui-même (pas le bounds des tables
 *     englobées). Ça préserve la taille dessinée par l'utilisateur ET
 *     permet de créer un frame VIDE (utile comme conteneur à remplir plus
 *     tard).
 *   - Les tables touchées par le lasso entrent dans le frame ; celles qui
 *     dépassent l'agrandissent, sinon il les rognerait. Elles sont lues via
 *     `getNodes()` (source directe du store) car notre state
 *     `selectedTables` n'est pas encore flushé au moment du release.
 *   - Le lasso part du point d'appui : `onSelectionStart` ne survient qu'au
 *     premier mouvement, déjà décalé.
 *   - Lasso < `MIN_FRAME_LASSO` (40 px) → no-op (évite les frames dégénérés
 *     d'un simple clic mal calibré).
 *   - Après création (ou échec silencieux), retour automatique à
 *     `activeTool = "select"` — le mode est one-shot.
 */
export function useCanvasSelectionLasso(
	opts: UseCanvasSelectionLassoOptions
): UseCanvasSelectionLassoReturn {
	const { activeTool, setActiveTool, framesApi, history, clearSelection } =
		opts;
	const { getNodes, getInternalNode, screenToFlowPosition } = useNestCanvas();
	const store = useStoreApi();
	const frameLassoStartRef = useRef<{ x: number; y: number } | null>(null);

	const handleSelectionStart = useCallback(
		(event: React.MouseEvent) => {
			if (activeTool !== "frame") return;
			const lasso = store.getState().userSelectionRect;
			frameLassoStartRef.current = lasso
				? { x: lasso.startX, y: lasso.startY }
				: screenToFlowPosition({ x: event.clientX, y: event.clientY });
		},
		[activeTool, store, screenToFlowPosition]
	);

	const handleSelectionEnd = useCallback(
		(event: React.MouseEvent) => {
			if (activeTool !== "frame") return;
			const start = frameLassoStartRef.current;
			frameLassoStartRef.current = null;
			if (!start) {
				setActiveTool("select");
				return;
			}
			const end = screenToFlowPosition({
				x: event.clientX,
				y: event.clientY
			});
			const width = Math.abs(end.x - start.x);
			const height = Math.abs(end.y - start.y);
			if (width < MIN_FRAME_LASSO || height < MIN_FRAME_LASSO) {
				setActiveTool("select");
				return;
			}
			const drawn = {
				x: Math.min(start.x, end.x),
				y: Math.min(start.y, end.y),
				width,
				height
			};
			const touched = getNodes().filter(
				(n) => n.selected && n.type === "table"
			);
			const selectedTableIds = touched.map((n) => n.id);
			const rect = growRectToContain(
				drawn,
				touched.flatMap((n) => {
					const node = getInternalNode(n.id);
					if (node === undefined) return [];
					return [
						{
							...node.internals.positionAbsolute,
							width: node.measured.width ?? 0,
							height: node.measured.height ?? 0
						}
					];
				}),
				FRAME_PAD
			);
			// Dessiné dans un frame : le nouveau frame s'y range.
			const parent = deepestFrameContaining(framesApi.frames, drawn);
			const frame = framesApi.createFrame(selectedTableIds, {
				rect,
				...(parent ? { parentKey: parent.key } : {})
			});
			showNotification({
				title: `Frame « ${frame.label} » créé`,
				message:
					selectedTableIds.length > 0
						? `${selectedTableIds.length} table${selectedTableIds.length > 1 ? "s" : ""} groupée${selectedTableIds.length > 1 ? "s" : ""}`
						: "Frame vide — glisse des tables dedans",
				color: "green",
				autoClose: 2500
			});
			history.push();
			if (selectedTableIds.length > 0) clearSelection();
			setActiveTool("select");
		},
		[
			activeTool,
			screenToFlowPosition,
			getNodes,
			getInternalNode,
			framesApi,
			history,
			clearSelection,
			setActiveTool
		]
	);

	return { handleSelectionStart, handleSelectionEnd };
}
