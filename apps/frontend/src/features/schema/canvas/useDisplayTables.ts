import { useMemo, useRef, useState } from "react";
import type { TableNodeType } from "../TableNode";
import {
	createTableDecorator,
	type TableResizeHandler
} from "./tableDecorator";

export interface UseDisplayTablesOptions {
	readonly nodes: readonly TableNodeType[];
	readonly hiddenIds: ReadonlySet<string>;
	/** Voisinage de la table focalisée ; `null` : rien n'est estompé. */
	readonly neighbors: ReadonlySet<string> | null;
	readonly focusId: string | null;
	/** Table survolée dans l'arbre du drawer. */
	readonly hoveredTableName: string | null;
	readonly onResize: TableResizeHandler;
}

/**
 * Tables à afficher : les masquées en sortent, les autres reçoivent leurs
 * drapeaux (estompée, focalisée, survolée) et leur fin de resize. Une table
 * dont rien ne change garde le même objet (`createTableDecorator`).
 */
export function useDisplayTables({
	nodes,
	hiddenIds,
	neighbors,
	focusId,
	hoveredTableName,
	onResize
}: UseDisplayTablesOptions): TableNodeType[] {
	const onResizeRef = useRef(onResize);
	onResizeRef.current = onResize;
	const [decorate] = useState(() =>
		createTableDecorator((id, size) => onResizeRef.current(id, size))
	);
	return useMemo(
		() =>
			nodes
				.filter((n) => !hiddenIds.has(n.id))
				.map((n) =>
					decorate(n, {
						dimmed: neighbors !== null && !neighbors.has(n.id),
						focused: n.id === focusId,
						hoverHighlight: n.id === hoveredTableName
					})
				),
		[nodes, neighbors, focusId, hiddenIds, decorate, hoveredTableName]
	);
}
