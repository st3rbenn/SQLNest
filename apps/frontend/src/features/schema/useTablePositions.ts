import { useCallback, useEffect, useState } from "react";
import type { SchemaModel } from "./schema-model";

export interface XY {
	readonly x: number;
	readonly y: number;
}

export type PositionsMap = Readonly<Record<string, XY>>;

/**
 * Signature stable d'un schéma pour la clé localStorage — miroir de celle
 * de `useFrames`. Positions clippées à cette empreinte : nouvelle base
 * (structure différente) → pas de collision, on repart à zéro.
 */
function schemaKey(schema: SchemaModel): string {
	const names = schema.collections
		.map((c) => c.name)
		.slice()
		.sort()
		.join(",");
	return `sqlnest:positions:${schema.engine}:${names}`;
}

interface PositionsApi {
	readonly positions: PositionsMap;
	readonly setPosition: (name: string, xy: XY) => void;
	readonly setManyPositions: (entries: Readonly<Record<string, XY>>) => void;
}

/**
 * Positions des tables persistées en localStorage. Pattern miroir de
 * `useFrames` — un consommateur unique (SchemaCanvas) applique ces
 * positions **par-dessus** le layout ELK, et enregistre les nouvelles
 * positions à chaque drag-stop (table ou frame).
 *
 * Contrat : c'est un SNAPSHOT read-only côté API + deux setters. On ne
 * fournit pas de reset — l'utilisateur clear en supprimant `localStorage`.
 */
export function useTablePositions(schema: SchemaModel): PositionsApi {
	const [positions, setPositions] = useState<PositionsMap>(() => {
		if (typeof window === "undefined") return {};
		try {
			const raw = window.localStorage.getItem(schemaKey(schema));
			if (raw !== null) return JSON.parse(raw) as PositionsMap;
		} catch {
			/* storage indispo / JSON corrompu */
		}
		return {};
	});

	// Persist à chaque mutation.
	useEffect(() => {
		if (typeof window === "undefined") return;
		try {
			window.localStorage.setItem(
				schemaKey(schema),
				JSON.stringify(positions)
			);
		} catch {
			/* quota / private mode */
		}
	}, [positions, schema]);

	// Re-seed quand la signature change (nouvelle base).
	const key = schemaKey(schema);
	useEffect(() => {
		if (typeof window === "undefined") return;
		const raw = window.localStorage.getItem(key);
		if (raw !== null) {
			try {
				setPositions(JSON.parse(raw) as PositionsMap);
				return;
			} catch {
				/* fallthrough */
			}
		}
		setPositions({});
	}, [key]);

	const setPosition = useCallback((name: string, xy: XY) => {
		setPositions((prev) => ({ ...prev, [name]: xy }));
	}, []);

	const setManyPositions = useCallback(
		(entries: Readonly<Record<string, XY>>) => {
			setPositions((prev) => ({ ...prev, ...entries }));
		},
		[]
	);

	return { positions, setPosition, setManyPositions };
}
