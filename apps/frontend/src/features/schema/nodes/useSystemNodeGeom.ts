import { type Node, useNodesState } from "@sqlnest/canvas";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
	type ConnectionSlice,
	connectionKey,
	readJson,
	writeJson
} from "../../storage/localStore";
import { SYSTEM_NODE_CLASS } from "./SystemNodeShell";

/**
 * Géométrie persistée d'un node système — une par (prefix, connection).
 * localStorage suffit : la position n'a pas besoin d'être synchronisée
 * cross-device. Extrait de `useSchemaEventsNode` quand le node Enums est
 * arrivé — la persistence + le state du node sont identiques pour tous les
 * nodes système, seule la composition de `data` diffère (elle reste dans
 * chaque hook feature).
 */
export interface SystemNodeGeom {
	readonly position: { readonly x: number; readonly y: number };
	readonly width: number;
	readonly height: number;
}

function loadGeom(key: string, fallback: SystemNodeGeom): SystemNodeGeom {
	const parsed = readJson(key);
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
	return fallback;
}

function saveGeom(key: string, geom: SystemNodeGeom): void {
	writeJson(key, geom);
}

export interface UseSystemNodeGeomApi<TNode extends Node> {
	/** Node courant (géométrie live). `data` est celle du `build` initial —
	 * les hooks feature la recomposent par-dessus à chaque render. */
	readonly node: TNode;
	readonly onNodesChange: (
		changes: Parameters<ReturnType<typeof useNodesState<TNode>>[2]>[0]
	) => void;
	readonly updatePosition: (position: { x: number; y: number }) => void;
	readonly updateGeom: (geom: SystemNodeGeom) => void;
	/** Une géométrie est-elle déjà gardée pour ce node sur cette connexion ? */
	readonly hasStoredGeom: () => boolean;
}

/**
 * State + persistence d'UN node système, dans la tranche `slice` de la
 * connexion (clé stable par canvas). `build` construit le node initial
 * depuis la géométrie chargée — appelé au mount et au changement de
 * connection (reset, pour ne pas trainer la géométrie du canvas précédent).
 */
export function useSystemNodeGeom<TNode extends Node>(
	connectionId: string,
	slice: ConnectionSlice,
	defaults: SystemNodeGeom,
	build: (geom: SystemNodeGeom) => TNode
): UseSystemNodeGeomApi<TNode> {
	const key = connectionKey(slice, connectionId);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `build` et `defaults` hors deps, le node initial ne dépend que de la connexion
	const initial = useMemo<TNode[]>(
		() => {
			const built = build(loadGeom(key, defaults));
			// Classe partagée injectée ICI (pas dans les features) — le CSS
			// de comportement système (resize hover) cible cette classe, un
			// nouveau node système en hérite automatiquement.
			return [{ ...built, className: SYSTEM_NODE_CLASS }];
		},
		// `build` volontairement hors deps : les hooks feature le passent
		// inline — le node initial ne dépend que de la connection (la data
		// live est recomposée par-dessus côté feature).
		[key]
	);

	const [nodes, setNodes, onNodesChange] = useNodesState<TNode>(initial);

	// Reset le state quand la connection change.
	const lastKeyRef = useRef(key);
	useEffect(() => {
		if (lastKeyRef.current !== key) {
			lastKeyRef.current = key;
			setNodes(initial);
		}
	}, [key, initial, setNodes]);

	const nodeId = initial[0]?.id;

	// biome-ignore lint/correctness/useExhaustiveDependencies: `defaults` est une constante de module côté feature
	const updatePosition = useCallback(
		(position: { x: number; y: number }): void => {
			setNodes((prev) =>
				prev.map((n) => (n.id === nodeId ? { ...n, position } : n))
			);
			const geom = loadGeom(key, defaults);
			saveGeom(key, { ...geom, position });
		},
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

	const hasStoredGeom = useCallback(
		(): boolean => readJson(key) !== undefined,
		[key]
	);

	return {
		node: nodes[0] as TNode,
		onNodesChange,
		updatePosition,
		updateGeom,
		hasStoredGeom
	};
}
