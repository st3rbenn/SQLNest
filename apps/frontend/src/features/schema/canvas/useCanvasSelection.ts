import { type Node, useOnSelectionChange } from "@xyflow/react";
import { useCallback, useRef, useState } from "react";

export interface UseCanvasSelectionOptions<N extends Node> {
	/** Setter des nodes RF — utilisé par `clearSelection` pour reset le flag. */
	setNodes: React.Dispatch<React.SetStateAction<N[]>>;
	/**
	 * Appelé quand la sélection dépasse 1 élément — le parent en profite pour
	 * clear un éventuel focus (sinon les styles `focused` (ring bleu foncé) et
	 * `selected` (contour clair) coexistent sur des tables différentes → mix
	 * visuellement confus).
	 */
	onMultiSelect: () => void;
}

export interface UseCanvasSelectionReturn {
	selectedTables: readonly string[];
	clearSelection: () => void;
}

/**
 * Sélection multi-tables tenue à jour par React Flow. Filtre les frame-nodes
 * (non sélectionnables, mais robuste face à un futur changement). Le callback
 * `onMultiSelect` est stocké en ref → l'inscription à `useOnSelectionChange`
 * reste stable même si le parent passe une closure recréée à chaque render.
 */
export function useCanvasSelection<N extends Node>({
	setNodes,
	onMultiSelect
}: UseCanvasSelectionOptions<N>): UseCanvasSelectionReturn {
	const [selectedTables, setSelectedTables] = useState<readonly string[]>([]);
	const onMultiSelectRef = useRef(onMultiSelect);
	onMultiSelectRef.current = onMultiSelect;

	useOnSelectionChange({
		onChange: useCallback(({ nodes: sel }) => {
			const ids = sel
				.filter((n) => (n as { type?: string }).type !== "frame")
				.map((n) => n.id);
			setSelectedTables(ids);
			if (ids.length >= 2) onMultiSelectRef.current();
		}, [])
	});

	const clearSelection = useCallback(() => {
		// Reset du flag `selected` sur tous les nodes — RF ré-émet un
		// `onSelectionChange` à vide et la sélection multi disparaît.
		setNodes((ns) => ns.map((n) => ({ ...n, selected: false })));
	}, [setNodes]);

	return { selectedTables, clearSelection };
}
