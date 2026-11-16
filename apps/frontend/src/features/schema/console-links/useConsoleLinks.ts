import { type Edge, type NodeChange, useNodesState } from "@sqlnest/canvas";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DECLARED_EDGE } from "../canvas/relationEdge";
import type { UseCanvasConsolesReturn } from "../canvas/useCanvasConsoles";
import { CONSOLE_NODE_DEFAULT_HEIGHT } from "../canvas/useConsoleNodes";
import type { ConsoleNodeType } from "../nodes/ConsoleNode";
import type { SchemaModel } from "../schema-model";
import { NODE_WIDTH, type TableNodeType } from "../TableNode";
import {
	type ConsoleLinksValue,
	useConsoleLinksFlag
} from "./ConsoleLinksContext";
import type { ResultNodeType } from "./ResultNode";
import { type ConsoleEntry, useConsoleIndex } from "./useConsoleIndex";
import { resultKey, useResultRuns } from "./useResultRuns";

/** Écart entre une table et la console qui se déplie à sa droite. */
const GAP = 80;
/** Écart entre une console et son résultat, posé dessous. */
const RESULT_GAP = 24;

export interface UseConsoleLinksOptions {
	readonly connectionId: string;
	readonly schema: SchemaModel;
	readonly tableNodes: readonly TableNodeType[];
	readonly consoles: UseCanvasConsolesReturn;
	readonly edges: Edge[];
}

export interface UseConsoleLinksReturn {
	/** `null` quand le prototype est éteint. */
	readonly context: ConsoleLinksValue | null;
	readonly consoleNodes: readonly ConsoleNodeType[];
	/** Résultats sortis des consoles, au format table. */
	readonly resultNodes: readonly ResultNodeType[];
	readonly onResultNodesChange: (changes: NodeChange<ResultNodeType>[]) => void;
	readonly edges: Edge[];
}

/** Arêtes du chemin d'une requête : entre sa table de départ et ses tables jointes. */
function litQueryPath(edges: Edge[], entry: ConsoleEntry): Edge[] {
	const onPath = new Set([entry.root, ...entry.joined]);
	if (onPath.size < 2) return edges;
	return edges.map((e) =>
		onPath.has(e.source) && onPath.has(e.target)
			? {
					...e,
					style: { ...e.style, stroke: DECLARED_EDGE, strokeWidth: 3 },
					// Au-dessus des autres arêtes, sous la console dépliée.
					zIndex: 1
				}
			: e
	);
}

/**
 * Prototype « console rattachée à sa table » : une console dont la requête
 * part d'une table se replie dans l'en-tête de cette table (compteur +
 * liste) ; une seule est dépliée à la fois, à droite de sa table, et son
 * chemin de jointures s'allume. Ses lignes sortent dans un frame au format
 * table, qui reste sur le canvas console repliée. Éteint, le canvas ne
 * change pas.
 */
export function useConsoleLinks({
	connectionId,
	schema,
	tableNodes,
	consoles,
	edges
}: UseConsoleLinksOptions): UseConsoleLinksReturn {
	const [enabled] = useConsoleLinksFlag();
	const [openId, setOpenId] = useState<string | null>(null);
	const tables = useMemo(
		() => new Set(schema.collections.map((c) => c.name)),
		[schema]
	);
	const consoleIds = useMemo(
		() => consoles.nodes.map((n) => n.id),
		[consoles.nodes]
	);
	const entries = useConsoleIndex(enabled, connectionId, consoleIds, tables);

	const { moveTo, createAt, focusedId, onNodesChange } = consoles;
	const besideTable = useCallback(
		(table: string) => {
			const node = tableNodes.find((n) => n.id === table);
			if (node === undefined) return null;
			return {
				x: node.position.x + (node.width ?? NODE_WIDTH) + GAP,
				y: node.position.y
			};
		},
		[tableNodes]
	);
	const open = useCallback(
		(id: string) => {
			const entry = entries.find((e) => e.id === id);
			const position = entry ? besideTable(entry.root) : null;
			if (position !== null) moveTo(id, position);
			setOpenId(id);
		},
		[entries, besideTable, moveTo]
	);
	// Replier désélectionne aussi : une console sélectionnée reste dépliée.
	const fold = useCallback(() => {
		if (openId !== null) {
			onNodesChange([{ id: openId, type: "select", selected: false }]);
		}
		setOpenId(null);
	}, [openId, onNodesChange]);
	const createFor = useCallback(
		(table: string) => {
			const position = besideTable(table);
			if (position === null) return;
			setOpenId(createAt(position, `find ${table}`));
		},
		[besideTable, createAt]
	);

	// Échap replie la console ouverte ; le plein écran garde la touche. En
	// capture : le raccourci Échap du canvas consomme l'événement avant la
	// phase de remontée. Une complétion ouverte dans l'éditeur passe d'abord.
	useEffect(() => {
		if (!enabled || openId === null || focusedId !== null) return;
		function onKey(e: KeyboardEvent): void {
			if (e.key !== "Escape") return;
			if (document.querySelector(".cm-tooltip-autocomplete") !== null) return;
			fold();
		}
		window.addEventListener("keydown", onKey, { capture: true });
		return () =>
			window.removeEventListener("keydown", onKey, { capture: true });
	}, [enabled, openId, focusedId, fold]);

	const context = useMemo<ConsoleLinksValue | null>(() => {
		if (!enabled) return null;
		const byTable = new Map<string, ConsoleEntry[]>();
		for (const entry of entries) {
			byTable.set(entry.root, [...(byTable.get(entry.root) ?? []), entry]);
		}
		return {
			byTable,
			attached: new Set(entries.map((e) => e.id)),
			openId,
			open,
			fold,
			createFor
		};
	}, [enabled, entries, openId, open, fold, createFor]);

	// Une console rattachée et sélectionnée est celle qu'on travaille : elle
	// reste dépliée, y compris à l'instant où sa requête la rattache.
	const working =
		context === null
			? undefined
			: consoles.nodes.find(
					(n) => n.selected === true && context.attached.has(n.id)
				)?.id;
	useEffect(() => {
		if (working !== undefined) setOpenId(working);
	}, [working]);

	const consoleNodes = useMemo(
		() =>
			context === null
				? consoles.nodes
				: consoles.nodes.filter(
						(n) =>
							!context.attached.has(n.id) ||
							n.id === openId ||
							n.selected === true
					),
		[context, consoles.nodes, openId]
	);
	const litEdges = useMemo(() => {
		const entry = entries.find((e) => e.id === openId);
		return context === null || entry === undefined
			? edges
			: litQueryPath(edges, entry);
	}, [context, entries, openId, edges]);

	// ─── Résultats en frames ──────────────────────────────────────────────
	const runs = useResultRuns(connectionId, entries);
	// Exécution dont le résultat a été fermé : la suivante le rouvre.
	const [closedRuns, setClosedRuns] = useState<ReadonlyMap<string, number>>(
		() => new Map()
	);
	const [resultNodes, setResultNodes, onResultNodesChange] =
		useNodesState<ResultNodeType>([]);
	// Lues à la pose d'un résultat seulement : en refs, un drag de table ou
	// de console ne repose pas les frames déjà placés.
	const tableNodesRef = useRef(tableNodes);
	tableNodesRef.current = tableNodes;
	const allConsolesRef = useRef(consoles.nodes);
	allConsolesRef.current = consoles.nodes;
	useEffect(() => {
		setResultNodes((prev) => {
			const prevById = new Map(prev.map((n) => [n.id, n]));
			return (enabled ? entries : []).flatMap((entry) => {
				const runAt = runs.get(entry.id);
				if (runAt === undefined || closedRuns.get(entry.id) === runAt) {
					return [];
				}
				const id = `result:${entry.id}`;
				const data = {
					queryKey: resultKey(connectionId, entry),
					title: entry.title,
					source: entry.source,
					onClose: () =>
						setClosedRuns((runsClosed) =>
							new Map(runsClosed).set(entry.id, runAt)
						)
				};
				const existing = prevById.get(id);
				if (existing !== undefined) return [{ ...existing, data }];
				const owner = allConsolesRef.current.find((n) => n.id === entry.id);
				const table = tableNodesRef.current.find((n) => n.id === entry.root);
				const position =
					owner !== undefined
						? {
								x: owner.position.x,
								y:
									owner.position.y +
									(owner.height ?? CONSOLE_NODE_DEFAULT_HEIGHT) +
									RESULT_GAP
							}
						: table !== undefined
							? {
									x: table.position.x + (table.width ?? NODE_WIDTH) + GAP,
									y: table.position.y
								}
							: null;
				if (position === null) return [];
				return [
					{
						id,
						type: "result" as const,
						ariaLabel: "Résultat de requête",
						position,
						deletable: false,
						zIndex: 9,
						data
					}
				];
			});
		});
	}, [enabled, entries, runs, closedRuns, connectionId, setResultNodes]);

	return {
		context,
		consoleNodes,
		resultNodes,
		onResultNodesChange,
		edges: litEdges
	};
}
