import { useCallback, useEffect, useRef, useState } from "react";
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
function loadPositions(key: string): PositionsMap {
	if (typeof window === "undefined") return {};
	try {
		const raw = window.localStorage.getItem(key);
		if (raw !== null) return JSON.parse(raw) as PositionsMap;
	} catch {
		/* storage indispo / JSON corrompu */
	}
	return {};
}

export function useTablePositions(schema: SchemaModel): PositionsApi {
	const key = schemaKey(schema);
	const [positions, setPositions] = useState<PositionsMap>(() => loadPositions(key));

	// Track quel `key` est actuellement représenté par `positions` en state.
	// Sert à distinguer un vrai mutate user (persist OK) d'un pending re-seed
	// après un changement de schéma (persist SKIP, sinon on écraserait le
	// nouveau key avec les vieilles positions avant que le re-seed effect
	// n'ait eu le temps de fire).
	const loadedKey = useRef(key);

	// Re-seed quand la signature change (nouvelle base) : lit le nouveau key
	// puis met à jour `loadedKey` — l'effet de persist ci-dessous devient alors
	// autorisé sur ce nouveau key.
	useEffect(() => {
		if (loadedKey.current === key) return;
		const loaded = loadPositions(key);
		loadedKey.current = key;
		setPositions(loaded);
	}, [key]);

	// Persist positions au localStorage — SEULEMENT si le key en état matche
	// le key courant. Sinon (transition de schéma), le re-seed ci-dessus n'a
	// pas encore tourné, et écrire les vieilles positions au nouveau key
	// corromprait le storage.
	useEffect(() => {
		if (typeof window === "undefined") return;
		if (loadedKey.current !== key) return;
		try {
			window.localStorage.setItem(key, JSON.stringify(positions));
		} catch {
			/* quota / private mode */
		}
	}, [key, positions]);

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
