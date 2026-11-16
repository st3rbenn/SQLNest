import { type Edge, MarkerType } from "@sqlnest/canvas";
import type { SchemaModel } from "../schema-model";

// Gris au repos pour les FK déclarées, accent bleu quand l'arête est
// désignée (sélection, survol, table focalisée) : le bleu ne distingue une
// arête que s'il n'est pas partout. Jaune warning pour les liens inférés
// (jamais confirmés par la base). Tous lisibles sur `#1E1E1E`.
export const REST_EDGE = "#8c8c8c";
export const DECLARED_EDGE = "#0d99ff";
export const INFERRED_EDGE = "#ffc933";

/** Arête d'une relation du schéma : pleine pour une FK, pointillée pour un lien inféré. */
export function makeEdge(
	rel: SchemaModel["relations"][number],
	i: number
): Edge {
	const inferred = rel.origin !== "foreign-key";
	return {
		id: `e${i}-${rel.from.collection}-${rel.to.collection}`,
		source: rel.from.collection,
		target: rel.to.collection,
		// Custom edge type — dessine le path + expose des poignées drag aux
		// endpoints (voir `InteractiveEdge`).
		type: "fk",
		markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
		style: {
			stroke: inferred ? INFERRED_EDGE : REST_EDGE,
			strokeWidth: 1.5,
			strokeDasharray: inferred ? "5 4" : undefined
		},
		// `relation` intégral pour que le tooltip du hover puisse formater
		// les colonnes reliées, la kind/origine et le preview SQL du join.
		data: { inferred, relation: rel }
	};
}

/** Arêtes du schéma entre tables présentes (une relation pendante n'en a pas). */
export function relationEdges(schema: SchemaModel): Edge[] {
	const present = new Set(schema.collections.map((c) => c.name));
	return schema.relations.flatMap((rel, i) =>
		present.has(rel.from.collection) && present.has(rel.to.collection)
			? [makeEdge(rel, i)]
			: []
	);
}
