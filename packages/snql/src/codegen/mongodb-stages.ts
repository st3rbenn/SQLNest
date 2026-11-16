import { SnqlError } from "../diagnostics";
import { SNQL_FUNCTIONS } from "../functions";
import type {
	LogicalPlan,
	PlanExpr,
	PlanProjectField,
	PlanSortKey
} from "../ir/plan";
import type { MongoStage } from "./mapper";
import {
	appendDistinctStages,
	renderAggregatePipeline
} from "./mongodb-aggregate";
import { extractCorrelatedLookups } from "./mongodb-correlated";
import { mongoField, toExprOperand } from "./mongodb-expr";
import { mergeMatchDocs, renderMatch } from "./mongodb-match";

/**
 * Étapes du pipeline : projection, tri, fenêtres, assemblage étape par étape.
 */

export function appendStage(
	pipeline: MongoStage[],
	op: LogicalPlan,
	alias: string | undefined
): void {
	switch (op.op) {
		case "scan":
			return;
		case "filter": {
			// extract les subqueries correlated en $lookup{let,
			// pipeline} liftés AVANT le $match, remplace-les par des refs à des
			// slots synthétiques __sq_N, puis $unset les slots après le $match.
			const lifted = extractCorrelatedLookups(op.predicate, alias);
			if (lifted !== null) {
				for (const stage of lifted.lookupStages) pipeline.push(stage);
				const matchDoc = mergeMatchDocs(
					lifted.predicateResidual === null
						? null
						: renderMatch(lifted.predicateResidual, alias, "read"),
					lifted.matchAdditions
				);
				pipeline.push({ $match: matchDoc });
				pipeline.push({ $unset: lifted.synthFields });
				return;
			}
			pipeline.push({ $match: renderMatch(op.predicate, alias, "read") });
			return;
		}
		case "project": {
			// windowCalls dans project.fields → $setWindowFields
			// AVANT $project (assign compute per row, réf en alias). Le project
			// final projette les alias comme des field refs directs.
			const windowSlots = extractWindowCallsToSlots(op.fields, alias);
			for (const stage of windowSlots.stages) pipeline.push(stage);
			pipeline.push({
				$project: renderProject(op.fields, alias, windowSlots.slotByKey)
			});
			// DISTINCT / DISTINCT ON via $group + $first APRÈS
			// $project (les fields projetés sont déjà top-level, plus simple).
			if (op.unique === true || op.distinctOnKeys !== undefined) {
				appendDistinctStages(pipeline, op);
			}
			return;
		}
		case "aggregate": {
			// PAIRE [$group{_id:null,...accs}, $project{_id:0,...renames}]
			// via SSA extract. op.groupKeys peuplé → `_id: <keys>`
			// non-null (flat object), $project inclut les groupKeys ; op.having
			// → SSA extract sur having aussi (aggregates partagent slots avec
			// pick), $match {$expr:...} après $project, $unset des slots
			// having-only à la fin.
			const { groupStage, projectStage, havingExpr, havingSlots } =
				renderAggregatePipeline(op.fields, alias, op.groupKeys, op.having);
			pipeline.push({ $group: groupStage });
			pipeline.push({ $project: projectStage });
			if (havingExpr !== undefined) {
				pipeline.push({ $match: { $expr: havingExpr } });
				if (havingSlots.length > 0) {
					pipeline.push({ $unset: havingSlots });
				}
			}
			return;
		}
		case "sort": {
			// $sort après $project doit référencer les champs projetés.
			// Si une sort key référence un field DROPPÉ par le project précédent, on
			// insère le bloc sort AVANT $project — sort opère alors sur les docs
			// sources qui contiennent encore le field (aligné SQL ORDER BY sur FROM col).
			// Cas group/aggregate : jamais reorder ($group détruit les rows sources,
			// sort DOIT rester après).
			const sortStages = buildSortStages(op.keys, alias);
			const prev = pipeline[pipeline.length - 1];
			if (prev !== undefined && "$project" in prev) {
				const projectOut = prev.$project as Record<string, unknown>;
				const projectedFields = new Set<string>();
				for (const key of Object.keys(projectOut)) {
					if (key === "_id") continue;
					if (projectOut[key] !== 0 && projectOut[key] !== false)
						projectedFields.add(key);
				}
				const sortRefsMissing = op.keys.some((k) => {
					const path = mongoField(k.path, alias);
					const head = path.split(".")[0]!;
					return !projectedFields.has(head);
				});
				if (sortRefsMissing) {
					// Insérer le bloc sort avant $project (à la position du $project).
					pipeline.splice(pipeline.length - 1, 0, ...sortStages);
					return;
				}
			}
			pipeline.push(...sortStages);
			return;
		}
		case "limit":
			// $skip AVANT $limit : « sauter M puis prendre N » (comme LIMIT N OFFSET M).
			if (op.offset !== undefined) {
				pipeline.push({ $skip: op.offset });
			}
			pipeline.push({ $limit: op.count });
			return;
		case "join":
			// $lookup : imbrique les documents matchés dans le champ `as` (array).
			pipeline.push({
				$lookup: {
					from: op.collection,
					localField: mongoField(op.localField, alias),
					foreignField: op.foreignField.join("."),
					as: op.as
				}
			});
			// Kind `join` (many-to-one / one-to-one) : on aplatit l'array en objet unique
			// via $unwind avec preserveNullAndEmptyArrays (garde les lignes sans match,
			// équivalent LEFT JOIN vs INNER JOIN). Kind `embed` : on laisse l'array tel
			// quel (comportement historique, one-to-many).
			if (op.kind === "join") {
				pipeline.push({
					$unwind: {
						path: `$${op.as}`,
						preserveNullAndEmptyArrays: true
					}
				});
			} else if (op.kind === "count") {
				// Reverse-nav (ADR-031 D7) : remplace l'array du $lookup par sa taille
				// (count corrélé scalaire sous le même champ `as`).
				pipeline.push({
					$addFields: { [op.as]: { $size: `$${op.as}` } }
				});
			}
			return;
	}
}

function renderProject(
	fields: readonly PlanProjectField[],
	alias: string | undefined,
	windowSlots?: Map<string, string>
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	let picksId = false;
	for (const field of fields) {
		if (field.expr !== undefined) {
			// si l'expr est un windowCall, référencer le slot
			// précalculé par $setWindowFields (au lieu de tenter toExprOperand
			// qui ne saurait pas gérer windowCall).
			if (field.expr.kind === "windowCall" && windowSlots !== undefined) {
				const slot = windowSlots.get(windowCallKey(field.expr));
				if (slot !== undefined) {
					out[field.alias as string] = `$${slot}`;
					if (field.alias === "_id") picksId = true;
					continue;
				}
			}
			out[field.alias as string] = toExprOperand(field.expr, alias);
			if (field.alias === "_id") {
				picksId = true;
			}
			continue;
		}
		// Path nested (`pick users.email`) : Mongo interprète `{ "users.email": 1 }`
		// comme "projette le sous-champ" et retourne `{ users: { email: ... } }`.
		// Le contrat cross-engine SQL est un col top-level `email` (PG :
		// `SELECT users.email FROM ...` → col `email`). Pour parité, on rewrite :
		// path multi-segment sans alias → key = dernier segment, value = `$path`
		// (extraction explicite). Path single-segment reste `{ col: 1 }`.
		const isNestedNoAlias = field.alias === undefined && field.path.length > 1;
		const key =
			field.alias !== undefined
				? field.alias
				: isNestedNoAlias
					? (field.path[field.path.length - 1] as string)
					: mongoField(field.path, alias);
		out[key] =
			field.alias !== undefined || isNestedNoAlias
				? `$${mongoField(field.path, alias)}`
				: 1;
		if (key === "_id") {
			picksId = true;
		}
	}
	if (!picksId) {
		out._id = 0;
	}
	return out;
}

/**
 * clé stable pour dédup les windowCalls identiques (même fn +
 * partition + sort) — deux fields référençant le même windowCall partagent
 * un seul slot dans $setWindowFields.
 */
function windowCallKey(expr: PlanExpr & { kind: "windowCall" }): string {
	return JSON.stringify({
		n: expr.name,
		p: expr.partitionKeys,
		s: expr.sortKeys.map((k) => ({ p: k.path, d: k.direction }))
	});
}

/**
 * scanne les fields pour extraire les windowCalls, produit les
 * $setWindowFields stages à insérer avant $project. Retourne aussi le
 * slotByKey pour que renderProject référence `$__win_N` au lieu d'essayer de
 * rendre l'expression.
 *
 * `$setWindowFields` a une contrainte : un seul stage peut avoir une seule
 * `partitionBy` + `sortBy`. Pour des windows différents (partition/sort
 * différents), on émet plusieurs stages consécutifs.
 */
function extractWindowCallsToSlots(
	fields: readonly PlanProjectField[],
	alias: string | undefined
): {
	stages: MongoStage[];
	slotByKey: Map<string, string>;
} {
	const slotByKey = new Map<string, string>();
	// Group par (partition, sort) key — chaque groupe = un $setWindowFields.
	const groupsByPartitionSort = new Map<
		string,
		{
			partitionBy: unknown;
			sortBy: Record<string, 1 | -1> | undefined;
			outputs: Record<string, unknown>;
		}
	>();
	let slotCounter = 0;
	for (const field of fields) {
		if (field.expr?.kind !== "windowCall") continue;
		const w = field.expr;
		const key = windowCallKey(w);
		if (slotByKey.has(key)) continue; // dédup
		const slot = `__win_${slotCounter}`;
		slotCounter += 1;
		slotByKey.set(key, slot);
		// Group key : partition + sort canonique.
		const groupKey = JSON.stringify({ p: w.partitionKeys, s: w.sortKeys });
		let group = groupsByPartitionSort.get(groupKey);
		if (group === undefined) {
			const partitionBy =
				w.partitionKeys.length === 0
					? null
					: w.partitionKeys.length === 1
						? `$${mongoField(w.partitionKeys[0]!, alias)}`
						: w.partitionKeys.reduce<Record<string, string>>((acc, p) => {
								const seg = p[p.length - 1]!;
								acc[seg] = `$${mongoField(p, alias)}`;
								return acc;
							}, {});
			const sortBy: Record<string, 1 | -1> | undefined =
				w.sortKeys.length === 0
					? undefined
					: w.sortKeys.reduce<Record<string, 1 | -1>>((acc, k) => {
							acc[mongoField(k.path, alias)] = k.direction === "desc" ? -1 : 1;
							return acc;
						}, {});
			group = { partitionBy, sortBy, outputs: {} };
			groupsByPartitionSort.set(groupKey, group);
		}
		// Renderer body du windowCall.
		const entry = SNQL_FUNCTIONS.get(w.name);
		if (entry?.engines.mongodb === undefined) {
			throw new SnqlError(
				`Window function '${w.name}' : renderer MongoDB absent`,
				"codegen_missing_function_mapping"
			);
		}
		const body = entry.engines.mongodb(w.args, {
			renderExpr: (a) => toExprOperand(a as PlanExpr, alias)
		});
		group.outputs[slot] = body;
	}
	const stages: MongoStage[] = [];
	for (const group of groupsByPartitionSort.values()) {
		const setStage: Record<string, unknown> = {
			partitionBy: group.partitionBy,
			output: group.outputs
		};
		if (group.sortBy !== undefined) setStage.sortBy = group.sortBy;
		stages.push({ $setWindowFields: setStage });
	}
	return { stages, slotByKey };
}

/**
 * Bloc de stages pour un `sort`, avec parité null-ordering 3VL (ADR-032). PG
 * default = ASC nulls last / DESC nulls first ; Mongo `$sort` natif fait
 * l'inverse. Pour chaque clé NON prouvée `not null`, on préfixe un rang
 * `$cond[key == null → 1 : 0]` trié dans la MÊME direction (ASC : 0<1 = nulls
 * last ✓ ; DESC : 1 avant 0 = nulls first ✓). Les clés `not null` restent en
 * `$sort` plat → l'index Mongo reste utilisable (pas de tri en mémoire).
 * Aucun rang requis → un seul `$sort` (chemin historique).
 */
function buildSortStages(
	keys: readonly PlanSortKey[],
	alias: string | undefined
): MongoStage[] {
	const rankFields: Record<string, unknown> = {};
	const sortDoc: Record<string, 1 | -1> = {};
	const rankSlots: string[] = [];
	keys.forEach((key, i) => {
		const field = mongoField(key.path, alias);
		const dir: 1 | -1 = key.direction === "desc" ? -1 : 1;
		if (key.provablyNotNull !== true) {
			const slot = `__nr_${i}`;
			rankFields[slot] = { $cond: [{ $eq: [`$${field}`, null] }, 1, 0] };
			sortDoc[slot] = dir;
			rankSlots.push(slot);
		}
		sortDoc[field] = dir;
	});
	if (rankSlots.length === 0) {
		return [{ $sort: sortDoc }];
	}
	return [
		{ $addFields: rankFields },
		{ $sort: sortDoc },
		{ $unset: rankSlots }
	];
}
