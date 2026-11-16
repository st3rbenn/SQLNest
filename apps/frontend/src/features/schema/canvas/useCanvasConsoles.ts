import { type NodeChange, useNodesState } from "@sqlnest/canvas";
import { useCallback, useEffect, useMemo, useState } from "react";
import { consoleTabsKey } from "../../query/useConsoleTabs";
import { writeJson } from "../../storage/localStore";
import type { ConsoleNodeType } from "../nodes/ConsoleNode";
import type { XY } from "../useTablePositions";
import {
	CONSOLE_NODE_DEFAULT_HEIGHT,
	CONSOLE_NODE_DEFAULT_WIDTH,
	useConsoleNodes
} from "./useConsoleNodes";

export interface UseCanvasConsolesOptions {
	readonly connectionId: string;
	readonly teamSlug: string;
	/** Centre de la vue courante : là où s'ouvre une nouvelle console. */
	readonly viewCenter: () => XY | null;
}

export interface UseCanvasConsolesReturn {
	/** Nodes console prêts à afficher. */
	readonly nodes: readonly ConsoleNodeType[];
	readonly onNodesChange: (changes: NodeChange<ConsoleNodeType>[]) => void;
	/** Console en plein écran, `null` sinon. */
	readonly focusedId: string | null;
	readonly enterFocus: (id: string) => void;
	readonly exitFocus: () => void;
	readonly createAtCenter: () => void;
	/** Ouvre une console au centre, son premier onglet rempli de `source`. */
	readonly openWithSource: (source: string) => void;
	/** Fin de drag d'une console : sa position est gardée. */
	readonly persistPosition: (id: string, position: XY) => void;
	readonly remove: (id: string) => void;
}

function makeTabId(): string {
	return typeof crypto !== "undefined" &&
		typeof crypto.randomUUID === "function"
		? crypto.randomUUID()
		: `tab-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Consoles SNQL posées sur le canvas. Chacune est un node comme une table ;
 * sa géométrie est gardée localement par `useConsoleNodes`.
 *
 * Les consoles ont leur propre state de nodes, séparé de celui des tables :
 * il suit positions et dimensions pendant un drag ou un resize sans passer
 * par la persistance, écrite seulement en fin de geste.
 *
 * Le plein écran est un portail vers `document.body`, rendu par
 * `ConsoleNode` hors du transform du viewport : texte net, caméra du canvas
 * intacte, et le node garde sa place dans le graphe.
 */
export function useCanvasConsoles({
	connectionId,
	teamSlug,
	viewCenter
}: UseCanvasConsolesOptions): UseCanvasConsolesReturn {
	const consoleNodes = useConsoleNodes(connectionId);
	const [focusedId, setFocusedId] = useState<string | null>(null);
	const [canvasNodes, setCanvasNodes, onNodesChange] =
		useNodesState<ConsoleNodeType>([]);

	// Géométries gardées → state des nodes. Un node déjà présent garde ses
	// valeurs : elles sont plus fraîches que la persistance pendant un geste.
	useEffect(() => {
		setCanvasNodes((prev) => {
			const prevById = new Map(prev.map((n) => [n.id, n]));
			return consoleNodes.geoms.map((g) => {
				const existing = prevById.get(g.id);
				if (existing) return existing;
				return {
					id: g.id,
					type: "console" as const,
					ariaLabel: "Console SNQL",
					position: g.position,
					width: g.width,
					height: g.height,
					// Complété (props + data) dans `nodes`, plus bas.
					data: { teamSlug, connId: connectionId, isFocused: false }
				};
			});
		});
	}, [consoleNodes.geoms, setCanvasNodes, teamSlug, connectionId]);

	const enterFocus = useCallback((id: string) => setFocusedId(id), []);
	const exitFocus = useCallback(() => setFocusedId(null), []);

	// Échap sort du plein écran. Écoute en capture : CodeMirror consommerait
	// la touche avant qu'elle n'arrive ici.
	useEffect(() => {
		if (focusedId === null) return;
		function onKey(e: KeyboardEvent): void {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			setFocusedId(null);
		}
		window.addEventListener("keydown", onKey, { capture: true });
		return () =>
			window.removeEventListener("keydown", onKey, { capture: true });
	}, [focusedId]);

	const { updateGeom, updatePosition, remove, create } = consoleNodes;
	const nodes = useMemo<ConsoleNodeType[]>(
		() =>
			canvasNodes.map((n) => {
				const isFocused = n.id === focusedId;
				return {
					...n,
					// Sélectionnable : le CSS `.selected` garde les poignées de
					// resize visibles sans survol.
					selectable: !isFocused,
					draggable: !isFocused,
					// Le Backspace natif retirerait le node sans nettoyer ses
					// onglets : la suppression passe par le `×` de l'en-tête.
					deletable: false,
					zIndex: 10,
					data: {
						teamSlug,
						connId: connectionId,
						isFocused,
						onResizeEnd: (nodeId, size) =>
							updateGeom(nodeId, {
								position: { x: size.x, y: size.y },
								width: size.width,
								height: size.height
							}),
						onEnterFocus: enterFocus,
						onExitFocus: exitFocus,
						onDelete: remove
					}
				};
			}),
		[
			canvasNodes,
			updateGeom,
			remove,
			teamSlug,
			connectionId,
			focusedId,
			enterFocus,
			exitFocus
		]
	);

	const createCentered = useCallback((): string | null => {
		const pt = viewCenter();
		if (pt === null) return null;
		return create({
			x: pt.x - CONSOLE_NODE_DEFAULT_WIDTH / 2,
			y: pt.y - CONSOLE_NODE_DEFAULT_HEIGHT / 2
		});
	}, [viewCenter, create]);
	const createAtCenter = useCallback(() => {
		createCentered();
	}, [createCentered]);
	// Les onglets du node sont écrits juste après sa création :
	// `useConsoleTabs` les lit au montage, la console s'ouvre remplie.
	const openWithSource = useCallback(
		(source: string) => {
			const nodeId = createCentered();
			if (nodeId === null) return;
			const tabId = makeTabId();
			writeJson(consoleTabsKey(connectionId, nodeId), {
				tabs: [{ id: tabId, name: "Sans titre", source }],
				activeTabId: tabId
			});
		},
		[createCentered, connectionId]
	);

	const persistPosition = useCallback(
		(id: string, position: XY) => {
			if (id !== focusedId) updatePosition(id, position);
		},
		[focusedId, updatePosition]
	);

	return {
		nodes,
		onNodesChange,
		focusedId,
		enterFocus,
		exitFocus,
		createAtCenter,
		openWithSource,
		persistPosition,
		remove
	};
}
