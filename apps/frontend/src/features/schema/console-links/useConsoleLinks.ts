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
	type ConsolePlacement,
	useConsoleLinksFlag
} from "./ConsoleLinksContext";
import {
	CONSOLE_RESULT_HANDLE,
	QUERY_LINK_EDGE,
	RESULT_OWNER_HANDLE
} from "./QueryLinkEdge";
import type { ResultNodeType } from "./ResultNode";
import { type ConsoleEntry, useConsoleIndex } from "./useConsoleIndex";
import { resultKey, useResultRuns } from "./useResultRuns";

/** Écart entre une table et la console qui se déplie à sa droite. */
const GAP = 80;
/** Décalage entre deux consoles dépliées de la même table. */
const CASCADE = 32;
/** Écart entre une console et son résultat, posé dessous. */
const RESULT_GAP = 24;
const RESULT_PREFIX = "result:";

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
 * liste). Dépliée, elle se pose à droite de sa table ; plusieurs peuvent
 * l'être à la fois. Ses lignes sortent dans un frame au format table, relié
 * à la console (ou à la table quand la console est repliée). Le chemin de
 * jointures de la console en cours s'allume. Éteint, le canvas ne change pas.
 */
export function useConsoleLinks({
	connectionId,
	schema,
	tableNodes,
	consoles,
	edges
}: UseConsoleLinksOptions): UseConsoleLinksReturn {
	const [enabled] = useConsoleLinksFlag();
	// Consoles dépliées, la plus récente en dernier.
	const [openIds, setOpenIds] = useState<readonly string[]>([]);
	const tables = useMemo(
		() => new Set(schema.collections.map((c) => c.name)),
		[schema]
	);
	const consoleIds = useMemo(
		() => consoles.nodes.map((n) => n.id),
		[consoles.nodes]
	);
	const { entries, ready } = useConsoleIndex(
		enabled,
		connectionId,
		consoleIds,
		tables
	);
	const attached = useMemo(() => new Set(entries.map((e) => e.id)), [entries]);

	const { moveTo, createAt, focusedId, onNodesChange } = consoles;
	/** Place d'une console à droite de sa table, en cascade derrière les
	 * `rank` déjà dépliées de la même table. */
	const besideTable = useCallback(
		(table: string, rank: number) => {
			const node = tableNodes.find((n) => n.id === table);
			if (node === undefined) return null;
			return {
				x: node.position.x + (node.width ?? NODE_WIDTH) + GAP + rank * CASCADE,
				y: node.position.y + rank * CASCADE
			};
		},
		[tableNodes]
	);
	const openOf = useCallback(
		(table: string, except?: string) =>
			entries.filter(
				(e) => e.root === table && e.id !== except && openIds.includes(e.id)
			).length,
		[entries, openIds]
	);
	const open = useCallback(
		(id: string, placement: ConsolePlacement) => {
			const entry = entries.find((e) => e.id === id);
			if (placement === "beside" && entry !== undefined) {
				const position = besideTable(entry.root, openOf(entry.root, id));
				if (position !== null) moveTo(id, position);
			}
			setOpenIds((ids) => [...ids.filter((x) => x !== id), id]);
		},
		[entries, besideTable, openOf, moveTo]
	);
	// Replier désélectionne aussi : une console sélectionnée se redéplierait.
	const fold = useCallback(
		(id: string) => {
			onNodesChange([{ id, type: "select", selected: false }]);
			setOpenIds((ids) => ids.filter((x) => x !== id));
		},
		[onNodesChange]
	);
	const createFor = useCallback(
		(table: string) => {
			const position = besideTable(table, openOf(table));
			if (position === null) return;
			const id = createAt(position, `find ${table}`);
			setOpenIds((ids) => [...ids, id]);
		},
		[besideTable, openOf, createAt]
	);

	// Une console libre dont la requête vient de la rattacher est en cours de
	// frappe : elle se déplie d'elle-même, sélectionnée ou non. `loose` garde
	// les consoles libres du rendu précédent ; lu pendant le rendu, il évite
	// qu'elle disparaisse le temps que l'effet l'ajoute aux dépliées.
	const loose = useRef<ReadonlySet<string>>(new Set());
	useEffect(() => {
		if (!ready) return;
		const typed = entries
			.map((e) => e.id)
			.filter((id) => loose.current.has(id));
		loose.current = new Set(consoleIds.filter((id) => !attached.has(id)));
		if (typed.length > 0) {
			setOpenIds((ids) => [...ids.filter((x) => !typed.includes(x)), ...typed]);
		}
	}, [ready, entries, consoleIds, attached]);

	// Une console rattachée et sélectionnée est celle qu'on travaille : elle
	// se déplie, et le reste une fois désélectionnée.
	const working = enabled
		? consoles.nodes.find((n) => n.selected === true && attached.has(n.id))?.id
		: undefined;
	useEffect(() => {
		if (working === undefined) return;
		setOpenIds((ids) =>
			ids.at(-1) === working
				? ids
				: [...ids.filter((x) => x !== working), working]
		);
	}, [working]);

	// Échap replie la console sélectionnée, hors d'un champ de saisie : dans
	// l'éditeur la touche a d'autres usages. En capture : le raccourci Échap
	// du canvas consomme l'événement avant la phase de remontée.
	useEffect(() => {
		if (!enabled || working === undefined || focusedId !== null) return;
		const selected = working;
		function onKey(e: KeyboardEvent): void {
			if (e.key !== "Escape") return;
			const typing =
				e.target instanceof Element &&
				e.target.closest(
					".cm-editor, input, textarea, [contenteditable='true']"
				) !== null;
			if (!typing) fold(selected);
		}
		window.addEventListener("keydown", onKey, { capture: true });
		return () =>
			window.removeEventListener("keydown", onKey, { capture: true });
	}, [enabled, working, focusedId, fold]);

	const openSet = useMemo(() => new Set(openIds), [openIds]);
	const context = useMemo<ConsoleLinksValue | null>(() => {
		if (!enabled) return null;
		const byTable = new Map<string, ConsoleEntry[]>();
		for (const entry of entries) {
			byTable.set(entry.root, [...(byTable.get(entry.root) ?? []), entry]);
		}
		return { byTable, attached, openIds: openSet, open, fold, createFor };
	}, [enabled, entries, attached, openSet, open, fold, createFor]);

	const consoleNodes = useMemo(
		() =>
			enabled
				? consoles.nodes.filter(
						(n) =>
							!attached.has(n.id) ||
							openSet.has(n.id) ||
							n.selected === true ||
							loose.current.has(n.id)
					)
				: consoles.nodes,
		[enabled, consoles.nodes, attached, openSet]
	);

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
				const id = `${RESULT_PREFIX}${entry.id}`;
				const data = {
					consoleId: entry.id,
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

	// ─── Arêtes : chemin de la requête en cours, lien résultat → origine ──
	const shownConsoles = useMemo(
		() => new Set(consoleNodes.map((n) => n.id)),
		[consoleNodes]
	);
	const selectedResult = resultNodes.find((n) => n.selected === true);
	// La requête en cours : celle de la console sélectionnée, sinon du
	// résultat sélectionné, sinon de la dernière console dépliée.
	const activeId = working ?? selectedResult?.data.consoleId ?? openIds.at(-1);
	const shownEdges = useMemo(() => {
		if (!enabled) return edges;
		const active = entries.find((e) => e.id === activeId);
		const lit = active === undefined ? edges : litQueryPath(edges, active);
		const links = resultNodes.flatMap((node): Edge[] => {
			const { consoleId } = node.data;
			const fromConsole = shownConsoles.has(consoleId);
			const root = entries.find((e) => e.id === consoleId)?.root;
			if (!fromConsole && root === undefined) return [];
			return [
				{
					id: `link:${node.id}`,
					type: QUERY_LINK_EDGE,
					// Console repliée, le résultat se rattache à sa table.
					source: fromConsole ? consoleId : (root as string),
					sourceHandle: fromConsole ? CONSOLE_RESULT_HANDLE : "right",
					target: node.id,
					targetHandle: RESULT_OWNER_HANDLE,
					selectable: false,
					focusable: false,
					deletable: false,
					zIndex: 8
				}
			];
		});
		return [...lit, ...links];
	}, [enabled, edges, entries, activeId, resultNodes, shownConsoles]);

	return {
		context,
		consoleNodes,
		resultNodes,
		onResultNodesChange,
		edges: shownEdges
	};
}
