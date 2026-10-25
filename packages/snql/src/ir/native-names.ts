/**
 * Noms natifs (ADR-029 D13, ADR-036 E/1f) : un champ du schéma peut être
 * stocké sous un autre nom que son nom SNQL — `id` alias de `_id` sous Mongo.
 * Après le lower, cette passe réécrit chaque référence vers le nom stocké,
 * garde le nom SNQL en sortie (alias des projections) et marque les scans,
 * jointures et insertions des collections concernées pour que le moteur
 * renomme les documents rendus entiers. Sans `nativeName` dans le schéma
 * (Postgres, MSSQL), le plan ressort inchangé.
 *
 * Idempotente : un nom déjà natif n'est pas un nom SNQL du schéma.
 */

import { SnqlError } from "../diagnostics";
import type { Collection, SchemaModel } from "../schema/model";
import type {
	LogicalPlan,
	MutationPlan,
	PlanColumnValue,
	PlanExpr,
	PlanNativeNames,
	PlanProjectField,
	PlanSortKey
} from "./plan";

interface Scope {
	/** Alias et noms de collection qualifiant un chemin (`u.id`, `users.id`). */
	readonly sources: ReadonlyMap<string, Collection>;
	/** Collection des chemins non qualifiés ; `undefined` après une projection. */
	readonly base: Collection | undefined;
}

/** Nom natif → nom SNQL des champs aliasés d'une collection. */
function nativeNamesOf(
	collection: Collection | undefined
): PlanNativeNames | undefined {
	const names: Record<string, string> = {};
	for (const f of collection?.fields ?? []) {
		if (f.nativeName !== undefined) names[f.nativeName] = f.name;
	}
	return Object.keys(names).length > 0 ? names : undefined;
}

function nativeOf(
	collection: Collection | undefined,
	name: string
): string | undefined {
	return collection?.fields.find((f) => f.name === name)?.nativeName;
}

function hasNativeNames(
	schema: SchemaModel | undefined
): schema is SchemaModel {
	return (
		schema?.collections.some((c) =>
			c.fields.some((f) => f.nativeName !== undefined)
		) ?? false
	);
}

function collectionOf(
	schema: SchemaModel,
	name: string
): Collection | undefined {
	return schema.collections.find((c) => c.name === name);
}

/** Chemin réécrit dans la chaîne de scopes (le plus interne d'abord). */
function rewritePath(
	path: readonly string[],
	scopes: readonly Scope[]
): readonly string[] {
	const [head, second, ...rest] = path;
	if (head === undefined) return path;
	for (const scope of scopes) {
		const qualified =
			second !== undefined ? scope.sources.get(head) : undefined;
		if (qualified !== undefined && second !== undefined) {
			const native = nativeOf(qualified, second);
			return native !== undefined ? [head, native, ...rest] : path;
		}
	}
	const base = scopes[0]?.base;
	const native = nativeOf(base, head);
	return native !== undefined ? [native, ...path.slice(1)] : path;
}

function rewriteExpr(
	expr: PlanExpr,
	scopes: readonly Scope[],
	schema: SchemaModel
): PlanExpr {
	const go = (e: PlanExpr) => rewriteExpr(e, scopes, schema);
	switch (expr.kind) {
		case "field": {
			const path = rewritePath(expr.path, scopes);
			return path === expr.path ? expr : { ...expr, path };
		}
		case "compare":
		case "and":
		case "or":
		case "arith":
			return { ...expr, left: go(expr.left), right: go(expr.right) };
		case "not":
		case "isNull":
		case "cast":
			return { ...expr, operand: go(expr.operand) };
		case "in":
			return { ...expr, target: go(expr.target), values: expr.values.map(go) };
		case "call":
			return {
				...expr,
				args: expr.args.map(go),
				...(expr.sortKeys !== undefined
					? { sortKeys: rewriteSortKeys(expr.sortKeys, scopes) }
					: {})
			};
		case "object":
			return {
				...expr,
				entries: expr.entries.map((e) => ({ ...e, value: go(e.value) }))
			};
		case "array":
			return { ...expr, items: expr.items.map(go) };
		case "case":
			return {
				...expr,
				branches: expr.branches.map((b) => ({
					cond: go(b.cond),
					value: go(b.value)
				})),
				elseValue: go(expr.elseValue)
			};
		case "windowCall":
			return {
				...expr,
				args: expr.args.map(go),
				partitionKeys: expr.partitionKeys.map((k) => rewritePath(k, scopes)),
				sortKeys: rewriteSortKeys(expr.sortKeys, scopes)
			};
		case "subquery":
			return { ...expr, plan: rewritePlan(expr.plan, schema, scopes).plan };
		case "exists":
			return {
				...expr,
				subplan: rewritePlan(expr.subplan, schema, scopes).plan
			};
		case "upsertNew": {
			const native = nativeOf(scopes[0]?.base, expr.column);
			return native !== undefined ? { ...expr, column: native } : expr;
		}
		default:
			return expr;
	}
}

function rewriteSortKeys(
	keys: readonly PlanSortKey[],
	scopes: readonly Scope[]
): readonly PlanSortKey[] {
	return keys.map((k) => {
		const path = rewritePath(k.path, scopes);
		return path === k.path ? k : { ...k, path };
	});
}

/** Champ projeté : le nom de sortie reste le nom SNQL. */
function rewriteProjectField(
	field: PlanProjectField,
	scopes: readonly Scope[],
	schema: SchemaModel
): PlanProjectField {
	const path =
		field.expr === undefined ? rewritePath(field.path, scopes) : field.path;
	const expr =
		field.expr !== undefined
			? rewriteExpr(field.expr, scopes, schema)
			: undefined;
	const alias =
		field.alias ??
		(path !== field.path ? field.path[field.path.length - 1] : undefined);
	return {
		...field,
		path,
		...(expr !== undefined ? { expr } : {}),
		...(alias !== undefined ? { alias } : {})
	};
}

function rewritePlan(
	plan: LogicalPlan,
	schema: SchemaModel,
	outer: readonly Scope[]
): { plan: LogicalPlan; scope: Scope } {
	if (plan.op === "scan") {
		const collection = collectionOf(schema, plan.collection);
		const sources = new Map<string, Collection>();
		if (collection !== undefined) {
			sources.set(plan.collection, collection);
			if (plan.alias !== undefined) sources.set(plan.alias, collection);
		}
		const nativeNames = nativeNamesOf(collection);
		return {
			plan: nativeNames !== undefined ? { ...plan, nativeNames } : plan,
			scope: { sources, base: collection }
		};
	}
	const { plan: input, scope } = rewritePlan(plan.input, schema, outer);
	const scopes = [scope, ...outer];
	switch (plan.op) {
		case "filter":
			return {
				plan: {
					...plan,
					input,
					predicate: rewriteExpr(plan.predicate, scopes, schema)
				},
				scope
			};
		case "sort":
			return {
				plan: { ...plan, input, keys: rewriteSortKeys(plan.keys, scopes) },
				scope
			};
		case "limit":
			return { plan: { ...plan, input }, scope };
		case "project":
			return {
				plan: {
					...plan,
					input,
					fields: plan.fields.map((f) =>
						rewriteProjectField(f, scopes, schema)
					),
					...(plan.distinctOnKeys !== undefined
						? {
								distinctOnKeys: plan.distinctOnKeys.map((k) =>
									rewritePath(k, scopes)
								)
							}
						: {})
				},
				scope: { sources: scope.sources, base: undefined }
			};
		case "aggregate":
			return {
				plan: {
					...plan,
					input,
					fields: plan.fields.map((f) =>
						rewriteProjectField(f, scopes, schema)
					),
					...(plan.groupKeys !== undefined
						? { groupKeys: plan.groupKeys.map((k) => rewritePath(k, scopes)) }
						: {})
				},
				scope: { sources: scope.sources, base: undefined }
			};
		case "join": {
			const joined = collectionOf(schema, plan.collection);
			const foreignScope: Scope = { sources: new Map(), base: joined };
			const nativeNames = nativeNamesOf(joined);
			const sources = new Map(scope.sources);
			if (joined !== undefined) sources.set(plan.as, joined);
			return {
				plan: {
					...plan,
					input,
					localField: rewritePath(plan.localField, scopes),
					foreignField: rewritePath(plan.foreignField, [foreignScope]),
					...(nativeNames !== undefined ? { nativeNames } : {})
				},
				scope: { sources, base: scope.base }
			};
		}
	}
}

/** Réécrit un plan de lecture vers les noms natifs du schéma. */
export function applyNativeNames(
	plan: LogicalPlan,
	schema: SchemaModel | undefined
): LogicalPlan {
	if (!hasNativeNames(schema)) return plan;
	return rewritePlan(plan, schema, []).plan;
}

/**
 * Colonne écrite : nom natif. Un champ aliasé ne se modifie pas — `_id` est
 * immuable sous Mongo (invariant de modèle, ADR-029 D13).
 */
function assignedColumn(
	collection: Collection | undefined,
	assignment: PlanColumnValue
): PlanColumnValue {
	const native = nativeOf(collection, assignment.column);
	if (native === undefined) return assignment;
	throw new SnqlError(
		`'${assignment.column}' est l'alias de '${native}', la clé primaire native de Mongo : sa valeur ne change pas après l'insertion`,
		"lower_update_native_key",
		assignment.value.span
	);
}

/** Réécrit une mutation vers les noms natifs du schéma. */
export function applyNativeNamesToMutation(
	plan: MutationPlan,
	schema: SchemaModel | undefined
): MutationPlan {
	if (!hasNativeNames(schema)) return plan;
	const collection = collectionOf(schema, plan.collection);
	const sources = new Map<string, Collection>();
	if (collection !== undefined) sources.set(plan.collection, collection);
	const column = (name: string) => nativeOf(collection, name) ?? name;
	if (plan.op === "insert") {
		const scopes: Scope[] = [{ sources, base: collection }];
		const nativeNames = nativeNamesOf(collection);
		return {
			...plan,
			columns: plan.columns.map(column),
			...(plan.onConflict !== undefined
				? {
						onConflict: {
							keys: plan.onConflict.keys.map(column),
							action:
								plan.onConflict.action.kind === "update"
									? {
											...plan.onConflict.action,
											assignments: plan.onConflict.action.assignments.map(
												(a) => ({
													...assignedColumn(collection, a),
													value: rewriteExpr(a.value, scopes, schema)
												})
											),
											...(plan.onConflict.action.where !== undefined
												? {
														where: rewriteExpr(
															plan.onConflict.action.where,
															scopes,
															schema
														)
													}
												: {})
										}
									: plan.onConflict.action
						}
					}
				: {}),
			...(plan.sourcePlan !== undefined
				? { sourcePlan: applyNativeNames(plan.sourcePlan, schema) }
				: {}),
			...(nativeNames !== undefined ? { nativeNames } : {})
		};
	}
	if (plan.op === "update") {
		if (plan.alias !== undefined && collection !== undefined) {
			sources.set(plan.alias, collection);
		}
		for (const join of plan.joins ?? []) {
			const joined = collectionOf(schema, join.collection);
			if (joined !== undefined) sources.set(join.as, joined);
		}
		const scopes: Scope[] = [{ sources, base: collection }];
		return {
			...plan,
			assignments: plan.assignments.map((a) => ({
				...assignedColumn(collection, a),
				value: rewriteExpr(a.value, scopes, schema)
			})),
			...(plan.predicate !== undefined
				? { predicate: rewriteExpr(plan.predicate, scopes, schema) }
				: {}),
			...(plan.joins !== undefined
				? {
						joins: plan.joins.map((j) => ({
							...j,
							localField: rewritePath(j.localField, scopes),
							foreignField: rewritePath(j.foreignField, [
								{ sources: new Map(), base: collectionOf(schema, j.collection) }
							])
						}))
					}
				: {})
		};
	}
	const scopes: Scope[] = [{ sources, base: collection }];
	return plan.predicate !== undefined
		? { ...plan, predicate: rewriteExpr(plan.predicate, scopes, schema) }
		: plan;
}
