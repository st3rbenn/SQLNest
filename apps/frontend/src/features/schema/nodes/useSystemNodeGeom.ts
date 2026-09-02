import { type Node, useNodesState } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef } from "react";

/**
 * Géométrie persistée d'un node système — une par (prefix, connection).
 * localStorage suffit : la position n'a pas besoin d'être synchronisée
 * cross-device. Extrait de `useSchemaEventsNode` quand le node Enums est
 * arrivé — la persistence + le state RF sont identiques pour tous les
 * nodes système, seule la composition de `data` diffère (elle reste dans
 * chaque hook feature).
 */
export interface SystemNodeGeom {
	readonly position: { readonly x: number; readonly y: number };
	readonly width: number;
	readonly height: number;
}

function loadGeom(key: string, fallback: SystemNodeGeom): SystemNodeGeom {
	if (typeof window === "undefined") return fallback;
	try {
		const raw = window.localStorage.getItem(key);
		if (raw === null) return fallback;
		const parsed = JSON.parse(raw) as unknown;
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			typeof (parsed as { position?: unknown }).position === "object" &&
			typeof (parsed as { width?: unknown }).width === "number" &&
			typeof (parsed as { height?: unknown }).height === "number"
		) {
			const p = parsed as SystemNodeGeom;
			if (
				typeof p.position?.x === "number" &&
				typeof p.position?.y === "number"
			) {
				return p;
			}
		}
	} catch {
		/* JSON malformé — retombe sur le défaut */
	}
	return fallback;
}

function saveGeom(key: string, geom: SystemNodeGeom): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(key, JSON.stringify(geom));
	} catch {
		/* quota / private mode — perte de position acceptable */
	}
}

export interface UseSystemNodeGeomApi<TNode extends Node> {
	/** Node RF courant (géométrie live). `data` est celle du `build` initial —
	 * les hooks feature la recomposent par-dessus à chaque render. */
	readonly node: TNode;
	readonly onNodesChange: (
		changes: Parameters<ReturnType<typeof useNodesState<TNode>>[2]>[0]
	) => void;
	readonly updatePosition: (position: { x: number; y: number }) => void;
	readonly updateGeom: (geom: SystemNodeGeom) => void;
}

/**
 * State RF + persistence d'UN node système. `storagePrefix` est suffixé par
 * `connectionId` (clé stable par canvas). `build` construit le node initial
 * depuis la géométrie chargée — appelé au mount et au changement de
 * connection (reset, pour ne pas trainer la géométrie du canvas précédent).
 */
export function useSystemNodeGeom<TNode extends Node>(
	connectionId: string,
	storagePrefix: string,
	defaults: SystemNodeGeom,
	build: (geom: SystemNodeGeom) => TNode
): UseSystemNodeGeomApi<TNode> {
	const key = `${storagePrefix}${connectionId}`;

	const initial = useMemo<TNode[]>(
		() => [build(loadGeom(key, defaults))],
		// `build` volontairement hors deps : les hooks feature le passent
		// inline — le node initial ne dépend que de la connection (la data
		// live est recomposée par-dessus côté feature).
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[key]
	);

	const [nodes, setNodes, onNodesChange] = useNodesState<TNode>(initial);

	// Reset le state RF quand la connection change.
	const lastKeyRef = useRef(key);
	useEffect(() => {
		if (lastKeyRef.current !== key) {
			lastKeyRef.current = key;
			setNodes(initial);
		}
	}, [key, initial, setNodes]);

	const nodeId = initial[0]!.id;

	const updatePosition = useCallback(
		(position: { x: number; y: number }): void => {
			setNodes((prev) =>
				prev.map((n) => (n.id === nodeId ? { ...n, position } : n))
			);
			const geom = loadGeom(key, defaults);
			saveGeom(key, { ...geom, position });
		},
		// defaults est un literal stable côté feature (constante module).
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[key, nodeId, setNodes]
	);

	const updateGeom = useCallback(
		(g: SystemNodeGeom): void => {
			setNodes((prev) =>
				prev.map((n) =>
					n.id === nodeId
						? { ...n, position: g.position, width: g.width, height: g.height }
						: n
				)
			);
			saveGeom(key, g);
		},
		[key, nodeId, setNodes]
	);

	return {
		node: nodes[0] as TNode,
		onNodesChange,
		updatePosition,
		updateGeom
	};
}
