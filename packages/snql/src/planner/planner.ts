import { SnqlError } from "../diagnostics";
import type {
	Capability,
	LogicalPlan,
	PlanExpr,
	PlanProjectField,
	PlanSortKey
} from "../ir/plan";
import { linearize, requiredCapability } from "../ir/plan";
import type { Capabilities } from "./capabilities";

/**
 * Opérateur de compensation : à appliquer dans le runtime SNQL, au-dessus du
 * résultat du pushdown. Sans `input` : chaque op s'applique aux rows de la précédente.
 * Le `join` a besoin des données de la collection droite (fournies au runtime).
 */
export type CompensationOp =
	| { readonly op: "filter"; readonly predicate: PlanExpr }
	| { readonly op: "project"; readonly fields: readonly PlanProjectField[] }
	| { readonly op: "sort"; readonly keys: readonly PlanSortKey[] }
	| { readonly op: "limit"; readonly count: number; readonly offset?: number }
	| {
			readonly op: "join";
			readonly collection: string;
			readonly as: string;
			readonly localField: readonly string[];
			readonly foreignField: readonly string[];
	  };

/**
 * Plan physique = découpe capability-aware d'un Logical Plan pour un moteur :
 * - `pushdown` : le sous-plan exécuté nativement (→ mapper → requête native) ;
 * - `compensation` : les opérateurs joués dans le runtime, dans l'ordre.
 */
export interface PhysicalPlan {
	readonly engine: string;
	readonly pushdown: LogicalPlan;
	readonly compensation: readonly CompensationOp[];
	readonly fullyPushed: boolean;
}

export interface PlanOptions {
	/** `compensate` (défaut) : suffixe non poussable → runtime. `reject` : erreur typée. */
	readonly onUnsupported?: "compensate" | "reject";
}

/**
 * Découpe un Logical Plan en pushdown + compensation selon les capacités du moteur.
 *
 * La chaîne d'opérateurs est ordonnée (scan → … → limit). On pousse le **plus long
 * préfixe** que le moteur supporte ; dès qu'un opérateur n'est pas poussable, lui ET
 * tout ce qui est au-dessus deviennent de la compensation (un point de coupure unique,
 * car un op au-dessus s'applique à la sortie du runtime, pas du moteur).
 */
export function plan(
	logical: LogicalPlan,
	capabilities: Capabilities,
	options: PlanOptions = {}
): PhysicalPlan {
	const ops = linearize(logical); // scan d'abord
	const scan = ops[0];
	if (scan === undefined || scan.op !== "scan") {
		throw new SnqlError(
			"Plan sans collection source (scan manquant)",
			"planner_no_scan"
		);
	}
	if (!capabilities.supports.has("scan")) {
		throw new SnqlError(
			`Le moteur '${capabilities.engine}' ne supporte pas 'scan'`,
			"planner_no_scan_capability"
		);
	}

	// Vérifie que toutes les fonctions du plan sont supportées par l'engine.
	// Le lower a déjà validé l'existence dans le registre ; ici on filtre par
	// engine spécifique (une fonction PG-only n'a pas de renderer Mongo, etc).
	assertFunctionsSupported(logical, capabilities);

	// Index du 1er opérateur non poussable (= début de la compensation).
	let cut = ops.length;
	for (let i = 0; i < ops.length; i += 1) {
		const op = ops[i];
		if (
			op !== undefined &&
			!capabilities.supports.has(requiredCapability(op))
		) {
			cut = i;
			break;
		}
	}

	const pushdown = ops[cut - 1];
	if (pushdown === undefined) {
		throw new SnqlError(
			"Rien à pousser vers le moteur",
			"planner_empty_pushdown"
		);
	}
	// `ops[cut-1]` porte déjà sa chaîne d'input jusqu'au scan → c'est le sous-plan poussé.
	const compensation = ops.slice(cut).map(toCompensationOp);

	if (options.onUnsupported === "reject" && compensation.length > 0) {
		const firstUnpushable = ops[cut];
		const capability: Capability | "?" = firstUnpushable
			? requiredCapability(firstUnpushable)
			: "?";
		throw new SnqlError(
			`Capacité '${capability}' non poussable vers '${capabilities.engine}' (mode reject)`,
			"planner_unpushable"
		);
	}

	return {
		engine: capabilities.engine,
		pushdown,
		compensation,
		fullyPushed: compensation.length === 0
	};
}

/**
 * Vérifie que toutes les fonctions référencées dans le plan sont supportées par
 * l'engine cible (via `capabilities.functions`). Lève `planner_unsupported_function`
 * avec le nom offender, sans compensation possible pour T2 sprint 1 (les
 * fonctions sont scalaires — les émuler côté runtime doublerait le codegen).
 */
function assertFunctionsSupported(plan: LogicalPlan, capabilities: Capabilities): void {
	const unsupported = new Set<string>();
	visitPlanCalls(plan, (name) => {
		if (!capabilities.functions.has(name)) {
			unsupported.add(name);
		}
	});
	if (unsupported.size > 0) {
		const list = [...unsupported].map((n) => `'${n}'`).join(", ");
		throw new SnqlError(
			`Fonction${unsupported.size > 1 ? "s" : ""} ${list} non support${unsupported.size > 1 ? "ées" : "ée"} par le moteur '${capabilities.engine}'`,
			"planner_unsupported_function"
		);
	}
}

/** Walker qui invoque `visit(name)` pour chaque call rencontré dans le plan. */
function visitPlanCalls(plan: LogicalPlan, visit: (name: string) => void): void {
	switch (plan.op) {
		case "scan":
			return;
		case "filter":
			visitExprCalls(plan.predicate, visit);
			visitPlanCalls(plan.input, visit);
			return;
		case "project":
			for (const field of plan.fields) {
				if (field.expr !== undefined) visitExprCalls(field.expr, visit);
			}
			visitPlanCalls(plan.input, visit);
			return;
		case "sort":
		case "limit":
			visitPlanCalls(plan.input, visit);
			return;
		case "join":
			visitPlanCalls(plan.input, visit);
			return;
	}
}

function visitExprCalls(expr: PlanExpr, visit: (name: string) => void): void {
	switch (expr.kind) {
		case "literal":
		case "field":
			return;
		case "call":
			visit(expr.name);
			for (const arg of expr.args) visitExprCalls(arg, visit);
			return;
		case "arith":
		case "compare":
		case "and":
		case "or":
			visitExprCalls(expr.left, visit);
			visitExprCalls(expr.right, visit);
			return;
		case "not":
		case "isNull":
			visitExprCalls(expr.operand, visit);
			return;
		case "in":
			visitExprCalls(expr.target, visit);
			for (const v of expr.values) visitExprCalls(v, visit);
			return;
	}
}

function toCompensationOp(op: LogicalPlan): CompensationOp {
	switch (op.op) {
		case "filter":
			return { op: "filter", predicate: op.predicate };
		case "project":
			return { op: "project", fields: op.fields };
		case "sort":
			return { op: "sort", keys: op.keys };
		case "limit":
			return op.offset !== undefined
				? { op: "limit", count: op.count, offset: op.offset }
				: { op: "limit", count: op.count };
		case "join":
			return {
				op: "join",
				collection: op.collection,
				as: op.as,
				localField: op.localField,
				foreignField: op.foreignField
			};
		case "scan":
			throw new SnqlError(
				"Un 'scan' ne peut pas être compensé",
				"planner_scan_compensation"
			);
	}
}
