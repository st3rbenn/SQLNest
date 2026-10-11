import { showNotification } from "@sqlnest/design-system";
import { useCallback, useState } from "react";
import type { LayoutResult } from "../layout";
import type { TableNodeType } from "../TableNode";
import type { FramesApi } from "../useFrames";
import type { PositionsApi, XY } from "../useTablePositions";
import { boundsOfTables, FRAME_PAD } from "./computeFrameNodes";
import { frameRectsFromContent, tableParents, tableRect } from "./frameTree";

export interface UseCanvasActionsOptions {
	readonly base: LayoutResult | null;
	readonly nodes: readonly TableNodeType[];
	readonly setNodes: React.Dispatch<React.SetStateAction<TableNodeType[]>>;
	readonly tablePositions: PositionsApi;
	readonly framesApi: FramesApi;
	readonly hiddenIds: ReadonlySet<string>;
	readonly setHiddenIds: React.Dispatch<
		React.SetStateAction<ReadonlySet<string>>
	>;
	readonly focusId: string | null;
	readonly setFocusId: (id: string | null) => void;
	readonly selectedTables: readonly string[];
	readonly applyOverview: () => void;
	readonly history: { readonly push: () => void };
}

export interface UseCanvasActionsReturn {
	/** State + setter du modal de confirmation Auto-layout. Reset à la
	 * fermeture (relayoutAll called or user cancelled). */
	readonly layoutConfirmOpen: boolean;
	readonly setLayoutConfirmOpen: React.Dispatch<React.SetStateAction<boolean>>;
	/** Force les positions ELK, persiste dans tablePositions, recompute les
	 * rects des frames depuis les nouvelles positions de leurs membres, puis
	 * applyOverview + history.push. Destructif — appelé après confirmation
	 * du modal. */
	readonly relayoutAll: () => void;
	/** Cache une table (add à hiddenIds), clear son focus si active, toast
	 * d'info + history.push. */
	readonly hideTable: (name: string) => void;
	/** Retire toutes les tables cachées (reset hiddenIds → Set vide) +
	 * history.push. Déclenché depuis `HiddenChip`. */
	readonly unhideAll: () => void;
	/** Cache toutes les tables actuellement sélectionnées (Shift+click ou
	 * lasso) — no-op si sélection vide. Consommé par le SelectionChip. */
	readonly hideSelected: () => void;
	/** Crée un frame englobant les tables sélectionnées — rect = bounds des
	 * cartes + FRAME_PAD. No-op si sélection vide. Consommé par le
	 * SelectionChip ET le raccourci F (via SchemaCanvas.useHotkeys). */
	readonly createFrameFromSelection: () => void;
	/** Ajoute une table à un frame (par sa clé) + history.push. Consommé
	 * par le menu contextuel. */
	readonly addTableToFrame: (frameKey: string, tableName: string) => void;
	/** Retire une table de son frame courant + history.push. Consommé par
	 * le menu contextuel. */
	readonly removeTableFromFrame: (tableName: string) => void;
}

/**
 * Regroupe les actions destructives / massives du canvas :
 *   - Auto-layout : `relayoutAll` + `layoutConfirmOpen` state pour la
 *     confirmation modale (geste massif, écrase la disposition user).
 *   - Hide/unhide : `hideTable` (one), `hideSelected` (multi), `unhideAll`.
 *   - Frame creation : `createFrameFromSelection` — geste F ou click sur
 *     SelectionChip.
 *
 * Toutes appellent `history.push()` — mutations captured par le stack
 * undo/redo. Le hook n'appelle jamais lui-même setNodes DIRECTEMENT pour
 * les mutations hide (on modifie hiddenIds, `displayTableNodes` filtre en
 * downstream), sauf `relayoutAll` qui doit repush les positions ELK dans
 * les nodes (sinon ils gardent les positions user alors que
 * tablePositions a été replaceAll).
 */
export function useCanvasActions(
	opts: UseCanvasActionsOptions
): UseCanvasActionsReturn {
	const {
		base,
		nodes,
		setNodes,
		tablePositions,
		framesApi,
		hiddenIds: _hiddenIds,
		setHiddenIds,
		focusId,
		setFocusId,
		selectedTables,
		applyOverview,
		history
	} = opts;

	const [layoutConfirmOpen, setLayoutConfirmOpen] = useState(false);

	const relayoutAll = useCallback(() => {
		if (base === null) return;
		setNodes(base.nodes);
		const entries: Record<string, XY> = {};
		for (const n of base.nodes) entries[n.id] = n.position;
		tablePositions.setManyPositions(entries);
		// De bas en haut : un frame englobe ses tables et ses sous-frames.
		framesApi.replaceAll(
			frameRectsFromContent(framesApi.frames, base.nodes, FRAME_PAD)
		);
		applyOverview();
		history.push();
	}, [base, setNodes, tablePositions, framesApi, applyOverview, history]);

	const hideTable = useCallback(
		(name: string) => {
			setHiddenIds((prev) => {
				const next = new Set(prev);
				next.add(name);
				return next;
			});
			if (focusId === name) setFocusId(null);
			showNotification({
				title: "Table masquée",
				message: `${name} — restaure via « Tout réafficher ».`,
				color: "blue",
				autoClose: 2000
			});
			history.push();
		},
		[setHiddenIds, focusId, setFocusId, history]
	);

	const unhideAll = useCallback(() => {
		setHiddenIds(new Set());
		history.push();
	}, [setHiddenIds, history]);

	// Le nouveau frame se range dans le frame commun aux tables
	// sélectionnées (s'il y en a un), agrandi au besoin pour le contenir.
	const createFrameFromSelection = useCallback(() => {
		if (selectedTables.length === 0) return;
		const selectedNodes = nodes.filter((n) => selectedTables.includes(n.id));
		const rect = boundsOfTables(selectedNodes, FRAME_PAD);
		const parents = tableParents(framesApi.frames);
		const common = new Set(selectedTables.map((t) => parents.get(t)));
		const parentKey = common.size === 1 ? [...common][0] : undefined;
		const frame = framesApi.createFrame(selectedTables, {
			...(rect ? { rect } : {}),
			...(parentKey ? { parentKey } : {})
		});
		showNotification({
			title: `Frame « ${frame.label} » créé`,
			message: `${selectedTables.length} table${selectedTables.length > 1 ? "s" : ""} groupée${selectedTables.length > 1 ? "s" : ""}`,
			color: "green",
			autoClose: 2500
		});
		history.push();
	}, [selectedTables, nodes, framesApi, history]);

	const hideSelected = useCallback(() => {
		if (selectedTables.length === 0) return;
		setHiddenIds((prev) => {
			const next = new Set(prev);
			for (const t of selectedTables) next.add(t);
			return next;
		});
		history.push();
	}, [selectedTables, setHiddenIds, history]);

	// Une table ajoutée hors des bords du frame l'agrandit (et ses
	// ancêtres) plutôt que d'être rognée.
	const addTableToFrame = useCallback(
		(frameKey: string, tableName: string) => {
			const table = nodes.find((n) => n.id === tableName);
			framesApi.addTableToFrame(
				frameKey,
				tableName,
				table ? tableRect(table) : undefined
			);
			history.push();
		},
		[framesApi, nodes, history]
	);

	// La table remonte d'un niveau : dans le frame parent, sinon à la racine.
	const removeTableFromFrame = useCallback(
		(tableName: string) => {
			const parentKey = framesApi.frameOfTable(tableName)?.parentKey;
			if (parentKey) framesApi.addTableToFrame(parentKey, tableName);
			else framesApi.removeTableFromFrame(tableName);
			history.push();
		},
		[framesApi, history]
	);

	return {
		layoutConfirmOpen,
		setLayoutConfirmOpen,
		relayoutAll,
		hideTable,
		unhideAll,
		hideSelected,
		createFrameFromSelection,
		addTableToFrame,
		removeTableFromFrame
	};
}
