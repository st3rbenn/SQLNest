import { useCallback, useEffect, useState } from "react";
import type { Side } from "./edgeRouting";
import { readJson, schemaSliceKey, writeJson } from "../storage/localStore";
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
	return schemaSliceKey("edge-anchors", schema);
}

export interface AnchorsApi {
	readonly overrides: AnchorMap;
	readonly setOverride: (
		edgeId: string,
		end: "source" | "target",
		side: Side
	) => void;
	readonly clearOverride: (edgeId: string) => void;
	/** Remplacement atomique — utilisé par l'hydratation serveur
	 * (`useCanvasSync.replaceAll.edgeAnchors`). */
	readonly replaceAll: (next: AnchorMap) => void;
}

export interface UseEdgeAnchorsOptions {
	/** Voir `useTablePositions.persistLocal` — même sémantique. */
	readonly persistLocal?: boolean;
}

/**
 * Overrides utilisateur pour les endpoints d'edges — clé edge.id, valeur
 * `{source?, target?}` (chaque bout peut ou non être forcé). Persistés
 * en localStorage quand anonyme, server-only quand loggé (via
 * `useCanvasSync`). `SchemaCanvas.displayEdges` lit ces overrides avec
 * fallback sur l'auto-routing (`bestHandles`).
 */
export function useEdgeAnchors(
	schema: SchemaModel,
	options: UseEdgeAnchorsOptions = {}
): AnchorsApi {
	const persistLocal = options.persistLocal ?? true;
	const key = schemaKey(schema);
	const [overrides, setOverrides] = useState<AnchorMap>(() => {
		if (!persistLocal) return {};
		return (readJson(key) as AnchorMap | null | undefined) ?? {};
	});

	// Persist à chaque mutation — skip complet en mode server-only.
	useEffect(() => {
		if (!persistLocal) return;
		writeJson(key, overrides);
	}, [key, overrides, persistLocal]);

	// Re-seed quand la signature change (nouvelle base).
	useEffect(() => {
		// Connecté, l'état appartient à la connexion : une table créée ou
		// supprimée ne le vide pas (le canvas n'est plus remonté, ADR-039 D5).
		if (!persistLocal) return;
		setOverrides((readJson(key) as AnchorMap | null | undefined) ?? {});
	}, [key, persistLocal]);

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

	const replaceAll = useCallback((next: AnchorMap) => {
		setOverrides(next);
	}, []);

	return { overrides, setOverride, clearOverride, replaceAll };
}
