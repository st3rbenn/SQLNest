import { SnqlError } from "../diagnostics";
import { SNQL_FUNCTIONS } from "../functions";
import type { LogicalPlan, PlanExpr, PlanProjectField } from "../ir/plan";
import type { MongoStage } from "./mapper";
import {
	ARITH_TO_MONGO,
	bsonValue,
	MONGO_OP,
	mongoField,
	mongoRenderCast,
	toExprOperand
} from "./mongodb-expr";
import { defined } from "../invariant";

/**
 * Agrégats et `group by` : étapes `$group`, `$setWindowFields`, `distinct`.
 */

/**
 * SSA extract pour un stage aggregate. Décompose les fields en :
 *  - `groupStage` : {_id: null, __agg_0: {$sum:...}, __agg_1: {$avg:...}, ...}
 *  - `projectStage` : {_id: 0, <alias>: <expr>, ...} — chaque expression
 *    référence les slots __agg_N via `$__agg_N`.
 *
 * Déduplication : clé stable = name + JSON.stringify(argsCanonical) + flags.
 * Deux fields référençant `sum(x)` partagent le même slot.
 *
 * count(unique x) : 2-stage hardcodé — $addToSet dans $group (filtre NULL via
 * $cond+$$REMOVE pour parité PG COUNT(DISTINCT)), $size dans $project.
 * sum(unique)/avg(unique) refusés au planner (planner_agg_unique_mongo_...).
 */
export function renderAggregatePipeline(
	fields: readonly PlanProjectField[],
	alias: string | undefined,
	groupKeys?: readonly (readonly string[])[],
	having?: PlanExpr
): {
	groupStage: Record<string, unknown>;
	projectStage: Record<string, unknown>;
	havingExpr?: unknown;
	havingSlots: readonly string[];
} {
	// _id = null si pas de group by, sinon flat object
	// {<lastSeg>: '$<path>'} — noms canoniques stables cross-key. Un mono-key
	// `group by year` → `_id: {year: '$year'}`. Multi-key `group by year, code`
	// → `_id: {year: '$year', code: '$code'}`.
	const groupIdInner: Record<string, unknown> = {};
	if (groupKeys !== undefined) {
		for (const key of groupKeys) {
			const lastSeg = key[key.length - 1] as string;
			groupIdInner[lastSeg] = `$${mongoField(key, alias)}`;
		}
	}
	const groupStage: Record<string, unknown> =
		groupKeys !== undefined ? { _id: groupIdInner } : { _id: null };
	const projectStage: Record<string, unknown> = { _id: 0 };
	// projette les groupKeys depuis _id via `$_id.<lastSeg>`.
	if (groupKeys !== undefined) {
		for (const key of groupKeys) {
			const lastSeg = key[key.length - 1] as string;
			projectStage[lastSeg] = `$_id.${lastSeg}`;
		}
	}
	const slotByKey = new Map<string, string>();
	let slotCounter = 0;
	let uSlotCounter = 0;

	function aggKeyOf(expr: PlanExpr & { kind: "call" }): string {
		// Clé de dédup stable — strip les spans en canonicalisant récursivement.
		return JSON.stringify({
			name: expr.name,
			args: expr.args.map(canonicalizeExpr),
			star: expr.star === true,
			unique: expr.unique === true
		});
	}

	function canonicalizeExpr(e: PlanExpr): unknown {
		if (e.kind === "literal") return { k: "literal", v: e.value };
		if (e.kind === "field") return { k: "field", p: e.path };
		if (e.kind === "call")
			return {
				k: "call",
				n: e.name,
				a: e.args.map(canonicalizeExpr),
				s: e.star === true,
				u: e.unique === true
			};
		if (e.kind === "arith")
			return {
				k: "arith",
				o: e.op,
				l: canonicalizeExpr(e.left),
				r: canonicalizeExpr(e.right)
			};
		if (e.kind === "cast")
			return { k: "cast", t: e.target, o: canonicalizeExpr(e.operand) };
		return { k: e.kind };
	}

	/**
	 * wrap le slot d'un aggregateMulti avec le post-processing
	 * approprié (sortArray + string_agg reduce). Appliqué en $project après
	 * le $group.
	 *
	 * - array_agg / json_agg : `$__agg_N` direct, ou `{$sortArray: {input, sortBy}}`
	 *   si sortKeys.
	 * - string_agg : reduce avec sep, filter NULL, éventuel sortArray.
	 */
	function wrapAggregateMultiSlot(
		call: PlanExpr & { kind: "call" },
		slot: string
	): unknown {
		const slotRef = `$${slot}`;
		// Sort intra-call : $sortArray (MongoDB 5.2+). sortBy = Record<string, 1|-1>.
		// Note : les sort keys référencent des paths SUR LES DOCS DU BUCKET
		// (pas sur la valeur pushée). Mongo permet ça via $sortArray car chaque
		// élément est un doc/scalar dont on lit le path.
		let base: unknown = slotRef;
		if (call.sortKeys !== undefined && call.sortKeys.length > 0) {
			const sortBy: Record<string, 1 | -1> = {};
			for (const k of call.sortKeys) {
				const path = k.path.join(".");
				sortBy[path] = k.direction === "desc" ? -1 : 1;
			}
			base = { $sortArray: { input: slotRef, sortBy } };
		}
		// string_agg : filter NULL puis $reduce avec sep.
		if (call.name === "string_agg") {
			const sep = call.args[1];
			if (sep === undefined) {
				throw new SnqlError(
					"string_agg attend 2 args (expr, sep) — bug lower/codegen",
					"codegen_mongo_string_agg_arity"
				);
			}
			const sepRendered = toExprOperand(sep, alias);
			// $filter pour skip null (parité PG STRING_AGG).
			const filtered = {
				$filter: {
					input: base,
					cond: { $ne: ["$$this", null] }
				}
			};
			// $reduce : join avec sep. Cast $$this en string via $toString.
			// Init "" ; premier elem → juste sa string ; suivants → $$value + sep + $$this.
			return {
				$cond: {
					if: { $eq: [{ $size: filtered }, 0] },
					then: null,
					else: {
						$reduce: {
							input: filtered,
							initialValue: "",
							in: {
								$cond: [
									{ $eq: ["$$value", ""] },
									{ $toString: "$$this" },
									{
										$concat: [
											"$$value",
											{ $toString: sepRendered },
											{ $toString: "$$this" }
										]
									}
								]
							}
						}
					}
				}
			};
		}
		// array_agg / json_agg : le slot (possibly sorted) direct.
		return base;
	}

	function transformExpr(expr: PlanExpr, insideAggArg: boolean): unknown {
		if (expr.kind === "call") {
			const entry = SNQL_FUNCTIONS.get(expr.name);
			if (entry?.kind === "aggregate" || entry?.kind === "aggregateMulti") {
				// Aggregate nested dans un arg d'agg → refusé au lower (defense).
				if (insideAggArg) {
					throw new SnqlError(
						`Aggregate imbriqué '${expr.name}(...)' — bug de sync lower/codegen (lower_agg_nested attendu)`,
						"codegen_mongo_agg_nested",
						expr.span
					);
				}
				const key = aggKeyOf(expr as PlanExpr & { kind: "call" });
				// count/sum/avg(unique x) : 2-stage $addToSet + fold hardcodé.
				// item #5 : sum(unique) et avg(unique) réutilisent le
				// même pattern SSA que count(unique) — le slot uSet stocke un set
				// des valeurs distinctes non-null, le project fold via $size / $sum /
				// $avg selon la fonction.
				if (
					expr.unique === true &&
					(expr.name === "count" || expr.name === "sum" || expr.name === "avg")
				) {
					const foldOf = (slot: string): Record<string, unknown> => {
						if (expr.name === "count") return { $size: `$${slot}` };
						if (expr.name === "sum") return { $sum: `$${slot}` };
						return { $avg: `$${slot}` };
					};
					const existing = slotByKey.get(key);
					if (existing !== undefined) return foldOf(existing);
					const argRendered = toExprOperand(defined(expr.args[0]), alias);
					const uSlot = `__u_${uSlotCounter}`;
					uSlotCounter += 1;
					slotByKey.set(key, uSlot);
					groupStage[uSlot] = {
						$addToSet: {
							$cond: [{ $ne: [argRendered, null] }, argRendered, "$$REMOVE"]
						}
					};
					return foldOf(uSlot);
				}
				// Cas standard : appel du renderer aggregate (accumulator body).
				const existing = slotByKey.get(key);
				if (existing !== undefined) return `$${existing}`;
				if (entry.engines.mongodb === undefined) {
					throw new SnqlError(
						`Fonction '${expr.name}' : renderer MongoDB absent du registre`,
						"codegen_missing_function_mapping"
					);
				}
				const accBody = entry.engines.mongodb(expr.args, {
					renderExpr: (arg) => toExprOperand(arg as PlanExpr, alias),
					...(expr.star === true ? { star: true } : {}),
					...(expr.unique === true ? { unique: true } : {})
				});
				const slot = `__agg_${slotCounter}`;
				slotCounter += 1;
				slotByKey.set(key, slot);
				groupStage[slot] = accBody as Record<string, unknown>;
				// post-processing aggregateMulti — $sortArray si
				// sortKeys, $reduce pour string_agg (concat), $filter pour
				// string_agg NULL-skip.
				if (entry.kind === "aggregateMulti") {
					return wrapAggregateMultiSlot(
						expr as PlanExpr & { kind: "call" },
						slot
					);
				}
				return `$${slot}`;
			}
			// Scalar call. Args passent via transformExpr (catch nested aggregates
			// dans coalesce(sum(x), 0) → sum(x) devient '$__agg_0', 0 reste literal).
			if (entry?.engines.mongodb === undefined) {
				throw new SnqlError(
					`Fonction '${expr.name}' : renderer MongoDB absent du registre`,
					"codegen_missing_function_mapping"
				);
			}
			return entry.engines.mongodb(expr.args, {
				renderExpr: (arg) => transformExpr(arg as PlanExpr, insideAggArg)
			});
		}
		if (expr.kind === "literal") {
			const value = bsonValue(expr.value);
			return typeof value === "string" && value.startsWith("$")
				? { $literal: value }
				: value;
		}
		if (expr.kind === "field") {
			// Field bare dans un pick agg field.expr → normalement refusé au lower
			// (lower_bare_field_in_agg_scalar_wrapper). Defense : rendu direct.
			return `$${mongoField(expr.path, alias)}`;
		}
		if (expr.kind === "arith") {
			return {
				[ARITH_TO_MONGO[expr.op]]: [
					transformExpr(expr.left, insideAggArg),
					transformExpr(expr.right, insideAggArg)
				]
			};
		}
		if (expr.kind === "cast") {
			// #7 : cast(_ as json) no-op sur Mongo (BSON = JSON natif),
			// squiggly INFO éditeur alerte sur `cast(str as json)` (trap type).
			// cast(<string literal> as json) parsé au lower vers
			// object/array literal — l'operand est déjà transformé. mongoRenderCast
			// centralise le rendu ($dateTrunc pour target="date", $convert sinon).
			const inner = transformExpr(expr.operand, insideAggArg);
			return mongoRenderCast(inner, expr.target, expr.operand.kind === "field");
		}
		if (expr.kind === "object") {
			const out: Record<string, unknown> = {};
			for (const e of expr.entries) {
				out[e.key] = transformExpr(e.value, insideAggArg);
			}
			return out;
		}
		if (expr.kind === "array") {
			return expr.items.map((i) => transformExpr(i, insideAggArg));
		}
		if (expr.kind === "case") {
			return {
				$switch: {
					branches: expr.branches.map((b) => ({
						case: transformExpr(b.cond, insideAggArg),
						then: transformExpr(b.value, insideAggArg)
					})),
					default: transformExpr(expr.elseValue, insideAggArg)
				}
			};
		}
		if (expr.kind === "compare") {
			return {
				[MONGO_OP[expr.op]]: [
					transformExpr(expr.left, insideAggArg),
					transformExpr(expr.right, insideAggArg)
				]
			};
		}
		if (expr.kind === "and") {
			return {
				$and: [
					transformExpr(expr.left, insideAggArg),
					transformExpr(expr.right, insideAggArg)
				]
			};
		}
		if (expr.kind === "or") {
			return {
				$or: [
					transformExpr(expr.left, insideAggArg),
					transformExpr(expr.right, insideAggArg)
				]
			};
		}
		if (expr.kind === "not") {
			return { $not: transformExpr(expr.operand, insideAggArg) };
		}
		if (expr.kind === "isNull") {
			const op = expr.negated ? "$ne" : "$eq";
			return {
				[op]: [transformExpr(expr.operand, insideAggArg), null]
			};
		}
		if (expr.kind === "in") {
			return {
				$in: [
					transformExpr(expr.target, insideAggArg),
					expr.values.map((v) => transformExpr(v, insideAggArg))
				]
			};
		}
		throw new SnqlError(
			"Opérande non supporté dans une pipeline agrégée Mongo",
			"codegen_mongo_agg_expr"
		);
	}

	// lookup rapide pour reconnaître les path-only fields comme
	// group keys — alias-stripped, dernière-seg = clé du _id.
	const groupKeyLastSegs = new Set<string>();
	if (groupKeys !== undefined) {
		for (const k of groupKeys) {
			const last = k[k.length - 1];
			if (last !== undefined) groupKeyLastSegs.add(last);
		}
	}
	// map key stable (fully-qualified last-seg join) → project
	// alias name — utile pour having qui référence les aggregates par leur
	// alias post-$project. Peuplé au fur et à mesure de la traversée des fields.
	const aggKeyToProjectAlias = new Map<string, string>();

	for (const field of fields) {
		const aliasName = (field.alias ??
			field.path[field.path.length - 1]) as string;
		if (field.expr !== undefined) {
			// Enregistrer le mapping aggKey → aliasName si le top-level expr est un agg
			// direct : permet à having de le référencer via `$<alias>`.
			if (field.expr.kind === "call") {
				const entry = SNQL_FUNCTIONS.get(field.expr.name);
				if (entry?.kind === "aggregate") {
					aggKeyToProjectAlias.set(
						aggKeyOf(field.expr as PlanExpr & { kind: "call" }),
						aliasName
					);
				}
			}
			projectStage[aliasName] = transformExpr(field.expr, false);
		} else if (field.path.length > 0) {
			const stripped = mongoField(field.path, alias);
			const lastSeg = field.path[field.path.length - 1] as string;
			if (groupKeys !== undefined && groupKeyLastSegs.has(lastSeg)) {
				if (aliasName !== lastSeg) {
					projectStage[aliasName] = `$_id.${lastSeg}`;
					// Clé `_id` renommée (alias `id`, ADR-036 E/1f) : elle ne sort
					// que sous son alias.
					if (lastSeg === "_id") projectStage._id = 0;
				}
			} else {
				throw new SnqlError(
					`Field bare '${stripped}' dans un pick agg — bug de sync lower/codegen`,
					"codegen_mongo_agg_bare_field"
				);
			}
		} else {
			throw new SnqlError(
				`Field bare vide dans un pick agg — bug de sync lower/codegen`,
				"codegen_mongo_agg_bare_field"
			);
		}
	}

	// traverse having pour extraire ses aggregates (partagent le
	// slot map). Field refs matchant un group key → `$<lastSeg>` post-project.
	// Aggregates avec alias existant → `$<alias>` ; sinon nouveau slot projeté
	// nommé __hslot_N (unset après $match).
	const havingSlots: string[] = [];
	let havingSlotCounter = 0;

	function transformHaving(expr: PlanExpr): unknown {
		if (expr.kind === "call") {
			const entry = SNQL_FUNCTIONS.get(expr.name);
			if (entry?.kind === "aggregate") {
				const key = aggKeyOf(expr as PlanExpr & { kind: "call" });
				const existingAlias = aggKeyToProjectAlias.get(key);
				if (existingAlias !== undefined) {
					return `$${existingAlias}`;
				}
				// Force extraction dans groupStage (via transformExpr), puis assign
				// à un slot projeté anonyme.
				const raw = transformExpr(expr, false);
				const hSlot = `__hslot_${havingSlotCounter}`;
				havingSlotCounter += 1;
				projectStage[hSlot] = raw;
				havingSlots.push(hSlot);
				aggKeyToProjectAlias.set(key, hSlot);
				return `$${hSlot}`;
			}
			// Scalar call — args passent par transformHaving pour catcher aggregates
			// nested (ex: coalesce(sum(x), 0) > 100 dans having).
			if (entry?.engines.mongodb === undefined) {
				throw new SnqlError(
					`Fonction '${expr.name}' : renderer MongoDB absent du registre`,
					"codegen_missing_function_mapping"
				);
			}
			return entry.engines.mongodb(expr.args, {
				renderExpr: (arg) => transformHaving(arg as PlanExpr)
			});
		}
		if (expr.kind === "field") {
			// Field bare dans having doit référencer une group key (validé lower).
			// Après $project, la group key est top-level sous son lastSeg.
			const lastSeg = expr.path[expr.path.length - 1] as string;
			if (groupKeys !== undefined && groupKeyLastSegs.has(lastSeg)) {
				return `$${lastSeg}`;
			}
			// Defense — arriver ici = bug lower.
			throw new SnqlError(
				`Field bare '${expr.path.join(".")}' dans having sans group key correspondante — bug lower/codegen`,
				"codegen_mongo_having_bare_field"
			);
		}
		if (expr.kind === "literal") {
			const value = bsonValue(expr.value);
			return typeof value === "string" && value.startsWith("$")
				? { $literal: value }
				: value;
		}
		if (expr.kind === "arith") {
			return {
				[ARITH_TO_MONGO[expr.op]]: [
					transformHaving(expr.left),
					transformHaving(expr.right)
				]
			};
		}
		if (expr.kind === "cast") {
			// cast(_ as json) déjà résolu au lower pour les string literals;
			// operand non-literal → no-op (BSON = JSON natif). mongoRenderCast
			// centralise $dateTrunc pour target="date", $convert sinon.
			return mongoRenderCast(
				transformHaving(expr.operand),
				expr.target,
				expr.operand.kind === "field"
			);
		}
		if (expr.kind === "compare") {
			return {
				[MONGO_OP[expr.op]]: [
					transformHaving(expr.left),
					transformHaving(expr.right)
				]
			};
		}
		if (expr.kind === "and") {
			return {
				$and: [transformHaving(expr.left), transformHaving(expr.right)]
			};
		}
		if (expr.kind === "or") {
			return { $or: [transformHaving(expr.left), transformHaving(expr.right)] };
		}
		if (expr.kind === "not") {
			return { $not: transformHaving(expr.operand) };
		}
		if (expr.kind === "isNull") {
			const op = expr.negated ? "$ne" : "$eq";
			return { [op]: [transformHaving(expr.operand), null] };
		}
		if (expr.kind === "in") {
			return {
				$in: [
					transformHaving(expr.target),
					expr.values.map((v) => transformHaving(v))
				]
			};
		}
		if (expr.kind === "case") {
			return {
				$switch: {
					branches: expr.branches.map((b) => ({
						case: transformHaving(b.cond),
						then: transformHaving(b.value)
					})),
					default: transformHaving(expr.elseValue)
				}
			};
		}
		if (expr.kind === "object" || expr.kind === "array") {
			throw new SnqlError(
				"Object/array literal dans having non supporté",
				"codegen_mongo_having_literal"
			);
		}
		throw new SnqlError(
			"Expression non supportée dans having Mongo",
			"codegen_mongo_having_expr"
		);
	}

	let havingExpr: unknown | undefined;
	if (having !== undefined) {
		havingExpr = transformHaving(having);
	}

	return { groupStage, projectStage, havingExpr, havingSlots };
}

/**
 * émet les stages Mongo pour DISTINCT / DISTINCT ON après un
 * $project. Deux variantes :
 *
 *  - `unique` seul (SELECT DISTINCT) : $group par TOUS les fields output,
 *    puis $replaceRoot pour remettre à plat.
 *  - `distinctOnKeys` (DISTINCT ON (k1, k2)) : $group par k1, k2 (accum
 *    $first sur les autres fields — le sort en amont détermine "first"),
 *    puis $replaceRoot avec l'objet reconstruit.
 *
 * Note : $group détruit l'ordre. Le sort post-DISTINCT devra re-trier si
 * demandé — géré par le prochain stage `sort` dans la pipeline.
 */
export function appendDistinctStages(
	pipeline: MongoStage[],
	op: Extract<LogicalPlan, { op: "project" }>
): void {
	// Récupère les noms de sortie des fields projetés (alias ou last-seg).
	const outputNames = op.fields.map((f) => {
		if (f.alias !== undefined) return f.alias;
		return (f.path[f.path.length - 1] as string) ?? "";
	});
	if (op.distinctOnKeys !== undefined && op.distinctOnKeys.length > 0) {
		// DISTINCT ON — group par les keys, $first sur les autres.
		const idInner: Record<string, unknown> = {};
		for (const k of op.distinctOnKeys) {
			const seg = k[k.length - 1] as string;
			idInner[seg] = `$${seg}`;
		}
		const groupFields: Record<string, unknown> = { _id: idInner };
		const keySet = new Set(
			op.distinctOnKeys.map((k) => k[k.length - 1] as string)
		);
		for (const name of outputNames) {
			if (keySet.has(name)) continue;
			groupFields[name] = { $first: `$${name}` };
		}
		pipeline.push({ $group: groupFields });
		// Reconstitue l'objet plat : keys sortent de _id, autres sont déjà top.
		const projectBack: Record<string, unknown> = { _id: 0 };
		for (const name of outputNames) {
			projectBack[name] = keySet.has(name) ? `$_id.${name}` : `$${name}`;
		}
		pipeline.push({ $project: projectBack });
		return;
	}
	// DISTINCT (unique seul) — group par TOUS les output fields.
	const idInner: Record<string, unknown> = {};
	for (const name of outputNames) {
		idInner[name] = `$${name}`;
	}
	pipeline.push({ $group: { _id: idInner } });
	const projectBack: Record<string, unknown> = { _id: 0 };
	for (const name of outputNames) {
		projectBack[name] = `$_id.${name}`;
	}
	pipeline.push({ $project: projectBack });
}
