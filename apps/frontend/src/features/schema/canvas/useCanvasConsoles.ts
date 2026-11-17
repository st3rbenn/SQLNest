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
	/** Passe une console en édition : éditeur actif, frame figé. */
	readonly enterEdit: (id: string) => void;
	readonly createAtCenter: () => void;
	/** Ouvre une console au centre, son premier onglet rempli de `source`. */
	readonly openWithSource: (source: string) => void;
	/** Crée une console à `position`, son premier onglet rempli de `source`.
	 * Elle n'entre pas en édition : on la pose, on l'édite si on veut. */
	readonly createAt: (position: XY, source: string) => string;
	/** Fin de drag d'une console : sa position est gardée. */
	readonly persistPosition: (id: string, position: XY) => void;
	/** Déplace une console et garde sa nouvelle position. */
	readonly moveTo: (id: string, position: XY) => void;
	readonly remove: (id: string) => void;
}

/** Décalage d'une console créée là où une autre se trouve déjà. */
const CASCADE = 32;

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
	// Console en édition : son éditeur a le clavier, elle ne se déplace plus.
	// Les autres se manipulent comme des frames.
	const [editingId, setEditingId] = useState<string | null>(null);
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
					data: {
						teamSlug,
						connId: connectionId,
						isFocused: false,
						isEditing: false
					}
				};
			});
		});
	}, [consoleNodes.geoms, setCanvasNodes, teamSlug, connectionId]);

	const enterFocus = useCallback((id: string) => setFocusedId(id), []);
	const exitFocus = useCallback(() => setFocusedId(null), []);
	const enterEdit = useCallback((id: string) => setEditingId(id), []);
	const exitEdit = useCallback(
		(id: string) =>
			setEditingId((current) => (current === id ? null : current)),
		[]
	);

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
					draggable: !isFocused && n.id !== editingId,
					// Le Backspace natif retirerait le node sans nettoyer ses
					// onglets : la suppression passe par le `×` de l'en-tête.
					deletable: false,
					zIndex: 10,
					data: {
						teamSlug,
						connId: connectionId,
						isFocused,
						isEditing: n.id === editingId,
						onExitEdit: exitEdit,
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
			editingId,
			enterFocus,
			exitFocus,
			exitEdit
		]
	);

	const createCentered = useCallback((): string | null => {
		const pt = viewCenter();
		if (pt === null) return null;
		const position = {
			x: pt.x - CONSOLE_NODE_DEFAULT_WIDTH / 2,
			y: pt.y - CONSOLE_NODE_DEFAULT_HEIGHT / 2
		};
		// Une console déjà posée là cacherait la nouvelle : en cascade.
		const taken = (at: XY): boolean =>
			consoleNodes.geoms.some(
				(g) =>
					Math.abs(g.position.x - at.x) < CASCADE / 2 &&
					Math.abs(g.position.y - at.y) < CASCADE / 2
			);
		while (taken(position)) {
			position.x += CASCADE;
			position.y += CASCADE;
		}
		const nodeId = create(position);
		// Une console qu'on vient de créer attend sa requête.
		setEditingId(nodeId);
		return nodeId;
	}, [viewCenter, create, consoleNodes.geoms]);
	const createAtCenter = useCallback(() => {
		createCentered();
	}, [createCentered]);
	// Les onglets du node sont écrits juste après sa création :
	// `useConsoleTabs` les lit au montage, la console s'ouvre remplie.
	const fillFirstTab = useCallback(
		(nodeId: string, source: string) => {
			const tabId = makeTabId();
			writeJson(consoleTabsKey(connectionId, nodeId), {
				tabs: [{ id: tabId, name: "Sans titre", source }],
				activeTabId: tabId
			});
		},
		[connectionId]
	);
	const openWithSource = useCallback(
		(source: string) => {
			const nodeId = createCentered();
			if (nodeId !== null) fillFirstTab(nodeId, source);
		},
		[createCentered, fillFirstTab]
	);
	const createAt = useCallback(
		(position: XY, source: string): string => {
			const nodeId = create(position);
			fillFirstTab(nodeId, source);
			return nodeId;
		},
		[create, fillFirstTab]
	);
	const moveTo = useCallback(
		(id: string, position: XY) => {
			setCanvasNodes((prev) =>
				prev.map((n) => (n.id === id ? { ...n, position } : n))
			);
			updatePosition(id, position);
		},
		[setCanvasNodes, updatePosition]
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
		enterEdit,
		createAtCenter,
		openWithSource,
		createAt,
		persistPosition,
		moveTo,
		remove
	};
}
