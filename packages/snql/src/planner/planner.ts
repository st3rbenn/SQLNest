import { SnqlError } from "../diagnostics";
import { SNQL_FUNCTIONS } from "../functions";
import type {
	Capability,
	CastTarget,
	LogicalPlan,
	MutationPlan,
	PlanExpr,
	PlanProjectField,
	PlanSortKey
} from "../ir/plan";
import { linearize, requiredCapability } from "../ir/plan";
import type { Span } from "../lexer/token";
import type { Capabilities } from "./capabilities";

/**
 * Opérateur de compensation : à appliquer dans le runtime SNQL, au-dessus du
 * résultat du pushdown. Sans `input` : chaque op s'applique aux rows de la précédente.
 * Le `join` a besoin des données de la collection droite (fournies au runtime).
 */
export type CompensationOp =
	| { readonly op: "filter"; readonly predicate: PlanExpr }
	// Sprint T2/10 : unique / distinctOnKeys propagés en compensation KV.
	| {
			readonly op: "project";
			readonly fields: readonly PlanProjectField[];
			readonly unique?: true;
			readonly distinctOnKeys?: readonly (readonly string[])[];
	  }
	| { readonly op: "sort"; readonly keys: readonly PlanSortKey[] }
	| { readonly op: "limit"; readonly count: number; readonly offset?: number }
	| {
			readonly op: "join";
			readonly collection: string;
			readonly as: string;
			readonly localField: readonly string[];
			readonly foreignField: readonly string[];
	  }
	// Sprint T2/6 : agrégation scalaire fold. Runtime KV implémente via
	// foldAggregate (1 row output sprint 6). groupKeys undefined = fold sur
	// toute la collection ; sprint 7 le peuple pour bucket + having.
	| {
			readonly op: "aggregate";
			readonly fields: readonly PlanProjectField[];
			readonly groupKeys?: readonly (readonly string[])[];
			readonly having?: PlanExpr;
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
	// Vérifie que tous les targets de cast sont supportés par l'engine.
	assertCastTargetsSupported(logical, capabilities);
	// Guards JSON engine-specific : redirige cast(json_get) et compare direct
	// json_get vers les alternatives actionnables avant que PG throw 42883.
	assertJsonPredicatesPg(logical, capabilities);
	// Sprint T2/6 : refus sum(unique)/avg(unique) sur Mongo (2-stage $addToSet
	// spec reportée sprint 8 avec aggregateMulti). count(unique) marche partout.
	assertAggregateEngineRestrictions(logical, capabilities);
	// Sprint T2/11 : refus sub-queries si l'engine n'a pas la capability
	// (Mongo/KV v1). Message actionable.
	assertSubqueryCapability(logical, capabilities);

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
		case "aggregate":
			for (const field of plan.fields) {
				if (field.expr !== undefined) visitExprCalls(field.expr, visit);
			}
			if (plan.having !== undefined) visitExprCalls(plan.having, visit);
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
		case "cast":
			// Cast n'est pas une fonction du registre, mais un `call` sous cast doit
			// être visité (ex: cast(pg_only_fn(x) as text) sur mongo → détecte pg_only_fn).
			visitExprCalls(expr.operand, visit);
			return;
		case "object":
			for (const entry of expr.entries) visitExprCalls(entry.value, visit);
			return;
		case "array":
			for (const item of expr.items) visitExprCalls(item, visit);
			return;
		case "case":
			for (const branch of expr.branches) {
				visitExprCalls(branch.cond, visit);
				visitExprCalls(branch.value, visit);
			}
			visitExprCalls(expr.elseValue, visit);
			return;
		case "windowCall":
			// Sprint T2/9 : visite le nom + args (partition/sort keys sont
			// des paths, aucune fonction dedans).
			visit(expr.name);
			for (const arg of expr.args) visitExprCalls(arg, visit);
			return;
		case "subquery":
			// Sprint T2/11 : descend dans le subplan pour vérifier ses
			// fonctions supportées (cohérence engine sur toute la query).
			visitPlanCalls(expr.plan, visit);
			return;
		case "exists":
			visitPlanCalls(expr.subplan, visit);
			return;
		case "upsertNew":
			// Sprint T2/13 : leaf, aucune fn à visiter.
			return;
	}
}

/**
 * Cast capability check — vérifie que chaque `cast(_ as T)` cible un T
 * supporté par l'engine (`Capabilities.castTargets`). Lève
 * `planner_cast_target_unsupported` avec un message dédié pour le cas notable
 * `cast(_ as json)` sur MongoDB (les documents Mongo sont déjà des BSON).
 */
function assertCastTargetsSupported(
	plan: LogicalPlan,
	capabilities: Capabilities
): void {
	const unsupported = new Map<CastTarget, Span | undefined>();
	visitPlanCasts(plan, (target, span) => {
		if (!capabilities.castTargets.has(target) && !unsupported.has(target)) {
			unsupported.set(target, span);
		}
	});
	if (unsupported.size === 0) return;
	const [target, span] = [...unsupported.entries()][0]!;
	const message =
		target === "json" && capabilities.engine === "mongodb"
			? "cast(_ as json) non supporté sur mongodb — les documents Mongo sont déjà des BSON, aucun cast nécessaire"
			: `cast(_ as ${target}) non supporté sur '${capabilities.engine}'`;
	throw new SnqlError(message, "planner_cast_target_unsupported", span);
}

/** Walker qui invoque `visit(target)` pour chaque cast rencontré dans le plan. */
function visitPlanCasts(
	plan: LogicalPlan,
	visit: (target: CastTarget, span: Span | undefined) => void
): void {
	switch (plan.op) {
		case "scan":
			return;
		case "filter":
			visitExprCasts(plan.predicate, visit);
			visitPlanCasts(plan.input, visit);
			return;
		case "project":
			for (const field of plan.fields) {
				if (field.expr !== undefined) visitExprCasts(field.expr, visit);
			}
			visitPlanCasts(plan.input, visit);
			return;
		case "aggregate":
			for (const field of plan.fields) {
				if (field.expr !== undefined) visitExprCasts(field.expr, visit);
			}
			if (plan.having !== undefined) visitExprCasts(plan.having, visit);
			visitPlanCasts(plan.input, visit);
			return;
		case "sort":
		case "limit":
			visitPlanCasts(plan.input, visit);
			return;
		case "join":
			visitPlanCasts(plan.input, visit);
			return;
	}
}

function visitExprCasts(
	expr: PlanExpr,
	visit: (target: CastTarget, span: Span | undefined) => void
): void {
	switch (expr.kind) {
		case "literal":
		case "field":
			return;
		case "cast":
			visit(expr.target, expr.span);
			visitExprCasts(expr.operand, visit);
			return;
		case "call":
			for (const arg of expr.args) visitExprCasts(arg, visit);
			return;
		case "arith":
		case "compare":
		case "and":
		case "or":
			visitExprCasts(expr.left, visit);
			visitExprCasts(expr.right, visit);
			return;
		case "not":
		case "isNull":
			visitExprCasts(expr.operand, visit);
			return;
		case "in":
			visitExprCasts(expr.target, visit);
			for (const v of expr.values) visitExprCasts(v, visit);
			return;
		case "object":
			for (const entry of expr.entries) visitExprCasts(entry.value, visit);
			return;
		case "array":
			for (const item of expr.items) visitExprCasts(item, visit);
			return;
		case "case":
			for (const branch of expr.branches) {
				visitExprCasts(branch.cond, visit);
				visitExprCasts(branch.value, visit);
			}
			visitExprCasts(expr.elseValue, visit);
			return;
		case "windowCall":
			for (const arg of expr.args) visitExprCasts(arg, visit);
			return;
		case "subquery":
			visitPlanCasts(expr.plan, visit);
			return;
		case "exists":
			visitPlanCasts(expr.subplan, visit);
			return;
		case "upsertNew":
			return;
	}
}

/**
 * Cast capability check pour les mutations : les update/delete peuvent contenir
 * des casts dans leur predicate ou dans les valeurs de `set` (autorisés par le
 * lower). Symétrique de `assertCastTargetsSupported` pour lecture.
 */
export function assertMutationCastTargetsSupported(
	plan: MutationPlan,
	capabilities: Capabilities
): void {
	const unsupported = new Map<CastTarget, Span | undefined>();
	const visitor = (target: CastTarget, span: Span | undefined): void => {
		if (!capabilities.castTargets.has(target) && !unsupported.has(target)) {
			unsupported.set(target, span);
		}
	};
	if (plan.op === "update") {
		for (const a of plan.assignments) visitExprCasts(a.value, visitor);
		if (plan.predicate !== undefined) visitExprCasts(plan.predicate, visitor);
	} else if (plan.op === "delete") {
		if (plan.predicate !== undefined) visitExprCasts(plan.predicate, visitor);
	} else if (plan.op === "insert" && plan.onConflict?.action.kind === "update") {
		for (const a of plan.onConflict.action.assignments) visitExprCasts(a.value, visitor);
		if (plan.onConflict.action.where !== undefined) {
			visitExprCasts(plan.onConflict.action.where, visitor);
		}
	}
	if (unsupported.size === 0) return;
	const [target, span] = [...unsupported.entries()][0]!;
	const message =
		target === "json" && capabilities.engine === "mongodb"
			? "cast(_ as json) non supporté sur mongodb — les documents Mongo sont déjà des BSON, aucun cast nécessaire"
			: `cast(_ as ${target}) non supporté sur '${capabilities.engine}'`;
	throw new SnqlError(message, "planner_cast_target_unsupported", span);
}

/**
 * Sprint T2/13 : refuse `add {…} into t on conflict (…) …` si l'engine cible
 * n'a pas la capability `upsert`. Message actionable : Mongo a un upsert
 * natif mais sémantique différente (updateOne(upsert:true) sur un full doc),
 * pas de v1 côté SQLNest.
 */
export function assertMutationUpsertSupported(
	plan: MutationPlan,
	capabilities: Capabilities
): void {
	if (plan.op !== "insert" || plan.onConflict === undefined) return;
	if (capabilities.supports.has("upsert")) return;
	throw new SnqlError(
		`'on conflict (…)' non supporté sur '${capabilities.engine}' — capability 'upsert' absente. Pour Postgres, cette syntaxe cible ON CONFLICT natif ; les autres engines matérialisent l'upsert côté application.`,
		"planner_upsert_unsupported"
	);
}

/**
 * Sprint T2/14 : refuse `update t with one X on l=f set …` si l'engine cible
 * n'a pas la capability `write-join`. Message actionable : PG natif via
 * `UPDATE ... FROM` ; Mongo passe par `aggregate + $merge` (à réévaluer plus
 * tard), KV n'a pas la notion de join.
 */
export function assertMutationWriteJoinSupported(
	plan: MutationPlan,
	capabilities: Capabilities
): void {
	if (plan.op !== "update" || plan.joins === undefined || plan.joins.length === 0) return;
	if (capabilities.supports.has("write-join")) return;
	throw new SnqlError(
		`'update … with one …' non supporté sur '${capabilities.engine}' — capability 'write-join' absente. Pour Postgres, cette syntaxe cible UPDATE ... FROM natif ; les autres engines matérialisent le join côté application.`,
		"planner_write_join_unsupported"
	);
}

/**
 * Sprint T2/14 : refuse `add (find …) into t` si l'engine cible n'a pas la
 * capability `insert-select`. PG natif via `INSERT INTO ... SELECT`.
 */
export function assertMutationInsertSelectSupported(
	plan: MutationPlan,
	capabilities: Capabilities
): void {
	if (plan.op !== "insert" || plan.sourcePlan === undefined) return;
	if (capabilities.supports.has("insert-select")) return;
	throw new SnqlError(
		`'add (find …) into t' non supporté sur '${capabilities.engine}' — capability 'insert-select' absente. Pour Postgres, cette syntaxe cible INSERT ... SELECT natif ; les autres engines matérialisent le select côté application avant d'insérer.`,
		"planner_insert_select_unsupported"
	);
}

/**
 * Sprint T2/15 : refuse `transaction { … }` si l'engine cible n'a pas la
 * capability `transaction`. PG only v1 (BEGIN/COMMIT natif). Mongo/KV
 * hors scope — Mongo a des transactions multi-doc en replica set mais
 * sémantique différente (session-scoped), à réévaluer plus tard.
 */
export function assertTransactionSupported(
	_plan: import("../ir/plan").TransactionPlan,
	capabilities: Capabilities
): void {
	if (capabilities.supports.has("transaction")) return;
	throw new SnqlError(
		`'transaction { … }' non supporté sur '${capabilities.engine}' — capability 'transaction' absente. Pour Postgres, cette syntaxe cible BEGIN/COMMIT natif ; les autres engines exécutent les statements individuellement.`,
		"planner_transaction_unsupported"
	);
}

/**
 * Sprint T3/1 : refuse `list tables` / `describe …` / etc. si l'engine cible
 * n'a pas la capability `introspect`. Message actionable pointant les
 * alternatives (raw commands côté power user).
 */
export function assertIntrospectSupported(
	plan: import("../ir/plan").IntrospectPlan,
	capabilities: Capabilities
): void {
	if (capabilities.supports.has("introspect")) return;
	throw new SnqlError(
		`'${plan.kind}' non supporté sur '${capabilities.engine}' — capability 'introspect' absente. Utilise \`raw "…"\` (SQL) ou \`raw {…}\` (Mongo) pour les commandes natives.`,
		"planner_introspect_unsupported"
	);
}

function toCompensationOp(op: LogicalPlan): CompensationOp {
	switch (op.op) {
		case "filter":
			return { op: "filter", predicate: op.predicate };
		case "project":
			return {
				op: "project",
				fields: op.fields,
				...(op.unique === true ? { unique: true as const } : {}),
				...(op.distinctOnKeys !== undefined ? { distinctOnKeys: op.distinctOnKeys } : {})
			};
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
		case "aggregate":
			return {
				op: "aggregate",
				fields: op.fields,
				...(op.groupKeys !== undefined ? { groupKeys: op.groupKeys } : {}),
				...(op.having !== undefined ? { having: op.having } : {})
			};
		case "scan":
			throw new SnqlError(
				"Un 'scan' ne peut pas être compensé",
				"planner_scan_compensation"
			);
	}
}

/**
 * Guards JSON engine-specific (sprint 4). Actifs uniquement pour Postgres —
 * `cast(json_get(...) as T)` et `json_get(...) op literal` produisent des
 * SQL invalides (42883) car PG n'a pas de cast direct jsonb→primitive ni
 * d'opérateur jsonb=text. Redirection actionnable vers `json_get_text`.
 * Mongo n'a pas ce problème (dot notation / $expr sont naturellement typés).
 *
 * Sprint object-literals ajoute 3 guards :
 *  - `cast({...} as json)` : redondant, l'object literal est déjà de type json
 *  - `cast({...} as text)` : sérialisation non supportée v1 (json_stringify sprint 6+)
 *  - `cast({...} as int|float|bool|date|timestamp)` : impossible, utilise json_get_*
 *  - Refus `where col = {...}` sur Mongo (divergence order-sensitivity)
 *  - Refus `arith` sur object/array literal (opération non définie)
 */
function assertJsonPredicatesPg(
	plan: LogicalPlan,
	capabilities: Capabilities
): void {
	visitPlanExprs(plan, (expr) => {
		// Sprint object-literals — guards cast literal (cross-engine)
		if (expr.kind === "cast") {
			const operandKind = expr.operand.kind;
			if (operandKind === "object" || operandKind === "array") {
				if (expr.target === "json") {
					throw new SnqlError(
						`Un ${operandKind} literal est déjà de type json — retire cast()`,
						"plan_cast_literal_redundant",
						expr.span
					);
				}
				if (expr.target === "text") {
					throw new SnqlError(
						`Sérialisation d'un ${operandKind} literal en text non supportée v1 — attends json_stringify() (sprint 6+)`,
						"plan_cast_literal_to_text",
						expr.span
					);
				}
				throw new SnqlError(
					`Un ${operandKind} literal ne peut pas être cast en ${expr.target} — utilise json_get_*() pour extraire un scalaire`,
					"plan_cast_literal_to_scalar",
					expr.span
				);
			}
		}
		// Sprint object-literals — arith avec object/array literal
		if (
			expr.kind === "arith" &&
			(expr.left.kind === "object" ||
				expr.left.kind === "array" ||
				expr.right.kind === "object" ||
				expr.right.kind === "array")
		) {
			throw new SnqlError(
				"Opération arithmétique avec un object/array literal non définie — utilise json_merge (sprint 6+)",
				"lower_arith_object_literal",
				expr.span
			);
		}
		// Sprint object-literals — Mongo refuse where col = {...} (divergence)
		if (
			capabilities.engine === "mongodb" &&
			expr.kind === "compare" &&
			(expr.op === "eq" || expr.op === "ne") &&
			(expr.right.kind === "object" || expr.right.kind === "array")
		) {
			throw new SnqlError(
				`Comparaison directe avec un ${expr.right.kind} literal non supportée sur Mongo (divergence order-sensitivity) — utilise json_contains (sprint 6)`,
				"plan_mongo_compare_object_literal_unsupported",
				expr.right.span
			);
		}
		// Sprint 4 guards existants — PG only
		if (capabilities.engine !== "postgres") return;
		// Cas 1 : cast(json_get(...) as <primitive>) → planner_cast_from_jsonb_unsupported
		if (
			expr.kind === "cast" &&
			expr.operand.kind === "call" &&
			expr.operand.name === "json_get" &&
			expr.target !== "json" &&
			expr.target !== "text"
		) {
			throw new SnqlError(
				`cast(json_get(...) as ${expr.target}) non supporté PG — utilise cast(json_get_text(...) as ${expr.target}) (chain ->> puis cast primitif)`,
				"planner_cast_from_jsonb_unsupported",
				expr.span
			);
		}
		// Cas 2 : json_get(...) op literal → planner_json_get_compare_ambiguous
		if (
			expr.kind === "compare" &&
			expr.left.kind === "call" &&
			expr.left.name === "json_get" &&
			expr.right.kind === "literal"
		) {
			throw new SnqlError(
				"Compare direct sur json_get produit jsonb=text (PG 42883) — utilise json_get_text pour comparer un scalaire text",
				"planner_json_get_compare_ambiguous",
				expr.left.span
			);
		}
	});
}

/**
 * Sprint T2/6 : restrictions engine-spécifiques sur les aggregates.
 *  - Mongo : sum(unique x) / avg(unique x) refusés v6 (2-stage $addToSet
 *    reporté sprint 8 avec aggregateMulti). count(unique) marche partout.
 *  - PG accepte SUM/AVG(DISTINCT x) nativement, aucune restriction.
 *  - KV : sum(unique)/avg(unique) impl à venir (matérialisable), refus v6
 *    aligné Mongo pour cohérence cross-engine.
 */
/**
 * Sprint T2/11 : refus sub-queries si l'engine n'a pas la capability.
 * Aujourd'hui PG only. Mongo/KV : message dédié pointant T3+ (matérialisation
 * côté application ou attente cross-engine subquery support).
 */
function assertSubqueryCapability(
	plan: LogicalPlan,
	capabilities: Capabilities
): void {
	if (capabilities.supports.has("subquery")) return;
	visitPlanExprs(plan, (expr) => {
		if (expr.kind === "subquery" || expr.kind === "exists") {
			throw new SnqlError(
				`Sub-query (${expr.kind === "exists" ? "exists" : "in"}) non supportée sur '${capabilities.engine}' v1 — matérialise le résultat côté application ou attends le cross-engine subquery support (T3+)`,
				"planner_subquery_unsupported",
				expr.span
			);
		}
	});
}

function assertAggregateEngineRestrictions(
	plan: LogicalPlan,
	capabilities: Capabilities
): void {
	if (capabilities.engine === "postgres") return;
	visitPlanExprs(plan, (expr) => {
		if (expr.kind !== "call" || expr.unique !== true) return;
		const entry = SNQL_FUNCTIONS.get(expr.name);
		if (entry?.kind !== "aggregate") return;
		if (expr.name === "sum" || expr.name === "avg") {
			throw new SnqlError(
				`'${expr.name}(unique ...)' non supporté sur '${capabilities.engine}' sprint 6 — utilise 'count(unique x)' ou reporte sprint 8 (aggregateMulti 2-stage)`,
				"planner_agg_unique_mongo_unsupported_sum_avg",
				expr.span
			);
		}
	});
}

/** Walker générique sur tous les PlanExpr d'un plan (filter + project fields). */
function visitPlanExprs(
	plan: LogicalPlan,
	visit: (expr: PlanExpr) => void
): void {
	switch (plan.op) {
		case "scan":
			return;
		case "filter":
			visitExprsIn(plan.predicate, visit);
			visitPlanExprs(plan.input, visit);
			return;
		case "project":
			for (const field of plan.fields) {
				if (field.expr !== undefined) visitExprsIn(field.expr, visit);
			}
			visitPlanExprs(plan.input, visit);
			return;
		case "aggregate":
			for (const field of plan.fields) {
				if (field.expr !== undefined) visitExprsIn(field.expr, visit);
			}
			if (plan.having !== undefined) visitExprsIn(plan.having, visit);
			visitPlanExprs(plan.input, visit);
			return;
		case "sort":
		case "limit":
		case "join":
			visitPlanExprs(plan.input, visit);
			return;
	}
}

function visitExprsIn(expr: PlanExpr, visit: (e: PlanExpr) => void): void {
	visit(expr);
	switch (expr.kind) {
		case "literal":
		case "field":
			return;
		case "cast":
			visitExprsIn(expr.operand, visit);
			return;
		case "call":
			for (const arg of expr.args) visitExprsIn(arg, visit);
			return;
		case "arith":
		case "compare":
		case "and":
		case "or":
			visitExprsIn(expr.left, visit);
			visitExprsIn(expr.right, visit);
			return;
		case "not":
		case "isNull":
			visitExprsIn(expr.operand, visit);
			return;
		case "in":
			visitExprsIn(expr.target, visit);
			for (const v of expr.values) visitExprsIn(v, visit);
			return;
		case "object":
			for (const entry of expr.entries) visitExprsIn(entry.value, visit);
			return;
		case "array":
			for (const item of expr.items) visitExprsIn(item, visit);
			return;
		case "case":
			for (const branch of expr.branches) {
				visitExprsIn(branch.cond, visit);
				visitExprsIn(branch.value, visit);
			}
			visitExprsIn(expr.elseValue, visit);
			return;
		case "windowCall":
			for (const arg of expr.args) visitExprsIn(arg, visit);
			return;
		case "subquery":
			visitPlanExprs(expr.plan, visit);
			return;
		case "exists":
			visitPlanExprs(expr.subplan, visit);
			return;
		case "upsertNew":
			return;
	}
}
