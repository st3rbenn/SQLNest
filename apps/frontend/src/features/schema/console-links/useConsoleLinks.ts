import { type Edge, type NodeChange, useNodesState } from "@sqlnest/canvas";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getConsoleQueryState } from "../../query/consoleQueriesStore";
import { DECLARED_EDGE } from "../canvas/relationEdge";
import type { UseCanvasConsolesReturn } from "../canvas/useCanvasConsoles";
import {
	CONSOLE_NODE_DEFAULT_HEIGHT,
	CONSOLE_NODE_DEFAULT_WIDTH
} from "../canvas/useConsoleNodes";
import type { ConsoleNodeType } from "../nodes/ConsoleNode";
import type { SchemaModel } from "../schema-model";
import { NODE_WIDTH, nodeHeight, type TableNodeType } from "../TableNode";
import type {
	ConsoleLinksValue,
	ConsolePlacement,
	FlowPoint
} from "./ConsoleLinksContext";
import { placeNear, type Rect } from "./placeNear";
import {
	CONSOLE_RESULT_HANDLE,
	CONSOLE_TABLE_HANDLE,
	QUERY_LINK_EDGE,
	RESULT_OWNER_HANDLE
} from "./QueryLinkEdge";
import { estimateResultSize, type ResultNodeType } from "./ResultNode";
import { type ConsoleEntry, useConsoleIndex } from "./useConsoleIndex";
import { useOpenConsoles } from "./useOpenConsoles";
import { resultKey, useResultRuns } from "./useResultRuns";

/** Écart entre une table et la console qui se déplie à côté d'elle. */
const GAP = 80;
/** Écart entre une console et son résultat. */
const RESULT_GAP = 24;
/** Marge gardée entre un frame qu'on pose et ceux déjà là. */
const CLEARANCE = 24;
const RESULT_PREFIX = "result:";
/** Taille d'un résultat pas encore mesuré, quand rien ne permet de l'estimer. */
const RESULT_FALLBACK = { width: 480, height: 300 };

const tableRect = (n: TableNodeType): Rect => ({
	x: n.position.x,
	y: n.position.y,
	width: n.width ?? NODE_WIDTH,
	height: n.height ?? nodeHeight(n.data.collection)
});
const consoleRect = (n: ConsoleNodeType): Rect => ({
	x: n.position.x,
	y: n.position.y,
	width: n.width ?? CONSOLE_NODE_DEFAULT_WIDTH,
	height: n.height ?? CONSOLE_NODE_DEFAULT_HEIGHT
});
const resultRect = (n: ResultNodeType): Rect => ({
	x: n.position.x,
	y: n.position.y,
	width: n.measured?.width ?? n.width ?? RESULT_FALLBACK.width,
	height: n.measured?.height ?? n.height ?? RESULT_FALLBACK.height
});

export interface UseConsoleLinksOptions {
	readonly connectionId: string;
	readonly schema: SchemaModel;
	readonly tableNodes: readonly TableNodeType[];
	readonly consoles: UseCanvasConsolesReturn;
	readonly edges: Edge[];
	/** Amène à l'écran un frame qui vient d'être posé. */
	readonly reveal: (rect: Rect) => void;
}

export interface UseConsoleLinksReturn {
	readonly context: ConsoleLinksValue;
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
 * Console rattachée à sa table : une console dont la requête part d'une
 * table se replie dans l'en-tête de cette table (compteur + liste). Dépliée,
 * elle se pose à la place libre la plus proche de sa table ; plusieurs
 * peuvent l'être à la fois, chacune reliée à sa table. Ses lignes sortent
 * dans un frame au format table, relié à la console (ou à la table quand la
 * console est repliée). Le chemin de jointures de la console en cours
 * s'allume. Une console sans table de départ reste un frame libre.
 */
export function useConsoleLinks({
	connectionId,
	schema,
	tableNodes,
	consoles,
	edges,
	reveal
}: UseConsoleLinksOptions): UseConsoleLinksReturn {
	// Consoles dépliées, la plus récente en dernier.
	const [openIds, setOpenIds] = useOpenConsoles(connectionId);
	const tables = useMemo(
		() => new Set(schema.collections.map((c) => c.name)),
		[schema]
	);
	const consoleIds = useMemo(
		() => consoles.nodes.map((n) => n.id),
		[consoles.nodes]
	);
	const { entries, ready } = useConsoleIndex(connectionId, consoleIds, tables);
	const attached = useMemo(() => new Set(entries.map((e) => e.id)), [entries]);

	const { moveTo, createAt, focusedId, onNodesChange } = consoles;
	// Frames posés sur le canvas, lus au moment d'en poser un nouveau : en
	// refs, déplacer une table ne recalcule ni rappels ni résultats.
	const tableNodesRef = useRef(tableNodes);
	tableNodesRef.current = tableNodes;
	const allConsolesRef = useRef(consoles.nodes);
	allConsolesRef.current = consoles.nodes;
	const shownConsolesRef = useRef<readonly ConsoleNodeType[]>([]);
	const resultNodesRef = useRef<readonly ResultNodeType[]>([]);
	/** Ce qu'un frame qu'on pose ne doit pas recouvrir (`except` : lui-même). */
	const takenRects = useCallback(
		(except?: string): Rect[] => [
			...tableNodesRef.current.map(tableRect),
			...shownConsolesRef.current
				.filter((n) => n.id !== except)
				.map(consoleRect),
			...resultNodesRef.current.filter((n) => n.id !== except).map(resultRect)
		],
		[]
	);
	/** Place libre la plus proche de la table pour une console, à sa droite
	 * de préférence. */
	const besideTable = useCallback(
		(
			table: string,
			size: { readonly width: number; readonly height: number },
			except?: string
		) => {
			const node = tableNodesRef.current.find((n) => n.id === table);
			if (node === undefined) return null;
			return placeNear(tableRect(node), size, takenRects(except), {
				gap: GAP,
				clearance: CLEARANCE,
				prefer: ["right", "below", "left", "above"]
			});
		},
		[takenRects]
	);
	const open = useCallback(
		(id: string, placement: ConsolePlacement) => {
			const entry = entries.find((e) => e.id === id);
			const node = allConsolesRef.current.find((n) => n.id === id);
			const size = {
				width: node?.width ?? CONSOLE_NODE_DEFAULT_WIDTH,
				height: node?.height ?? CONSOLE_NODE_DEFAULT_HEIGHT
			};
			// Point de dépôt : la console se pose juste au-dessus, centrée.
			const position =
				typeof placement === "object"
					? { x: placement.x - size.width / 2, y: placement.y - size.height }
					: placement === "beside" && entry !== undefined
						? besideTable(entry.root, size, id)
						: null;
			if (position !== null) {
				moveTo(id, position);
				reveal({ ...position, ...size });
			}
			setOpenIds((ids) => [...ids.filter((x) => x !== id), id]);
		},
		[entries, besideTable, moveTo, setOpenIds, reveal]
	);
	// Replier désélectionne aussi : une console sélectionnée se redéplierait.
	const fold = useCallback(
		(id: string) => {
			onNodesChange([{ id, type: "select", selected: false }]);
			setOpenIds((ids) => ids.filter((x) => x !== id));
		},
		[onNodesChange, setOpenIds]
	);
	const createFor = useCallback(
		(table: string, at?: FlowPoint) => {
			const size = {
				width: CONSOLE_NODE_DEFAULT_WIDTH,
				height: CONSOLE_NODE_DEFAULT_HEIGHT
			};
			const position =
				at !== undefined
					? { x: at.x - size.width / 2, y: at.y - size.height }
					: besideTable(table, size);
			if (position === null) return;
			const id = createAt(position, `find ${table}`);
			reveal({ ...position, ...size });
			setOpenIds((ids) => [...ids, id]);
		},
		[besideTable, createAt, setOpenIds, reveal]
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
	}, [ready, entries, consoleIds, attached, setOpenIds]);

	// Une console rattachée et sélectionnée est celle qu'on travaille : elle
	// se déplie, et le reste une fois désélectionnée.
	const working = consoles.nodes.find(
		(n) => n.selected === true && attached.has(n.id)
	)?.id;
	useEffect(() => {
		if (working === undefined) return;
		setOpenIds((ids) =>
			ids.at(-1) === working
				? ids
				: [...ids.filter((x) => x !== working), working]
		);
	}, [working, setOpenIds]);

	// Échap replie la console sélectionnée, hors d'un champ de saisie : dans
	// l'éditeur la touche a d'autres usages. En capture : le raccourci Échap
	// du canvas consomme l'événement avant la phase de remontée.
	useEffect(() => {
		if (working === undefined || focusedId !== null) return;
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
	}, [working, focusedId, fold]);

	const openSet = useMemo(() => new Set(openIds), [openIds]);
	const context = useMemo<ConsoleLinksValue>(() => {
		const byTable = new Map<string, ConsoleEntry[]>();
		for (const entry of entries) {
			byTable.set(entry.root, [...(byTable.get(entry.root) ?? []), entry]);
		}
		return {
			byTable,
			attached,
			rootOf: new Map(entries.map((e) => [e.id, e.root])),
			openIds: openSet,
			open,
			fold,
			createFor
		};
	}, [entries, attached, openSet, open, fold, createFor]);

	const consoleNodes = useMemo(
		() =>
			consoles.nodes.filter(
				(n) =>
					!attached.has(n.id) ||
					openSet.has(n.id) ||
					n.selected === true ||
					loose.current.has(n.id)
			),
		[consoles.nodes, attached, openSet]
	);

	// ─── Résultats en frames ──────────────────────────────────────────────
	const runs = useResultRuns(connectionId, entries);
	// Exécution dont le résultat a été fermé : la suivante le rouvre.
	const [closedRuns, setClosedRuns] = useState<ReadonlyMap<string, number>>(
		() => new Map()
	);
	const [resultNodes, setResultNodes, onResultNodesChange] =
		useNodesState<ResultNodeType>([]);
	shownConsolesRef.current = consoleNodes;
	resultNodesRef.current = resultNodes;
	useEffect(() => {
		setResultNodes((prev) => {
			const prevById = new Map(prev.map((n) => [n.id, n]));
			// Résultats posés dans cette même passe : ils comptent aussi.
			const placed: Rect[] = [];
			return entries.flatMap((entry) => {
				const runAt = runs.get(entry.id);
				if (runAt === undefined || closedRuns.get(entry.id) === runAt) {
					return [];
				}
				const id = `${RESULT_PREFIX}${entry.id}`;
				const existing = prevById.get(id);
				const data = {
					resized: existing?.data.resized ?? false,
					consoleId: entry.id,
					queryKey: resultKey(connectionId, entry),
					title: entry.title,
					source: entry.source,
					onClose: () =>
						setClosedRuns((runsClosed) =>
							new Map(runsClosed).set(entry.id, runAt)
						)
				};
				if (existing !== undefined) return [{ ...existing, data }];
				// Un résultat apparaît à la place libre la plus proche de sa
				// console (dessous de préférence), ou de sa table si elle est
				// repliée.
				const owner = shownConsolesRef.current.find((n) => n.id === entry.id);
				const table = tableNodesRef.current.find((n) => n.id === entry.root);
				const anchor =
					owner !== undefined
						? consoleRect(owner)
						: table !== undefined
							? tableRect(table)
							: null;
				const result = getConsoleQueryState(data.queryKey).data;
				const size =
					result === undefined ? RESULT_FALLBACK : estimateResultSize(result);
				const position =
					anchor === null
						? null
						: placeNear(anchor, size, [...takenRects(id), ...placed], {
								gap: owner !== undefined ? RESULT_GAP : GAP,
								clearance: CLEARANCE,
								// Sous sa console, le résultat se centre sur elle.
								align: owner !== undefined ? "center" : "start",
								prefer:
									owner !== undefined
										? ["below", "right", "left", "above"]
										: ["right", "below", "left", "above"]
							});
				if (position === null) return [];
				placed.push({ ...position, ...size });
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
	}, [entries, runs, closedRuns, connectionId, setResultNodes, takenRects]);

	// Un résultat qui apparaît vient à l'écran, une fois sa taille mesurée.
	// Une nouvelle exécution le garde où il est : il n'est montré qu'une fois.
	const revealed = useRef<ReadonlySet<string>>(new Set());
	useEffect(() => {
		const seen = new Set<string>();
		for (const node of resultNodes) {
			if (revealed.current.has(node.id)) seen.add(node.id);
			else if (node.measured?.width !== undefined) {
				seen.add(node.id);
				reveal(resultRect(node));
			}
		}
		revealed.current = seen;
	}, [resultNodes, reveal]);

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
		// Une console dépliée reste attachée à sa table de départ.
		const attaches = entries.flatMap((entry): Edge[] =>
			shownConsoles.has(entry.id)
				? [
						{
							id: `attach:${entry.id}`,
							type: QUERY_LINK_EDGE,
							source: entry.root,
							sourceHandle: "right",
							target: entry.id,
							targetHandle: CONSOLE_TABLE_HANDLE,
							selectable: false,
							focusable: false,
							deletable: false,
							zIndex: 8
						}
					]
				: []
		);
		return [...lit, ...attaches, ...links];
	}, [edges, entries, activeId, resultNodes, shownConsoles]);

	// Un frame redimensionné porte une largeur et une hauteur explicites
	// (posées par le moteur au redimensionnement) : il le sait par `resized`.
	const sizedResults = useMemo(
		() =>
			resultNodes.map((n) => {
				const resized = n.width !== undefined && n.height !== undefined;
				return n.data.resized === resized
					? n
					: { ...n, data: { ...n.data, resized } };
			}),
		[resultNodes]
	);

	return {
		context,
		consoleNodes,
		resultNodes: sizedResults,
		onResultNodesChange,
		edges: shownEdges
	};
}
