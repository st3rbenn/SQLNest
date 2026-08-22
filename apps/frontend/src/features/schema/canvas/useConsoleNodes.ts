/**
 * State + persistance des nodes console SNQL du canvas (T5).
 *
 * Chaque console est un node React Flow custom (`type: "console"`) qui
 * vit dans le graphe à côté des tables et frames. Ce hook ne s'occupe
 * QUE de la géométrie et de l'identité — les tabs / source / dernier
 * résultat sont gérés par `useConsoleTabs(connId, nodeId)` à l'intérieur
 * de chaque node (scope suffix = nodeId → tabs isolés par node).
 *
 * Persistance : localStorage `sqlnest:console-nodes:<connId>` →
 * `ConsoleNodeGeom[]`. Pas encore branché sur canvas_state serveur.
 *
 * Les geometries console sont locales au device (comme les tabs), l'user
 * peut les recréer n'importe où. Migration future = 30 min quand on
 * branche canvas_state.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface ConsoleNodeGeom {
	readonly id: string;
	readonly position: { readonly x: number; readonly y: number };
	readonly width: number;
	readonly height: number;
}

export const CONSOLE_NODE_DEFAULT_WIDTH = 620;
export const CONSOLE_NODE_DEFAULT_HEIGHT = 380;
export const CONSOLE_NODE_MIN_WIDTH = 380;
export const CONSOLE_NODE_MIN_HEIGHT = 240;

function storageKey(connectionId: string): string {
	return `sqlnest:console-nodes:${connectionId}`;
}

function loadFromStorage(connectionId: string): ConsoleNodeGeom[] {
	if (typeof window === "undefined") return [];
	try {
		const raw = window.localStorage.getItem(storageKey(connectionId));
		if (raw == null) return [];
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(x): x is ConsoleNodeGeom =>
				typeof x === "object" &&
				x !== null &&
				typeof (x as { id?: unknown }).id === "string" &&
				typeof (x as { width?: unknown }).width === "number" &&
				typeof (x as { height?: unknown }).height === "number" &&
				typeof (x as { position?: { x?: unknown; y?: unknown } }).position === "object"
		);
	} catch {
		return [];
	}
}

function saveToStorage(connectionId: string, geoms: readonly ConsoleNodeGeom[]): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(storageKey(connectionId), JSON.stringify(geoms));
	} catch {
		/* quota / private mode */
	}
}

function makeId(): string {
	if (
		typeof crypto !== "undefined" &&
		typeof crypto.randomUUID === "function"
	) {
		return `console:${crypto.randomUUID()}`;
	}
	return `console:${Math.random().toString(36).slice(2, 12)}`;
}

export interface UseConsoleNodesApi {
	readonly geoms: readonly ConsoleNodeGeom[];
	/** Crée un node console à la position donnée avec les dimensions par
	 * défaut ; renvoie l'id créé. */
	readonly create: (position: { x: number; y: number }) => string;
	/** Met à jour la position (drag stop RF). No-op si l'id n'existe pas. */
	readonly updatePosition: (
		id: string,
		position: { x: number; y: number }
	) => void;
	/** Met à jour les dimensions ET la position (resize end RF). RF déplace
	 * l'origine sur un handle top/left pour garder l'opposé fixe → il faut
	 * persister x/y avec width/height, sinon le node revient à l'ancienne
	 * origine au refresh. No-op si l'id n'existe pas. */
	readonly updateGeom: (
		id: string,
		geom: {
			position: { x: number; y: number };
			width: number;
			height: number;
		}
	) => void;
	/** Supprime un node console — appelle aussi le clean localStorage tabs. */
	readonly remove: (id: string) => void;
}

export function useConsoleNodes(connectionId: string): UseConsoleNodesApi {
	const [geoms, setGeoms] = useState<readonly ConsoleNodeGeom[]>(() =>
		loadFromStorage(connectionId)
	);

	// Le state redevient une lecture fresh du localStorage quand connectionId
	// change — évite de trainer les geoms de la connexion précédente sur un
	// canvas différent (bug potentiel si un user switch de canvas rapidement).
	const lastConnRef = useRef(connectionId);
	useEffect(() => {
		if (lastConnRef.current !== connectionId) {
			lastConnRef.current = connectionId;
			setGeoms(loadFromStorage(connectionId));
		}
	}, [connectionId]);

	useEffect(() => {
		saveToStorage(connectionId, geoms);
	}, [connectionId, geoms]);

	const create = useCallback((position: { x: number; y: number }): string => {
		const id = makeId();
		const geom: ConsoleNodeGeom = {
			id,
			position,
			width: CONSOLE_NODE_DEFAULT_WIDTH,
			height: CONSOLE_NODE_DEFAULT_HEIGHT
		};
		setGeoms((prev) => [...prev, geom]);
		return id;
	}, []);

	const updatePosition = useCallback(
		(id: string, position: { x: number; y: number }): void => {
			setGeoms((prev) =>
				prev.map((g) => (g.id === id ? { ...g, position } : g))
			);
		},
		[]
	);

	const updateGeom = useCallback(
		(
			id: string,
			geom: {
				position: { x: number; y: number };
				width: number;
				height: number;
			}
		): void => {
			setGeoms((prev) =>
				prev.map((g) =>
					g.id === id
						? {
								...g,
								position: geom.position,
								width: Math.max(CONSOLE_NODE_MIN_WIDTH, geom.width),
								height: Math.max(CONSOLE_NODE_MIN_HEIGHT, geom.height)
							}
						: g
				)
			);
		},
		[]
	);

	const remove = useCallback(
		(id: string): void => {
			setGeoms((prev) => prev.filter((g) => g.id !== id));
			// Clean les tabs orphelins de ce node — sans ça, un user qui
			// recrée un node avec un id différent laisse des tabs pouvant
			// accumuler indéfiniment dans localStorage.
			if (typeof window !== "undefined") {
				try {
					window.localStorage.removeItem(
						`sqlnest.console.tabs.${connectionId}.${id}`
					);
				} catch {
					/* quota / private mode */
				}
			}
		},
		[connectionId]
	);

	return { geoms, create, updatePosition, updateGeom, remove };
}
