import { useCallback } from "react";
import type { LayoutResult } from "../layout";
import type { TableNodeType } from "../TableNode";
import {
	type UseCanvasHistoryOptions,
	type UseCanvasHistoryReturn,
	useCanvasHistory
} from "./useCanvasHistory";
import { useUndoRedoShortcuts } from "./useUndoRedoShortcuts";

export interface UseCanvasUndoOptions
	extends Omit<UseCanvasHistoryOptions, "onRestore"> {
	readonly baseRef: React.RefObject<LayoutResult | null>;
	readonly setNodes: React.Dispatch<React.SetStateAction<TableNodeType[]>>;
}

/**
 * Annuler / rétablir sur le canvas : positions, tailles, frames, tables
 * masquées. `history.push()` s'appelle après chaque geste notable (fin de
 * drag ou de resize, frame créé, retiré ou renommé, table masquée ou
 * réaffichée, auto-layout).
 *
 * Une restauration remet l'état dans ses hooks, mais le canvas tient son
 * propre state de nodes : positions et tailles du snapshot y sont
 * reportées ici, avec repli sur le layout d'origine pour un node que le
 * snapshot ne connaît pas (jamais déplacé à ce moment de l'historique).
 *
 * Cmd/Ctrl+Z et Cmd/Ctrl+Shift+Z (ou Y) : `preventDefault` bloque le
 * « rouvrir l'onglet fermé » du navigateur ; un champ de saisie garde son
 * propre annuler.
 */
export function useCanvasUndo({
	baseRef,
	setNodes,
	...historyOptions
}: UseCanvasUndoOptions): UseCanvasHistoryReturn {
	const history = useCanvasHistory({
		...historyOptions,
		onRestore: useCallback(
			(snapshot) => {
				const baseNodes = baseRef.current?.nodes;
				if (!baseNodes) return;
				const baseById = new Map(baseNodes.map((n) => [n.id, n]));
				setNodes((prev) =>
					prev.map((n) => {
						const baseNode = baseById.get(n.id);
						const pos = snapshot.positions[n.id];
						const size = snapshot.sizes[n.id];
						const w = size?.width ?? baseNode?.width;
						const h = size?.height ?? baseNode?.height;
						return {
							...n,
							position: pos ?? baseNode?.position ?? n.position,
							...(w !== undefined ? { width: w } : {}),
							...(h !== undefined ? { height: h } : {})
						};
					})
				);
			},
			[baseRef, setNodes]
		)
	});
	useUndoRedoShortcuts({ onUndo: history.undo, onRedo: history.redo });
	return history;
}
