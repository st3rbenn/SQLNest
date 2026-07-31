import { useCallback, useEffect, useState } from "react";
import type { Side } from "./edgeRouting";
import type { SchemaModel } from "./schema-model";

export interface EdgeAnchor {
	readonly source?: Side;
	readonly target?: Side;
}

export type AnchorMap = Readonly<Record<string, EdgeAnchor>>;

/**
 * Signature stable d'un schéma pour la clé localStorage — miroir de celle
 * de `useFrames` et `useTablePositions`. Anchors clippés à cette empreinte :
 * nouvelle base (structure différente) → pas de collision, on repart à zéro.
 */
function schemaKey(schema: SchemaModel): string {
	const names = schema.collections
		.map((c) => c.name)
		.slice()
		.sort()
		.join(",");
	return `sqlnest:edge-anchors:${schema.engine}:${names}`;
}

interface AnchorsApi {
	readonly overrides: AnchorMap;
	readonly setOverride: (
		edgeId: string,
		end: "source" | "target",
		side: Side
	) => void;
	readonly clearOverride: (edgeId: string) => void;
}

/**
 * Overrides utilisateur pour les endpoints d'edges — clé edge.id, valeur
 * `{source?, target?}` (chaque bout peut ou non être forcé). Persistés
 * en localStorage. `SchemaCanvas.displayEdges` lit ces overrides avec
 * fallback sur l'auto-routing (`bestHandles`).
 */
export function useEdgeAnchors(schema: SchemaModel): AnchorsApi {
	const [overrides, setOverrides] = useState<AnchorMap>(() => {
		if (typeof window === "undefined") return {};
		try {
			const raw = window.localStorage.getItem(schemaKey(schema));
			if (raw !== null) return JSON.parse(raw) as AnchorMap;
		} catch {
			/* storage indispo / JSON corrompu */
		}
		return {};
	});

	// Persist à chaque mutation.
	useEffect(() => {
		if (typeof window === "undefined") return;
		try {
			window.localStorage.setItem(schemaKey(schema), JSON.stringify(overrides));
		} catch {
			/* quota / private mode */
		}
	}, [overrides, schema]);

	// Re-seed quand la signature change (nouvelle base).
	const key = schemaKey(schema);
	useEffect(() => {
		if (typeof window === "undefined") return;
		const raw = window.localStorage.getItem(key);
		if (raw !== null) {
			try {
				setOverrides(JSON.parse(raw) as AnchorMap);
				return;
			} catch {
				/* fallthrough */
			}
		}
		setOverrides({});
	}, [key]);

	const setOverride = useCallback(
		(edgeId: string, end: "source" | "target", side: Side) => {
			setOverrides((prev) => ({
				...prev,
				[edgeId]: { ...(prev[edgeId] ?? {}), [end]: side }
			}));
		},
		[]
	);

	const clearOverride = useCallback((edgeId: string) => {
		setOverrides((prev) => {
			if (!(edgeId in prev)) return prev;
			const next = { ...prev };
			delete next[edgeId];
			return next;
		});
	}, []);

	return { overrides, setOverride, clearOverride };
}
