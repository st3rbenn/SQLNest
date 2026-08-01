import type {
	FieldRef,
	Relation,
	RelationKind,
	RelationOrigin
} from "./schema-model";

/** "orders.user_id" (single) ou "orders.a, orders.b" (composite). */
export function formatColumns(ref: FieldRef): string {
	return ref.fields.map((f) => `${ref.collection}.${f}`).join(", ");
}

/** M:1 / 1:N / 1:1 — étiquette compacte pour le tooltip. */
export function formatKind(k: RelationKind): string {
	if (k === "many-to-one") return "N:1";
	if (k === "one-to-many") return "1:N";
	return "1:1";
}

/** Origine humanisée (le tooltip doit dire d'où vient la relation). */
export function formatOrigin(o: RelationOrigin): string {
	if (o === "foreign-key") return "FK déclarée";
	if (o === "naming-heuristic") return "inférée (nommage)";
	if (o === "ai") return "inférée (IA)";
	return "user";
}

/**
 * Preview SQL du join. Composite → conditions `AND` sur les paires
 * ordonnées `from.fields[i] = to.fields[i]`. Si les tailles diffèrent
 * (ne devrait pas), on fallback sur `to.fields[0]` pour ne pas planter.
 */
export function joinPreview(from: FieldRef, to: FieldRef): string {
	const conds = from.fields
		.map((f, i) => {
			const tf = to.fields[i] ?? to.fields[0] ?? f;
			return `${from.collection}.${f} = ${to.collection}.${tf}`;
		})
		.join(" AND ");
	return `JOIN ${to.collection} ON ${conds}`;
}

/**
 * Phrase humaine décrivant la relation, structurée pour permettre au
 * consommateur (tooltip UI) de mettre les noms de tables en gras.
 * - many-to-one → "Chaque {from} appartient à un {to}"
 * - one-to-many → "Un {from} a plusieurs {to}"
 * - one-to-one  → "Un {from} correspond à un {to}"
 */
export interface HumanRelation {
	readonly prefix: string;
	readonly from: string;
	readonly middle: string;
	readonly to: string;
}

export function humanRelation(rel: Relation): HumanRelation {
	const f = rel.from.collection;
	const t = rel.to.collection;
	if (rel.kind === "one-to-many") {
		return { prefix: "Un ", from: f, middle: " a plusieurs ", to: t };
	}
	if (rel.kind === "one-to-one") {
		return { prefix: "Un ", from: f, middle: " correspond à un ", to: t };
	}
	// many-to-one par défaut (cardinalité la plus fréquente).
	return { prefix: "Chaque ", from: f, middle: " appartient à un ", to: t };
}

/**
 * Origine humanisée en langage naturel (vs. `formatOrigin` qui garde le
 * vocabulaire technique "FK déclarée"). Utilisée dans la ligne secondaire
 * du tooltip friendly.
 */
export function humanOrigin(origin: Relation["origin"]): string {
	if (origin === "foreign-key") return "relation déclarée";
	if (origin === "naming-heuristic") return "détectée par nommage";
	if (origin === "ai") return "détectée par IA";
	return "définie manuellement";
}

/**
 * Ligne secondaire : "via {colonne(s)} · {origine}" (+ certitude si <100%
 * ET origine non-FK). Reste compacte, subordonnée à la phrase principale.
 */
export function humanFooter(rel: Relation): string {
	const cols = rel.from.fields.join(", ");
	const parts = [`via ${cols}`, humanOrigin(rel.origin)];
	if (rel.origin !== "foreign-key" && rel.confidence < 1) {
		parts.push(`certitude ${Math.round(rel.confidence * 100)}%`);
	}
	return parts.join(" · ");
}
