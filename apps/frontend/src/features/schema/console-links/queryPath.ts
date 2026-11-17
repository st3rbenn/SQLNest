import type { Edge } from "@sqlnest/canvas";
import { DECLARED_EDGE } from "../canvas/relationEdge";

/** Ce qu'une requête dit des tables qu'elle traverse. */
export interface QueryPath {
	readonly root: string;
	readonly joined: readonly string[];
}

/** Épaisseur du chemin de la requête en cours, au-dessus des autres. */
const ACTIVE_WIDTH = 3;

/** Tables du chemin ; `null` sans jointure : il n'y a rien à allumer. */
function tablesOf(path: QueryPath): ReadonlySet<string> | null {
	const tables = new Set([path.root, ...path.joined]);
	return tables.size < 2 ? null : tables;
}

const joins = (tables: ReadonlySet<string>, edge: Edge): boolean =>
	tables.has(edge.source) && tables.has(edge.target);

/**
 * Allume les relations que traversent les requêtes des consoles dépliées :
 * entre la table de départ de chacune et ses tables jointes. Celle de la
 * requête en cours (`active`) ressort en plus épais.
 */
export function litQueryPaths(
	edges: Edge[],
	shown: readonly QueryPath[],
	active: QueryPath | undefined
): Edge[] {
	const strong = active === undefined ? null : tablesOf(active);
	const soft = shown.flatMap((path) => {
		const tables = path === active ? null : tablesOf(path);
		return tables === null ? [] : [tables];
	});
	if (strong === null && soft.length === 0) return edges;
	return edges.map((edge) => {
		const isActive = strong !== null && joins(strong, edge);
		if (!isActive && !soft.some((tables) => joins(tables, edge))) return edge;
		return {
			...edge,
			style: {
				...edge.style,
				stroke: DECLARED_EDGE,
				...(isActive ? { strokeWidth: ACTIVE_WIDTH } : {})
			},
			// Au-dessus des autres arêtes, sous les consoles dépliées.
			zIndex: 1
		};
	});
}
