import { SnqlError } from "../diagnostics";
import type { FieldSelection, SortKey, Stage } from "../parser/ast";
import type { Relation, RelationKind, SchemaModel } from "../schema/model";
import {
	containsAggregateAst,
	containsWindowCallAst,
	refuseAggregateInPosition,
	validateAggregatePickFieldAst
} from "./lower-aggregates";
import { stripAlias } from "./lower-columns";
import { assertNoBareCallPredicate, lowerExpr } from "./lower-expr";
import type { LogicalPlan, PlanProjectField, PlanSortKey } from "./plan";

/**
 * Étapes du pipeline (`where`, `pick`, `with`, `sort`, …) et jointures :
 * orientation d'une relation, un ou plusieurs, clés de tri.
 */

export function lowerStage(
	input: LogicalPlan,
	stage: Stage,
	sourceCollection: string,
	sourceAlias: string | undefined,
	schema: SchemaModel | undefined,
	groupKeys?: readonly (readonly string[])[]
): LogicalPlan {
	switch (stage.type) {
		case "where": {
			assertNoBareCallPredicate(stage.predicate);
			const predicate = lowerExpr(stage.predicate);
			refuseAggregateInPosition(
				predicate,
				"lower_agg_in_where",
				"Aggregate dans 'where' non supporté — utilise 'having' après 'group by' pour filtrer les groupes"
			);
			return { op: "filter", input, predicate };
		}
		case "pick": {
			const fields = stage.fields.map(lowerField);
			assertUniqueProjectionKeys(fields);
			const hasAggregate = stage.fields.some(
				(f) => f.expr !== undefined && containsAggregateAst(f.expr)
			);
			// window fns et aggregates dans le même pick sont
			// exclusifs (2 stages logiques différents — un ORDER BY dans window
			// puis un fold aggregate n'a pas de sémantique naturelle).
			const hasWindowCall = stage.fields.some(
				(f) => f.expr !== undefined && containsWindowCallAst(f.expr)
			);
			if (hasAggregate && hasWindowCall) {
				throw new SnqlError(
					"Mix window function + aggregate dans le même pick non supporté — sépare en deux queries ou utilise une sub-query",
					"lower_window_agg_mix",
					stage.span
				);
			}
			if (hasWindowCall && groupKeys !== undefined) {
				throw new SnqlError(
					"Window function dans un pick après 'group by' non supporté — le group by change le shape des rows sur lequel la window opère",
					"lower_window_after_group",
					stage.span
				);
			}
			// DISTINCT / DISTINCT ON validations.
			if (
				(stage.unique === true || stage.distinctOnKeys !== undefined) &&
				groupKeys !== undefined
			) {
				throw new SnqlError(
					"'pick unique' et 'group by' non combinables — les deux dédup mais différemment ; utilise l'un ou l'autre",
					"lower_unique_with_group",
					stage.span
				);
			}
			if (
				(stage.unique === true || stage.distinctOnKeys !== undefined) &&
				hasAggregate
			) {
				throw new SnqlError(
					"'pick unique' avec aggregate non supporté — l'aggregate produit déjà une row par groupe, unique est redondant ou ambigu",
					"lower_unique_with_aggregate",
					stage.span
				);
			}
			if (
				(stage.unique === true || stage.distinctOnKeys !== undefined) &&
				hasWindowCall
			) {
				throw new SnqlError(
					"'pick unique' avec window function non supporté — les deux opèrent sur des rows différentes ; sépare en deux queries",
					"lower_unique_with_window",
					stage.span
				);
			}
			// groupKeys are alias-stripped already. Build the lookup set from them.
			const groupKeySet =
				groupKeys !== undefined
					? new Set(groupKeys.map((k) => k.join(".")))
					: undefined;
			if (hasAggregate || groupKeys !== undefined) {
				for (const f of stage.fields) {
					if (f.expr !== undefined) {
						validateAggregatePickFieldAst(f.expr, groupKeySet, sourceAlias);
					} else if (f.path.length > 0) {
						// Strip source alias so `u.year` matches groupKey `year`.
						const strippedPath = stripAlias(f.path, sourceAlias).join(".");
						if (groupKeySet !== undefined && groupKeySet.has(strippedPath)) {
							continue;
						}
						const pathStr = f.path.join(".");
						throw new SnqlError(
							groupKeys !== undefined
								? `Champ '${pathStr}' n'est ni une clé de group by ni dans un aggregate — ajoute '${pathStr}' à group by ou wrappe en min(${pathStr})`
								: `Champ '${pathStr}' hors argument d'un aggregate — utilise 'group by ${pathStr}' ou wrappe en min(${pathStr})`,
							"planner_agg_bare_field_needs_group",
							f.span
						);
					}
				}
				return groupKeys !== undefined
					? { op: "aggregate", input, fields, groupKeys }
					: { op: "aggregate", input, fields };
			}
			// distinctOnKeys — strip source alias sur les paths
			// (alignés fields projetés + sort keys). Puis check chaque key
			// APPARAIT dans les fields projetés (parité PG DISTINCT ON — sinon
			// la key n'a pas de valeur à comparer post-projection).
			const strippedDistinctKeys =
				stage.distinctOnKeys !== undefined
					? stage.distinctOnKeys.map((k) => stripAlias(k, sourceAlias))
					: undefined;
			if (strippedDistinctKeys !== undefined) {
				const fieldOutputNames = new Set(
					fields.map((f) => f.alias ?? f.path[f.path.length - 1] ?? "")
				);
				for (const [i, k] of strippedDistinctKeys.entries()) {
					const keyStr = k.join(".");
					// La key peut matcher soit un output alias, soit le dernier
					// segment d'un field path projeté.
					const lastSeg = k[k.length - 1] ?? "";
					if (!fieldOutputNames.has(keyStr) && !fieldOutputNames.has(lastSeg)) {
						throw new SnqlError(
							`'unique on (${keyStr})' — key '${keyStr}' absente des fields projetés ; ajoute '${keyStr}' à pick ou retire-la de 'on'`,
							"lower_unique_on_key_not_projected",
							stage.distinctOnKeys![i]!.length > 0 ? stage.span : stage.span
						);
					}
				}
			}
			return {
				op: "project",
				input,
				fields,
				...(stage.unique === true ? { unique: true as const } : {}),
				...(strippedDistinctKeys !== undefined
					? { distinctOnKeys: strippedDistinctKeys }
					: {})
			};
		}
		case "sort":
			return {
				op: "sort",
				input,
				keys: stage.keys.map((k) =>
					lowerSortKey(k, sourceCollection, sourceAlias, schema)
				)
			};
		case "limit":
			return stage.offset !== undefined
				? { op: "limit", input, count: stage.count, offset: stage.offset }
				: { op: "limit", input, count: stage.count };
		case "with": {
			// localField vient de la source (strip son alias), foreignField de la collection jointe.
			const localField = stripAlias(stage.localField, sourceAlias);
			const foreignField = stripAlias(
				stage.foreignField,
				stage.alias ?? stage.collection
			);
			// Reverse-nav agrégé (FK/2b) : `aggregate: count` force le kind scalaire,
			// court-circuite l'inférence embed/join.
			const kind =
				stage.aggregate === "count"
					? ("count" as const)
					: resolveJoinKind(
							sourceCollection,
							stage.collection,
							localField,
							foreignField,
							stage.multiplicity,
							schema
						);
			return {
				op: "join",
				input,
				collection: stage.collection,
				as: stage.alias ?? stage.collection,
				localField,
				foreignField,
				kind
			};
		}
		case "group":
		case "having":
			// ces stages sont consommés dans la boucle lower()
			// n'arrivent jamais ici (defense-in-depth pour l'exhaustivité TS).
			throw new SnqlError(
				`Stage '${stage.type}' consommé en amont — bug lower/parser sync`,
				"lower_stage_leaked"
			);
	}
}

/**
 * Choix de la multiplicité d'un join. Ordre :
 * 1. Mot-clé utilisateur (`with one X` / `with many X`) — override total.
 * 2. Inférence via [[SchemaModel]] : cherche une relation matchant
 *    (source, joined, localField, foreignField) dans les deux orientations,
 *    lit le `kind`, l'oriente depuis la source. many-to-one/one-to-one → `join`,
 *    one-to-many/many-to-many → `embed`.
 * 3. Fallback `embed` — comportement historique, ne casse pas l'existant quand
 *    l'introspection n'a pas tourné ou n'a pas trouvé la FK.
 */
function resolveJoinKind(
	sourceCollection: string,
	joinedCollection: string,
	localField: readonly string[],
	foreignField: readonly string[],
	multiplicity: "one" | "many" | undefined,
	schema: SchemaModel | undefined
): "embed" | "join" {
	if (multiplicity === "one") {
		return "join";
	}
	if (multiplicity === "many") {
		return "embed";
	}
	if (schema === undefined) {
		return "embed";
	}
	for (const rel of schema.relations) {
		const oriented = orientRelation(
			rel,
			sourceCollection,
			joinedCollection,
			localField,
			foreignField
		);
		if (oriented !== undefined) {
			return oriented === "one-to-one" || oriented === "many-to-one"
				? "join"
				: "embed";
		}
	}
	return "embed";
}

/**
 * Une relation matche notre join ssi ses collections et fields correspondent
 * dans l'une des deux orientations. Retourne le `kind` **du POV de la source**
 * (inversé si la relation est écrite dans l'autre sens).
 */
function orientRelation(
	rel: Relation,
	source: string,
	joined: string,
	localField: readonly string[],
	foreignField: readonly string[]
): RelationKind | undefined {
	if (
		rel.from.collection === source &&
		rel.to.collection === joined &&
		fieldsEqual(rel.from.fields, localField) &&
		fieldsEqual(rel.to.fields, foreignField)
	) {
		return rel.kind;
	}
	if (
		rel.to.collection === source &&
		rel.from.collection === joined &&
		fieldsEqual(rel.to.fields, localField) &&
		fieldsEqual(rel.from.fields, foreignField)
	) {
		return invertKind(rel.kind);
	}
	return undefined;
}

function invertKind(kind: RelationKind): RelationKind {
	if (kind === "many-to-one") return "one-to-many";
	if (kind === "one-to-many") return "many-to-one";
	// one-to-one et many-to-many sont symétriques.
	return kind;
}

function fieldsEqual(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function lowerField(field: FieldSelection): PlanProjectField {
	if (field.expr !== undefined) {
		// Contrat vérifié au parser mais on double-check ici (l'IR est le contrat).
		if (field.alias === undefined) {
			throw new SnqlError(
				"Une expression projetée exige un alias",
				"lower_pick_expr_alias"
			);
		}
		return { path: [], expr: lowerExpr(field.expr), alias: field.alias };
	}
	return field.alias !== undefined
		? { path: field.path, alias: field.alias }
		: { path: field.path };
}

/** Nom de sortie d'une projection = alias, sinon dernier segment du chemin. Doivent être uniques. */
function assertUniqueProjectionKeys(fields: readonly PlanProjectField[]): void {
	const seen = new Set<string>();
	for (const field of fields) {
		const key = field.alias ?? field.path[field.path.length - 1] ?? "";
		if (seen.has(key)) {
			throw new SnqlError(
				`Colonne de projection dupliquée '${key}' — désambiguïsez avec un alias (… as …)`,
				"lower_duplicate_projection"
			);
		}
		seen.add(key);
	}
}

function lowerSortKey(
	key: SortKey,
	sourceCollection: string,
	sourceAlias: string | undefined,
	schema: SchemaModel | undefined
): PlanSortKey {
	const provablyNotNull = sortKeyProvablyNotNull(
		key.path,
		sourceCollection,
		sourceAlias,
		schema
	);
	return {
		path: key.path,
		direction: key.direction,
		...(provablyNotNull ? { provablyNotNull: true } : {})
	};
}

/**
 * Vrai ssi la clé de tri est une colonne SIMPLE de la source déclarée
 * `nullable: false` (ADR-032). Conservateur : path imbriqué, alias joint,
 * computed alias, ou schema absent → false (→ le codegen émet le null-rank de
 * parité). On strip un préfixe = alias de la source (`sort u.x` où la source
 * est `... as u`).
 */
function sortKeyProvablyNotNull(
	path: readonly string[],
	sourceCollection: string,
	sourceAlias: string | undefined,
	schema: SchemaModel | undefined
): boolean {
	if (schema === undefined) return false;
	let segs = path;
	if (sourceAlias !== undefined && segs.length > 1 && segs[0] === sourceAlias) {
		segs = segs.slice(1);
	}
	if (segs.length !== 1) return false; // imbriqué / joint → inconnu
	const coll = schema.collections.find((c) => c.name === sourceCollection);
	const field = coll?.fields.find((f) => f.name === segs[0]);
	return field?.nullable === false;
}
