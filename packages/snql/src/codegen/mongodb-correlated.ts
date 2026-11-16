import { SnqlError } from "../diagnostics";
import { type LogicalPlan, linearize, type PlanExpr } from "../ir/plan";
import type { MongoStage } from "./mapper";
import { mongoField, renderMongoAggExpr } from "./mongodb-expr";

/**
 * Sous-requêtes corrélées, remontées en `$lookup` avant le filtre qui les lit.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Correlated subquery lift-lookup ($lookup{let,pipeline})
// ─────────────────────────────────────────────────────────────────────────────
interface CorrelatedLift {
	readonly lookupStages: readonly MongoStage[];
	readonly matchAdditions: readonly Record<string, unknown>[];
	readonly predicateResidual: PlanExpr | null;
	readonly synthFields: readonly string[];
}

interface CorrelatedLiftState {
	lookupStages: MongoStage[];
	matchAdditions: Record<string, unknown>[];
	predicateResidual: PlanExpr | null;
	synthFields: string[];
	counter: number;
}

/**
 * Extract les sub-queries corrélées d'un predicate WHERE en stages liftés.
 * Retourne `null` si le predicate n'en contient aucune (fast-path : appendStage
 * reste sur son chemin $match direct). Sinon retourne les lookup stages à
 * insérer AVANT le $match, les match doc additions à combiner avec le
 * predicate résiduel, et les synth fields à $unset APRÈS le $match.
 *
 * Traverse uniquement les nœuds `and` — le planner refuse déjà (via
 * `assertCorrelatedSubqueryLiftable`) toute corrélée sous OR/NOT/case ; on
 * peut donc supposer top-level ou AND-chain ici en toute sécurité.
 *
 * Reconnaît 3 formes :
 *  - `exists (subq)` correlated → lookup + `{__sq_N: {$ne: []}}`
 *  - `not exists (subq)` correlated → lookup + `{__sq_N: {$eq: []}}`
 *  - `x in (subq pick col)` correlated → lookup + `{$expr: {$in: [$x, $__sq_N.col]}}`
 */
export function extractCorrelatedLookups(
	predicate: PlanExpr,
	outerAlias: string | undefined
): CorrelatedLift | null {
	const state: CorrelatedLiftState = {
		lookupStages: [],
		matchAdditions: [],
		predicateResidual: null,
		synthFields: [],
		counter: 0
	};
	state.predicateResidual = consumeCorrelatedNode(predicate, outerAlias, state);
	if (state.lookupStages.length === 0) return null;
	return {
		lookupStages: state.lookupStages,
		matchAdditions: state.matchAdditions,
		predicateResidual: state.predicateResidual,
		synthFields: state.synthFields
	};
}

function consumeCorrelatedNode(
	expr: PlanExpr,
	outerAlias: string | undefined,
	state: CorrelatedLiftState
): PlanExpr | null {
	// Cas 1 : exists correlated top-level.
	if (expr.kind === "exists") {
		if (!isCorrelatedSubplan(expr.subplan)) return expr;
		const synth = `__sq_${state.counter++}`;
		state.lookupStages.push(
			buildCorrelatedLookupStage(expr.subplan, outerAlias, synth)
		);
		state.matchAdditions = [...state.matchAdditions, { [synth]: { $ne: [] } }];
		state.synthFields.push(synth);
		return null;
	}
	// Cas 2 : not exists correlated.
	if (
		expr.kind === "not" &&
		expr.operand.kind === "exists" &&
		isCorrelatedSubplan(expr.operand.subplan)
	) {
		const synth = `__sq_${state.counter++}`;
		state.lookupStages.push(
			buildCorrelatedLookupStage(expr.operand.subplan, outerAlias, synth)
		);
		state.matchAdditions = [...state.matchAdditions, { [synth]: { $eq: [] } }];
		state.synthFields.push(synth);
		return null;
	}
	// Cas 3 : `x in (subq)` correlated (une seule value, kind subquery).
	if (
		expr.kind === "in" &&
		expr.values.length === 1 &&
		expr.values[0]?.kind === "subquery" &&
		isCorrelatedSubplan(expr.values[0].plan)
	) {
		const subplan = expr.values[0].plan;
		if (expr.target.kind !== "field") return expr;
		const synth = `__sq_${state.counter++}`;
		state.lookupStages.push(
			buildCorrelatedLookupStage(subplan, outerAlias, synth)
		);
		const targetPath = mongoField(expr.target.path, outerAlias);
		const pickedField = extractPickedFieldFromSubplan(subplan);
		const rhs = pickedField === null ? `$${synth}` : `$${synth}.${pickedField}`;
		state.matchAdditions = [
			...state.matchAdditions,
			{ $expr: { $in: [`$${targetPath}`, rhs] } }
		];
		state.synthFields.push(synth);
		return null;
	}
	// AND-chain : descendre récursivement, garder le résidu.
	if (expr.kind === "and") {
		const l = consumeCorrelatedNode(expr.left, outerAlias, state);
		const r = consumeCorrelatedNode(expr.right, outerAlias, state);
		if (l === null && r === null) return null;
		if (l === null) return r;
		if (r === null) return l;
		return { kind: "and", left: l, right: r };
	}
	return expr;
}

function isCorrelatedSubplan(subplan: LogicalPlan): boolean {
	const ops = linearize(subplan);
	const scan = ops[0];
	if (scan?.op !== "scan") return false;
	const localAlias = scan.alias;
	let found = false;
	const walk = (e: PlanExpr): void => {
		if (found) return;
		switch (e.kind) {
			case "field":
				if (e.path.length > 1 && e.path[0] !== localAlias) found = true;
				return;
			case "compare":
			case "arith":
			case "and":
			case "or":
				walk(e.left);
				walk(e.right);
				return;
			case "not":
			case "isNull":
			case "cast":
				walk(e.operand);
				return;
			case "in":
				walk(e.target);
				for (const v of e.values) walk(v);
				return;
			case "call":
			case "windowCall":
				for (const a of e.args) walk(a);
				return;
			case "case":
				for (const b of e.branches) {
					walk(b.cond);
					walk(b.value);
				}
				walk(e.elseValue);
				return;
			case "object":
				for (const en of e.entries) walk(en.value);
				return;
			case "array":
				for (const i of e.items) walk(i);
				return;
			case "subquery":
			case "exists":
			case "literal":
			case "upsertNew":
				return;
		}
	};
	for (const op of ops.slice(1)) {
		if (op.op === "filter") walk(op.predicate);
		else if (op.op === "aggregate" && op.having !== undefined) walk(op.having);
		else if (op.op === "project") {
			for (const f of op.fields) if (f.expr !== undefined) walk(f.expr);
		}
	}
	return found;
}

/** Extrait la première projection field simple (`pick col`) du subplan, ou null. */
function extractPickedFieldFromSubplan(subplan: LogicalPlan): string | null {
	const ops = linearize(subplan);
	for (const op of ops) {
		if (op.op !== "project") continue;
		const first = op.fields[0];
		if (first === undefined) return null;
		if (first.expr?.kind === "field") {
			return first.expr.path[first.expr.path.length - 1] ?? null;
		}
		if (first.expr === undefined && first.path.length > 0) {
			return first.path[first.path.length - 1] ?? null;
		}
	}
	return null;
}

/**
 * Construit un stage `$lookup {from, let, pipeline, as}` pour un sub-plan
 * correlated. Le pipeline interne :
 *  - `$match: {$expr: <rewrite du filter du subplan>}` où chaque ref au champ
 *    outer devient `$$<letVar>` et chaque ref local reste `$field`.
 *  - `$project: {_id: 0, <col>: 1}` si le subplan a un `pick`.
 *
 * `let` mappe chaque colonne outer référencée à `$<col>` (accessible sous
 * `$$<letVar>` dans le pipeline). Conventions : `<outerAlias>_<col>` lowercased.
 */
function buildCorrelatedLookupStage(
	subplan: LogicalPlan,
	_outerAlias: string | undefined,
	asField: string
): MongoStage {
	const ops = linearize(subplan);
	const scan = ops[0];
	if (scan?.op !== "scan") {
		throw new SnqlError(
			"Correlated subquery : scan racine manquant (planner assert liftable devrait avoir refusé)",
			"codegen_mongo_subquery_unsupported"
		);
	}
	const collection = scan.collection;
	const subLocalAlias = scan.alias;
	const filter = ops.find((o) => o.op === "filter");
	const project = ops.find((o) => o.op === "project");

	const outerColRefs = collectOuterColumnRefsInSubplan(subplan);
	const letDoc: Record<string, string> = {};
	const letVarMap = new Map<string, string>();
	for (const col of outerColRefs) {
		const varName = `outer_${col}`.toLowerCase();
		letDoc[varName] = `$${col}`;
		letVarMap.set(col, varName);
	}

	const pipeline: MongoStage[] = [];
	if (filter !== undefined && filter.op === "filter") {
		pipeline.push({
			$match: {
				$expr: renderMongoAggExpr(filter.predicate, subLocalAlias, letVarMap)
			}
		});
	}
	if (project !== undefined && project.op === "project") {
		const projectDoc: Record<string, unknown> = { _id: 0 };
		for (const f of project.fields) {
			let colName: string | undefined;
			if (f.expr?.kind === "field") {
				colName = f.expr.path[f.expr.path.length - 1];
			} else if (f.expr === undefined && f.path.length > 0) {
				colName = f.path[f.path.length - 1];
			}
			if (colName !== undefined) projectDoc[colName] = 1;
		}
		pipeline.push({ $project: projectDoc });
	}

	return {
		$lookup: {
			from: collection,
			let: letDoc,
			pipeline,
			as: asField
		}
	};
}

/**
 * Collecte les colonnes outer référencées dans un subplan correlated. Une col
 * = le path[1..] d'un field ref dont path[0] n'est pas l'alias local du scan
 * racine. Assumption MVP : 1 seul alias outer (planner refuse le multi-alias).
 */
function collectOuterColumnRefsInSubplan(subplan: LogicalPlan): string[] {
	const ops = linearize(subplan);
	const scan = ops[0];
	if (scan?.op !== "scan") return [];
	const localAlias = scan.alias;
	const cols = new Set<string>();
	const walk = (e: PlanExpr): void => {
		switch (e.kind) {
			case "field":
				if (e.path.length > 1 && e.path[0] !== localAlias) {
					cols.add(e.path.slice(1).join("."));
				}
				return;
			case "compare":
			case "arith":
			case "and":
			case "or":
				walk(e.left);
				walk(e.right);
				return;
			case "not":
			case "isNull":
			case "cast":
				walk(e.operand);
				return;
			case "in":
				walk(e.target);
				for (const v of e.values) walk(v);
				return;
			case "call":
			case "windowCall":
				for (const a of e.args) walk(a);
				return;
			case "case":
				for (const b of e.branches) {
					walk(b.cond);
					walk(b.value);
				}
				walk(e.elseValue);
				return;
			case "object":
				for (const en of e.entries) walk(en.value);
				return;
			case "array":
				for (const i of e.items) walk(i);
				return;
			case "subquery":
			case "exists":
			case "literal":
			case "upsertNew":
				return;
		}
	};
	for (const op of ops.slice(1)) {
		if (op.op === "filter") walk(op.predicate);
		else if (op.op === "project") {
			for (const f of op.fields) if (f.expr !== undefined) walk(f.expr);
		}
	}
	return [...cols];
}
