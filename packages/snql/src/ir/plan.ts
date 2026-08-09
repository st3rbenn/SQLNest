/**
 * IR / Logical Plan : l'algèbre canonique, engine-agnostique.
 * Chaque opérateur déclare la capacité qu'il exige (voir le vault :
 * `02 - Architecture/The Hard Version — Algèbre Polyglotte`).
 */

export type Capability =
	| "scan"
	| "filter"
	| "project"
	| "join"
	| "aggregate"
	| "sort"
	| "paginate"
	| "mutate"
	| "graph";

/**
 * Décimal **exact** : on garde le texte brut. Les colonnes NUMERIC/DECIMAL de
 * Postgres sont à précision arbitraire, hors de portée d'un double JS — un
 * littéral fractionnaire ne doit JAMAIS passer par `Number()` avant le codegen
 * (sinon corruption silencieuse). Le codegen PG binde le raw (cast exact) ;
 * Mongo / runtime le ramènent à un `number` (limite intrinsèque de JS/BSON).
 */
export interface SqlDecimal {
	readonly kind: "decimal";
	readonly raw: string;
}

/**
 * Valeur scalaire canonique. `bigint` préserve les entiers > 2^53 (clés bigint
 * Postgres, IDs Snowflake) ; `SqlDecimal` préserve les décimaux exacts.
 */
export type SqlValue = string | number | bigint | boolean | null | SqlDecimal;

/** Garde-type sûr, y compris sur un `unknown` arbitraire (row values). */
export function isSqlDecimal(value: unknown): value is SqlDecimal {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { kind?: unknown }).kind === "decimal" &&
		typeof (value as { raw?: unknown }).raw === "string"
	);
}

export type CompareOp = "eq" | "ne" | "lt" | "gt" | "le" | "ge" | "like";

export type PlanExpr =
	| { readonly kind: "literal"; readonly value: SqlValue }
	| { readonly kind: "field"; readonly path: readonly string[] }
	| {
			readonly kind: "compare";
			readonly op: CompareOp;
			readonly left: PlanExpr;
			readonly right: PlanExpr;
	  }
	| { readonly kind: "and"; readonly left: PlanExpr; readonly right: PlanExpr }
	| { readonly kind: "or"; readonly left: PlanExpr; readonly right: PlanExpr }
	| { readonly kind: "not"; readonly operand: PlanExpr }
	// Canonicalisé au lowering : `x = null` / `null = x` / `x != null` → IS [NOT] NULL.
	| {
			readonly kind: "isNull";
			readonly negated: boolean;
			readonly operand: PlanExpr;
	  }
	| {
			readonly kind: "in";
			readonly target: PlanExpr;
			readonly values: readonly PlanExpr[];
	  };

export interface PlanProjectField {
	readonly path: readonly string[];
	readonly alias?: string;
}

export interface PlanSortKey {
	readonly path: readonly string[];
	readonly direction: "asc" | "desc";
}

export type LogicalPlan =
	| {
			readonly op: "scan";
			readonly collection: string;
			readonly alias?: string;
	  }
	| {
			readonly op: "filter";
			readonly input: LogicalPlan;
			readonly predicate: PlanExpr;
	  }
	| {
			readonly op: "project";
			readonly input: LogicalPlan;
			readonly fields: readonly PlanProjectField[];
	  }
	| {
			readonly op: "sort";
			readonly input: LogicalPlan;
			readonly keys: readonly PlanSortKey[];
	  }
	| {
			readonly op: "limit";
			readonly input: LogicalPlan;
			readonly count: number;
			readonly offset?: number;
	  }
	// Join. `kind` détermine la sémantique côté codegen :
	//  - `embed` : chaque ligne gauche reçoit un TABLEAU des lignes droites matchées
	//    sous le champ `as` (comportement historique, cf. ADR-008). Adapté aux
	//    relations one-to-many / many-to-many. Les refs `alias.field` en pick/where
	//    ne sont pas résolvables — utiliser `pick alias` pour l'array complet.
	//  - `join` : LEFT JOIN classique, `alias` = **une** row unique projetée à côté
	//    des colonnes de la source. Refs `alias.field` deviennent des refs SQL
	//    directes. Adapté aux relations many-to-one / one-to-one.
	// Choisi au lower : mot-clé user (`with one`/`with many`) prioritaire, sinon
	// inférence via SchemaModel, sinon fallback `embed`.
	| {
			readonly op: "join";
			readonly input: LogicalPlan;
			readonly collection: string;
			readonly as: string;
			readonly localField: readonly string[];
			readonly foreignField: readonly string[];
			readonly kind: "embed" | "join";
	  };

/** Une affectation de colonne dans un `update` : `column = value`. */
export interface PlanColumnValue {
	readonly column: string;
	readonly value: PlanExpr;
}

/**
 * Plan de **mutation** (écriture). Contrairement au [[LogicalPlan]] de lecture,
 * ce n'est pas une chaîne d'opérateurs linéaire : chaque mutation porte sa cible,
 * son prédicat, ses valeurs. Exige la capacité `mutate`.
 */
export type MutationPlan =
	| {
			readonly op: "insert";
			readonly collection: string;
			readonly columns: readonly string[];
			// Une ligne = un tuple de valeurs aligné sur `columns`.
			readonly rows: readonly (readonly SqlValue[])[];
	  }
	| {
			readonly op: "update";
			readonly collection: string;
			readonly assignments: readonly PlanColumnValue[];
			// Absent = toutes les lignes (write non filtré, assumé).
			readonly predicate?: PlanExpr;
	  }
	| {
			readonly op: "delete";
			readonly collection: string;
			readonly predicate?: PlanExpr;
	  };

/** Un plan complet : lecture ou mutation. */
export type Plan = LogicalPlan | MutationPlan;

export type PlanOp = LogicalPlan["op"];

/** Capacité exigée par chaque opérateur — consommé par le planner (Slice 3). */
export const REQUIRED_CAPABILITY: Readonly<Record<PlanOp, Capability>> = {
	scan: "scan",
	filter: "filter",
	project: "project",
	sort: "sort",
	limit: "paginate",
	join: "join"
};

export function requiredCapability(plan: LogicalPlan): Capability {
	return REQUIRED_CAPABILITY[plan.op];
}

/** Linéarise la chaîne d'opérateurs, du scan (interne) vers l'extérieur. */
export function linearize(plan: LogicalPlan): LogicalPlan[] {
	const ops: LogicalPlan[] = [];
	let current: LogicalPlan = plan;
	while (current.op !== "scan") {
		ops.push(current);
		current = current.input;
	}
	ops.push(current);
	ops.reverse();
	return ops;
}
