/**
 * FK/2a forward-nav (ADR-031 D6). Sucre syntaxique : `find orders pick user.name`
 * désugarise en `find orders with users on user_id = id as user pick user.name`
 * — le `with` flat-join (multiplicity "one") + la résolution `alias.field`
 * existent déjà ([[ADR-008]] join). On se contente d'INJECTER le `with` quand un
 * path `X.Y` référence une FK sortante dont le nom de nav (`fromColumn` sans
 * suffixe `_id`) vaut `X`, et que `X` n'est ni une colonne locale ni un alias déjà
 * déclaré. Aucune sémantique nouvelle côté codegen — tout retombe sur le join.
 */

import type { Expr, FieldSelection, Query, Stage } from "../parser/ast";
import {
	getIncomingRefs,
	getOutgoingRefs,
	type RefDef,
	type SchemaModel
} from "../schema/model";

/** Nom de nav d'une FK sortante : `user_id` → `user`, `parent_id` → `parent`. */
function navNameOf(ref: RefDef): string {
	return ref.fromColumn.replace(/_id$/, "");
}

/** Collecte les paths de champ d'un `Expr` (walk récursif) pour détecter un nav
 * en position where/having/computed-pick. Les noeuds sans champ outer (literal,
 * subquery, exists) sont ignorés. */
function collectExprPaths(expr: Expr, out: (readonly string[])[]): void {
	switch (expr.type) {
		case "field":
			out.push(expr.path);
			return;
		case "compare":
		case "logical":
		case "arith":
			collectExprPaths(expr.left, out);
			collectExprPaths(expr.right, out);
			return;
		case "not":
			collectExprPaths(expr.operand, out);
			return;
		case "in":
			collectExprPaths(expr.target, out);
			for (const v of expr.values) collectExprPaths(v, out);
			return;
		case "call":
		case "windowCall":
			for (const a of expr.args) collectExprPaths(a, out);
			return;
		case "cast":
			collectExprPaths(expr.operand, out);
			return;
		case "object":
			for (const e of expr.entries) collectExprPaths(e.value, out);
			return;
		case "array":
			for (const i of expr.items) collectExprPaths(i, out);
			return;
		case "case":
			for (const b of expr.branches) {
				collectExprPaths(b.cond, out);
				collectExprPaths(b.value, out);
			}
			collectExprPaths(expr.elseValue, out);
			return;
		default:
			return;
	}
}

/** Tous les paths de champ des stages (pick/where/having/sort/group). */
function collectStagePaths(query: Query): (readonly string[])[] {
	const paths: (readonly string[])[] = [];
	for (const st of query.stages) {
		switch (st.type) {
			case "pick":
				for (const f of st.fields) {
					if (f.path.length > 0) paths.push(f.path);
					if (f.expr !== undefined) collectExprPaths(f.expr, paths);
				}
				break;
			case "where":
			case "having":
				collectExprPaths(st.predicate, paths);
				break;
			case "sort":
				for (const k of st.keys) paths.push(k.path);
				break;
			case "group":
				for (const k of st.keys) paths.push(k.path);
				break;
			default:
				break;
		}
	}
	return paths;
}

/**
 * Injecte les `with` implicites pour les forward-navs utilisés. Idempotent :
 * sans schéma / sans FK sortante / sans nav référencé → renvoie la query
 * inchangée. Les joins injectés sont préfixés (bloc `with` en tête, ordre
 * canonique préservé).
 */
export function desugarForwardNav(query: Query, schema?: SchemaModel): Query {
	if (schema === undefined) return query;
	const outgoing = getOutgoingRefs(schema, query.source.collection);
	if (outgoing.length === 0) return query;

	const sourceCol = schema.collections.find(
		(c) => c.name === query.source.collection
	);
	const localFields = new Set(sourceCol?.fields.map((f) => f.name) ?? []);

	const existingAliases = new Set<string>();
	if (query.source.alias !== undefined) existingAliases.add(query.source.alias);
	for (const st of query.stages) {
		if (st.type === "with") existingAliases.add(st.alias ?? st.collection);
	}

	// navName → ref, en excluant les collisions avec colonnes/alias existants
	// (un nav ne shadow jamais une vraie colonne ni un join que l'user a écrit).
	const navMap = new Map<string, RefDef>();
	for (const ref of outgoing) {
		const nav = navNameOf(ref);
		if (localFields.has(nav) || existingAliases.has(nav)) continue;
		if (!navMap.has(nav)) navMap.set(nav, ref);
	}
	if (navMap.size === 0) return query;

	const used = new Map<string, RefDef>();
	for (const path of collectStagePaths(query)) {
		if (path.length < 2) continue;
		const head = path[0];
		if (head === undefined) continue;
		if (localFields.has(head) || existingAliases.has(head)) continue;
		const ref = navMap.get(head);
		if (ref !== undefined) used.set(head, ref);
	}
	if (used.size === 0) return query;

	const injected: Stage[] = [];
	for (const [nav, ref] of used) {
		injected.push({
			type: "with",
			collection: ref.toCollection,
			alias: nav,
			localField: [ref.fromColumn],
			foreignField: [ref.toColumn],
			// forward FK = many→one : flat join, alias.field résolvable.
			multiplicity: "one",
			span: query.source.span
		});
	}
	return { ...query, stages: [...injected, ...query.stages] };
}

/**
 * Reverse-nav agrégé (ADR-031 D7, FK/2b) : `find users pick orders.count`
 * désugarise en un join `aggregate: count` corrélé (count des lignes de la
 * collection référençante par ligne source) + réécrit le pick vers l'alias
 * scalaire `<coll>_count`. `orders` = fromCollection d'une FK ENTRANTE vers la
 * source (orders.user_id → users). V1 = suffixe `.count` uniquement.
 */
export function desugarReverseNav(query: Query, schema?: SchemaModel): Query {
	if (schema === undefined) return query;
	const incoming = getIncomingRefs(schema, query.source.collection);
	if (incoming.length === 0) return query;

	// Nom reverse (fromCollection) → ref entrante. Premier match gagne.
	const revMap = new Map<string, RefDef>();
	for (const ref of incoming) {
		if (!revMap.has(ref.fromCollection)) revMap.set(ref.fromCollection, ref);
	}

	const injected = new Map<string, Stage>();
	let touched = false;
	const stages: Stage[] = query.stages.map((st) => {
		if (st.type !== "pick") return st;
		const fields: FieldSelection[] = st.fields.map((f) => {
			// `orders.count` : path length 2, head = reverse-coll, tail = "count".
			if (
				f.expr === undefined &&
				f.path.length === 2 &&
				f.path[1] === "count"
			) {
				const revColl = f.path[0]!;
				const ref = revMap.get(revColl);
				if (ref !== undefined) {
					const alias = `${revColl}_count`;
					if (!injected.has(alias)) {
						injected.set(alias, {
							type: "with",
							collection: ref.fromCollection,
							alias,
							// source (users) ← count des orders : local = toColumn (id),
							// foreign = fromColumn (user_id).
							localField: [ref.toColumn],
							foreignField: [ref.fromColumn],
							aggregate: "count",
							span: f.span
						});
					}
					touched = true;
					return {
						path: [alias],
						alias: f.alias ?? alias,
						span: f.span
					};
				}
			}
			return f;
		});
		return { ...st, fields };
	});
	if (!touched) return query;
	return { ...query, stages: [...injected.values(), ...stages] };
}
