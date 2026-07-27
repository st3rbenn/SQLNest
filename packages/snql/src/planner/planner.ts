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
 * (`join` sera ajouté avec l'opérateur `with` — il exige la couche connexion.)
 */
export type CompensationOp =
	| { readonly op: "filter"; readonly predicate: PlanExpr }
	| { readonly op: "project"; readonly fields: readonly PlanProjectField[] }
	| { readonly op: "sort"; readonly keys: readonly PlanSortKey[] }
	| { readonly op: "limit"; readonly count: number; readonly offset?: number };

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
		case "scan":
			throw new SnqlError(
				"Un 'scan' ne peut pas être compensé",
				"planner_scan_compensation"
			);
	}
}
