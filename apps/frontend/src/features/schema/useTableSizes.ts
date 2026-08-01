import { useCallback, useEffect, useRef, useState } from "react";
import type { SchemaModel } from "./schema-model";

export interface TableSize {
	readonly width?: number;
	readonly height?: number;
}

export type SizesMap = Readonly<Record<string, TableSize>>;

/**
 * Signature stable d'un schéma pour la clé localStorage — miroir de
 * `useTablePositions` / `useFrames`. Sizes clippées à l'empreinte : nouvelle
 * base → pas de collision, on repart avec les dimensions par défaut.
 */
function schemaKey(schema: SchemaModel): string {
	const names = schema.collections
		.map((c) => c.name)
		.slice()
		.sort()
		.join(",");
	return `sqlnest:sizes:${schema.engine}:${names}`;
}

export interface SizesApi {
	readonly sizes: SizesMap;
	readonly setSize: (name: string, size: TableSize) => void;
	readonly replaceAll: (sizes: SizesMap) => void;
}

/**
 * Dimensions overridées des tables (drag du NodeResizer) persistées en
 * localStorage. On stocke width ET height dans la même entrée : la height
 * est aussi user-controllable depuis que NodeResizer expose les 4 côtés (le
 * user peut vouloir aplatir une table ou l'agrandir pour aligner visuellement
 * plusieurs cartes).
 */
function loadSizes(key: string): SizesMap {
	if (typeof window === "undefined") return {};
	try {
		const raw = window.localStorage.getItem(key);
		if (raw !== null) return JSON.parse(raw) as SizesMap;
	} catch {
		/* storage indispo / JSON corrompu */
	}
	return {};
}

export function useTableSizes(schema: SchemaModel): SizesApi {
	const key = schemaKey(schema);
	const [sizes, setSizes] = useState<SizesMap>(() => loadSizes(key));

	// Track quel `key` est actuellement représenté par `sizes` en state.
	// Sert à distinguer un vrai mutate (persist OK) d'un pending re-seed après
	// changement de schéma (persist SKIP, sinon on corrompt le nouveau key).
	const loadedKey = useRef(key);

	// Re-seed quand la signature change (nouvelle base).
	useEffect(() => {
		if (loadedKey.current === key) return;
		const loaded = loadSizes(key);
		loadedKey.current = key;
		setSizes(loaded);
	}, [key]);

	// Persist — seulement si le key en état matche le key courant (voir
	// commentaire dans `useTablePositions` pour l'analyse détaillée du bug).
	useEffect(() => {
		if (typeof window === "undefined") return;
		if (loadedKey.current !== key) return;
		try {
			window.localStorage.setItem(key, JSON.stringify(sizes));
		} catch {
			/* quota / private mode */
		}
	}, [key, sizes]);

	const setSize = useCallback((name: string, size: TableSize) => {
		setSizes((prev) => ({ ...prev, [name]: size }));
	}, []);

	// Remplacement atomique (pas de merge). Utilisé par l'undo/redo pour
	// restaurer un snapshot d'historique intégral — l'effet de persist qui
	// dépend de [key, sizes] ré-écrit le storage au tick suivant.
	const replaceAll = useCallback((next: SizesMap) => {
		setSizes(next);
	}, []);

	return { sizes, setSize, replaceAll };
}
