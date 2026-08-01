import { useCallback, useEffect, useState } from "react";
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

interface SizesApi {
	readonly sizes: SizesMap;
	readonly setSize: (name: string, size: TableSize) => void;
}

/**
 * Dimensions overridées des tables (drag du NodeResizer) persistées en
 * localStorage. On stocke width ET height dans la même entrée : la height
 * est aussi user-controllable depuis que NodeResizer expose les 4 côtés (le
 * user peut vouloir aplatir une table ou l'agrandir pour aligner visuellement
 * plusieurs cartes).
 */
export function useTableSizes(schema: SchemaModel): SizesApi {
	const [sizes, setSizes] = useState<SizesMap>(() => {
		if (typeof window === "undefined") return {};
		try {
			const raw = window.localStorage.getItem(schemaKey(schema));
			if (raw !== null) return JSON.parse(raw) as SizesMap;
		} catch {
			/* storage indispo / JSON corrompu */
		}
		return {};
	});

	// Persist à chaque mutation.
	useEffect(() => {
		if (typeof window === "undefined") return;
		try {
			window.localStorage.setItem(schemaKey(schema), JSON.stringify(sizes));
		} catch {
			/* quota / private mode */
		}
	}, [sizes, schema]);

	// Re-seed quand la signature change (nouvelle base).
	const key = schemaKey(schema);
	useEffect(() => {
		if (typeof window === "undefined") return;
		const raw = window.localStorage.getItem(key);
		if (raw !== null) {
			try {
				setSizes(JSON.parse(raw) as SizesMap);
				return;
			} catch {
				/* fallthrough */
			}
		}
		setSizes({});
	}, [key]);

	const setSize = useCallback((name: string, size: TableSize) => {
		setSizes((prev) => ({ ...prev, [name]: size }));
	}, []);

	return { sizes, setSize };
}
