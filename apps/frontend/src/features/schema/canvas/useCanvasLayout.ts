import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { buildLayout, type LayoutResult } from "../layout";
import type { SchemaModel } from "../schema-model";
import {
	NODE_WIDTH,
	nodeHeight,
	type TableNodeType,
	tableAriaLabel
} from "../TableNode";
import type { XY } from "../useTablePositions";
import { syncLayoutTables } from "./layoutTables";
import { makeEdge } from "./relationEdge";

/** Clé du layout en cache : `useNavigateToCanvas` le précalcule avant de
 *  naviguer, sans quoi le canvas montre un fond nu le temps du calcul. */
export function canvasLayoutQueryKey(
	connectionId: string
): readonly [string, string] {
	return ["canvas-layout", connectionId] as const;
}

export function computeCanvasLayout(
	schema: SchemaModel
): Promise<LayoutResult> {
	return buildLayout(schema, makeNode(schema), makeEdge);
}

function makeNode(schema: SchemaModel) {
	return (name: string): TableNodeType => {
		const collection = schema.collections.find((c) => c.name === name);
		if (collection === undefined) {
			throw new Error(`makeNode: collection introuvable ${name}`);
		}
		return {
			id: name,
			type: "table",
			ariaLabel: tableAriaLabel(collection),
			position: { x: 0, y: 0 },
			// Dimensions explicites → fitView cadre sans attendre la mesure DOM.
			width: NODE_WIDTH,
			height: nodeHeight(collection),
			// Le Backspace natif du moteur retirerait la table du state sans
			// persistance ni retour possible : il passe par `hideSelected`,
			// comme le « Masquer » du chip.
			deletable: false,
			data: { collection, dimmed: false, focused: false, matched: false }
		};
	};
}

export interface UseCanvasLayoutOptions {
	readonly schema: SchemaModel;
	readonly connectionId: string;
	/** Centre de la vue courante : là où se pose une table apparue. */
	readonly viewCenter: () => XY | null;
	readonly setManyPositions: (entries: Readonly<Record<string, XY>>) => void;
}

export interface UseCanvasLayoutReturn {
	/** `null` tant que le layout n'est pas calculé. */
	readonly base: LayoutResult | null;
	/** Même valeur, lisible depuis un callback stable. */
	readonly baseRef: React.RefObject<LayoutResult | null>;
}

/**
 * Layout ELK du canvas, calculé une fois par connexion et gardé en cache :
 * un retour sur le canvas le rend aussitôt, sans recalcul à froid. Il suit
 * ensuite le schéma relu (ADR-039 D5) : une table créée se place au centre
 * de la vue et y reste (position persistée comme un déplacement), une table
 * supprimée sort avec ses arêtes.
 */
export function useCanvasLayout({
	schema,
	connectionId,
	viewCenter,
	setManyPositions
}: UseCanvasLayoutOptions): UseCanvasLayoutReturn {
	const layoutQuery = useQuery({
		queryKey: canvasLayoutQueryKey(connectionId),
		queryFn: () => computeCanvasLayout(schema),
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
		refetchOnMount: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false
	});
	const base: LayoutResult | null = layoutQuery.data ?? null;
	const baseRef = useRef<LayoutResult | null>(null);
	baseRef.current = base;

	const queryClient = useQueryClient();
	useEffect(() => {
		if (base === null) return;
		const synced = syncLayoutTables(
			base,
			schema,
			makeNode(schema),
			viewCenter()
		);
		if (synced === null) return;
		setManyPositions(synced.placed);
		queryClient.setQueryData(canvasLayoutQueryKey(connectionId), synced.layout);
	}, [base, schema, viewCenter, setManyPositions, queryClient, connectionId]);

	return { base, baseRef };
}
