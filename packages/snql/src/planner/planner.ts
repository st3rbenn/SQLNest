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
function assertFunctionsSupported(
	plan: LogicalPlan,
	capabilities: Capabilities
): void {
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
function visitPlanCalls(
	plan: LogicalPlan,
	visit: (name: string) => void
): void {
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
	} else if (
		plan.op === "insert" &&
		plan.onConflict?.action.kind === "update"
	) {
		for (const a of plan.onConflict.action.assignments)
			visitExprCasts(a.value, visitor);
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
 * PA/4 (ADR-024-A) — refuse au planner les casts type coercitifs ambigus
 * (`bool`, `date`, `timestamp`) dans le predicate d'un update/delete Mongo.
 *
 * Motif : Mongo `$convert` truthy sur string non-vide (tout devient true sauf
 * empty) et parse ISO 8601 permissif — divergent des règles strictes PG.
 * Rewrite $expr+$convert marcherait syntaxiquement mais silencieusement
 * corromprait le résultat sur un delete (rows matchées trop larges ou nulles).
 * Refus explicit → user matérialise côté application ou utilise la valeur brute.
 *
 * Les autres casts (int↔text, decimal↔float, etc.) sont acceptés et routés
 * par le codegen mongo vers pipeline update avec `$expr: {$convert: ...}`.
 */
export function assertMongoMutationWriteCastCoercive(
	plan: MutationPlan,
	capabilities: Capabilities
): void {
	if (capabilities.engine !== "mongodb") return;
	const predicate = getMutationPredicate(plan);
	if (predicate === undefined) return;
	const bad: { target: CastTarget; span: Span | undefined } | null =
		findFirstCoerciveCast(predicate);
	if (bad === null) return;
	throw new SnqlError(
		`cast(_ as ${bad.target}) dans un filtre de mutation Mongo non supporté v1 — Mongo $convert truthy/permissif divergent de PG strict, refus explicite pour éviter silent-corruption. Matérialise la valeur convertie côté application, ou utilise un filtre sur la valeur brute (ex: 'where field = <literal>').`,
		"planner_mongo_write_cast_coercive_v3",
		bad.span
	);
}

function getMutationPredicate(plan: MutationPlan): PlanExpr | undefined {
	if (plan.op === "update" || plan.op === "delete") return plan.predicate;
	return undefined;
}

function findFirstCoerciveCast(
	expr: PlanExpr
): { target: CastTarget; span: Span | undefined } | null {
	const isCoercive = (t: CastTarget): boolean =>
		t === "bool" || t === "date" || t === "timestamp";
	const walk = (e: PlanExpr): {
		target: CastTarget;
		span: Span | undefined;
	} | null => {
		switch (e.kind) {
			case "cast":
				if (isCoercive(e.target)) return { target: e.target, span: e.span };
				return walk(e.operand);
			case "and":
			case "or":
			case "compare":
			case "arith": {
				const l = walk(e.left);
				if (l !== null) return l;
				return walk(e.right);
			}
			case "not":
			case "isNull":
				return walk(e.operand);
			case "in": {
				const t = walk(e.target);
				if (t !== null) return t;
				for (const v of e.values) {
					const n = walk(v);
					if (n !== null) return n;
				}
				return null;
			}
			case "call":
			case "windowCall":
				for (const a of e.args) {
					const n = walk(a);
					if (n !== null) return n;
				}
				return null;
			case "case":
				for (const b of e.branches) {
					const c = walk(b.cond);
					if (c !== null) return c;
					const v = walk(b.value);
					if (v !== null) return v;
				}
				return walk(e.elseValue);
			case "object":
				for (const en of e.entries) {
					const n = walk(en.value);
					if (n !== null) return n;
				}
				return null;
			case "array":
				for (const i of e.items) {
					const n = walk(i);
					if (n !== null) return n;
				}
				return null;
			case "literal":
			case "field":
			case "subquery":
			case "exists":
			case "upsertNew":
				return null;
		}
	};
	return walk(expr);
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
	if (
		plan.op !== "update" ||
		plan.joins === undefined ||
		plan.joins.length === 0
	)
		return;
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
	plan: import("../ir/plan").TransactionPlan,
	capabilities: Capabilities
): void {
	if (!capabilities.supports.has("transaction")) {
		throw new SnqlError(
			`'transaction { … }' non supporté sur '${capabilities.engine}' — capability 'transaction' absente. Pour Postgres, cette syntaxe cible BEGIN/COMMIT natif ; les autres engines exécutent les statements individuellement.`,
			"planner_transaction_unsupported"
		);
	}
	// ADR-024 PM/7 D5 — savepoint refusé au planner walker récursif (Mongo
	// n'a pas d'API rollback partiel dans une session tx). Le refus ex-tardif
	// dans codegen mongodb.ts:flattenMongoTransactionBody reste en place comme
	// defense-in-depth. Cohérent doctrine T2/11-15 (refus au planner + squiggly
	// UI live via useLiveDiagnostics).
	if (capabilities.engine === "mongodb") {
		assertNoSavepoint(plan.body, capabilities);
	}
}

function assertNoSavepoint(
	body: readonly import("../ir/plan").TransactionPlanItem[],
	capabilities: Capabilities
): void {
	for (const item of body) {
		if (item.kind === "savepoint") {
			// #11 — savepoint nested aussi refusé (walker récursif) même si le
			// parser accepte savepoint dans savepoint. Le message pointe le nom
			// racine pour diagnostic.
			throw new SnqlError(
				`'savepoint ${item.name} { … }' non supporté sur '${capabilities.engine}' — Mongo n'a pas d'API rollback partiel dans une session tx (ADR-024 Q6b). Refactor : découpe en transactions plus petites et gère la logique compensatoire côté application.`,
				"planner_savepoint_mongo_unsupported"
			);
		}
		// read/write items ne contiennent pas de savepoints imbriqués (les
		// TransactionPlanItem.body vit uniquement dans savepoint kind). Pas
		// besoin de walker profond ici — savepoint racine refusé suffit.
	}
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

/**
 * Sprint T3/6 : refuse `let x = ...; body` si l'engine n'a pas la capability
 * `cte`. Mongo pourrait matérialiser via $lookup sub-pipeline mais complexité
 * pas justifiée v1 — l'user peut re-écrire manuellement en subquery.
 */
export function assertLetSupported(
	_plan: import("../ir/plan").LetPlan,
	capabilities: Capabilities
): void {
	if (capabilities.supports.has("cte")) return;
	throw new SnqlError(
		`'let' (CTE) non supporté sur '${capabilities.engine}' — réécris la requête sans CTE (ex: subquery in-line).`,
		"planner_let_unsupported"
	);
}

export function toCompensationOp(op: LogicalPlan): CompensationOp {
	switch (op.op) {
		case "filter":
			return { op: "filter", predicate: op.predicate };
		case "project":
			return {
				op: "project",
				fields: op.fields,
				...(op.unique === true ? { unique: true as const } : {}),
				...(op.distinctOnKeys !== undefined
					? { distinctOnKeys: op.distinctOnKeys }
					: {})
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
		// ADR-024 PM/6 item #12 — retiré : `where col = {n:1}` sur Mongo est
		// désormais autorisé. La comparaison BSON object literal fonctionne
		// nativement côté driver (ordre des clés préservé lors de la
		// sérialisation). Divergence order-sensitivity documentée dans
		// divergences.yaml (PM/8) via squiggly INFO éditeur (D8).
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
 * Sprint T2/11 + ADR-024 PM/2 : refus sub-queries selon la capacité et la
 * stratégie de l'engine.
 *  - Pas de capability `subquery` (KV) : refus total (uncorrelated ET
 *    correlated). Message pointant l'attente cross-engine subquery support.
 *  - Strategy `native` (PG) : tout passe, pushdown SQL natif.
 *  - Strategy `materialize` (Mongo, PM/2) : uncorrelated OK (résolue via
 *    `materializeSubplan` au runtime), correlated refusée avec message
 *    actionnable — matérialisation impose 1 exécution par row outer, infra
 *    scope-stack v3+ (voir ADR-024 §Q2 requalifié).
 */
function assertSubqueryCapability(
	plan: LogicalPlan,
	capabilities: Capabilities
): void {
	if (!capabilities.supports.has("subquery")) {
		visitPlanExprs(plan, (expr) => {
			if (expr.kind === "subquery" || expr.kind === "exists") {
				throw new SnqlError(
					`Sub-query (${expr.kind === "exists" ? "exists" : "in"}) non supportée sur '${capabilities.engine}' — capability 'subquery' absente.`,
					"planner_subquery_unsupported",
					expr.span
				);
			}
		});
		return;
	}
	if (capabilities.subqueryStrategy === "materialize") {
		assertUncorrelatedSubqueryForMaterialize(plan, capabilities);
	}
}

/**
 * ADR-024 PM/2 → PA/1 (ADR-024-A) — walker planner qui gouverne les
 * sub-queries corrélées côté engine à stratégie `materialize` (Mongo).
 *
 * PM/2 (historique) : toute corrélée refusée `planner_subquery_unsupported`
 * → matérialisation en 1 shot incapable de porter N+1 exécutions.
 *
 * PA/1 (courant) : les corrélées liftables via `$lookup{let, pipeline}` (5.0+)
 * sont acceptées, le codegen Mongo les rewrite en lift-lookup. On ne refuse
 * plus qu'à l'entrée des patterns non-MVP :
 *  - corrélée nested 2+ niveaux avec cross-refs → `planner_correlated_subquery_nested_v3`
 *  - corrélée sous OR/NOT/case (disjonction) → `planner_correlated_subquery_in_disjunction_v3`
 *  - sub-find complexe (sort/limit/aggregate/join dans le sub) → `planner_correlated_subquery_complex_v3`
 *
 * Nom historique conservé pour compat callers (`run.ts`, tests) — voir alias
 * `assertCorrelatedSubqueryLiftable` ci-dessous.
 */
export function assertUncorrelatedSubqueryForMaterialize(
	plan: LogicalPlan,
	capabilities: Capabilities
): void {
	visitPlanRootExprs(plan, (rootExpr, context) => {
		if (context === "having") {
			assertNoCorrelatedInHaving(rootExpr, capabilities);
			return;
		}
		assertCorrelatedSubqueryInRootExpr(rootExpr, capabilities);
	});
}

/**
 * PA/1 MVP scope : le lift-lookup n'est câblé que dans `appendStage` case
 * "filter" du codegen Mongo — le having d'aggregate passe par une autre voie
 * (`renderAggregatePipeline`) qui n'a pas encore l'extract correspondant.
 * Refus explicite en amont pour éviter un refus tardif codegen.
 */
function assertNoCorrelatedInHaving(
	root: PlanExpr,
	capabilities: Capabilities
): void {
	const walk = (expr: PlanExpr): void => {
		switch (expr.kind) {
			case "subquery":
			case "exists": {
				const subplan =
					expr.kind === "subquery" ? expr.plan : expr.subplan;
				if (detectOuterAliasesInSubplan(subplan).length > 0) {
					throw new SnqlError(
						`Sub-query corrélée dans un 'having' non supportée v1 sur '${capabilities.engine}' (PA/1 MVP : lift-lookup câblé sur le 'where' uniquement) — extrais la corrélée avant le group by, ou utilise 'let' matérialisé.`,
						"planner_correlated_subquery_complex_v3",
						expr.span
					);
				}
				return;
			}
			case "and":
			case "or":
			case "compare":
			case "arith":
				walk(expr.left);
				walk(expr.right);
				return;
			case "not":
			case "isNull":
			case "cast":
				walk(expr.operand);
				return;
			case "in":
				walk(expr.target);
				for (const v of expr.values) walk(v);
				return;
			case "call":
			case "windowCall":
				for (const a of expr.args) walk(a);
				return;
			case "case":
				for (const b of expr.branches) {
					walk(b.cond);
					walk(b.value);
				}
				walk(expr.elseValue);
				return;
			case "object":
				for (const e of expr.entries) walk(e.value);
				return;
			case "array":
				for (const i of expr.items) walk(i);
				return;
			case "literal":
			case "field":
			case "upsertNew":
				return;
		}
	};
	walk(root);
}

export { assertUncorrelatedSubqueryForMaterialize as assertCorrelatedSubqueryLiftable };

/**
 * Walker par-racine du predicate/having : traverse en tracking si on descend
 * sous une disjonction (OR/NOT/case). Chaque subquery/exists rencontré est
 * classifié uncorrelated (skip) ou correlated (checks MVP).
 */
function assertCorrelatedSubqueryInRootExpr(
	root: PlanExpr,
	capabilities: Capabilities
): void {
	const walk = (expr: PlanExpr, insideDisjunction: boolean): void => {
		switch (expr.kind) {
			case "and":
				walk(expr.left, insideDisjunction);
				walk(expr.right, insideDisjunction);
				return;
			case "or":
				walk(expr.left, true);
				walk(expr.right, true);
				return;
			case "not":
				// Cas spécial `not exists (correlated)` : pattern liftable direct
				// (émet `{__sq_N: {$eq: []}}`), donc le `not` ne bascule pas en
				// disjonction. Autres `not(...)` restent traités comme disjonction.
				walk(
					expr.operand,
					expr.operand.kind === "exists" ? insideDisjunction : true
				);
				return;
			case "case":
				for (const b of expr.branches) {
					walk(b.cond, true);
					walk(b.value, true);
				}
				walk(expr.elseValue, true);
				return;
			case "compare":
			case "arith":
				walk(expr.left, insideDisjunction);
				walk(expr.right, insideDisjunction);
				return;
			case "isNull":
			case "cast":
				walk(expr.operand, insideDisjunction);
				return;
			case "in":
				walk(expr.target, insideDisjunction);
				for (const v of expr.values) walk(v, insideDisjunction);
				return;
			case "call":
			case "windowCall":
				for (const a of expr.args) walk(a, insideDisjunction);
				return;
			case "object":
				for (const e of expr.entries) walk(e.value, insideDisjunction);
				return;
			case "array":
				for (const i of expr.items) walk(i, insideDisjunction);
				return;
			case "subquery":
			case "exists": {
				const subplan =
					expr.kind === "subquery" ? expr.plan : expr.subplan;
				const outerAliases = detectOuterAliasesInSubplan(subplan);
				if (outerAliases.length === 0) return;
				const first = outerAliases[0]!;
				assertCorrelatedSubqueryLiftableShape(
					subplan,
					outerAliases,
					insideDisjunction,
					capabilities,
					first,
					expr.span
				);
				return;
			}
			case "literal":
			case "field":
			case "upsertNew":
				return;
		}
	};
	walk(root, false);
}

/**
 * PA/1 MVP gates — refuse les patterns non-liftables avec un code typé.
 * Le sub-find liftable = `find <coll> [as a] where <predicate ref outer> [pick col]`.
 */
function assertCorrelatedSubqueryLiftableShape(
	subplan: LogicalPlan,
	outerAliases: readonly string[],
	insideDisjunction: boolean,
	capabilities: Capabilities,
	firstOuterAlias: string,
	span: Span | undefined
): void {
	if (insideDisjunction) {
		throw new SnqlError(
			`Sub-query corrélée sous OR/NOT/case non supportée sur '${capabilities.engine}' (PA/1 MVP : lift-lookup accepte le predicate racine et les AND top-level uniquement) — remonte la corrélée hors de la disjonction, ou refactor en 'with one'. Ticket v3+ : rewrite $lookup dans une $facet branche.`,
			"planner_correlated_subquery_in_disjunction_v3",
			span
		);
	}
	if (outerAliases.length > 1) {
		throw new SnqlError(
			`Sub-query corrélée référence plusieurs alias outer (${outerAliases.map((a) => `'${a}'`).join(", ")}) non supportée v1 (PA/1 MVP : 1 alias outer max). Ticket v3+ : $lookup{let} multi-vars.`,
			"planner_correlated_subquery_nested_v3",
			span
		);
	}
	const ops = linearize(subplan);
	for (const op of ops) {
		switch (op.op) {
			case "scan":
			case "filter":
				break;
			case "project": {
				for (const f of op.fields) {
					if (f.expr !== undefined && f.expr.kind !== "field") {
						throw new SnqlError(
							`Sub-query corrélée avec projection calculée non supportée v1 (PA/1 MVP : pick de champs simples uniquement) — extrais l'expression avant.`,
							"planner_correlated_subquery_complex_v3",
							span
						);
					}
				}
				break;
			}
			case "sort":
			case "limit":
			case "aggregate":
			case "join":
				throw new SnqlError(
					`Sub-query corrélée avec stage '${op.op}' non supportée v1 (PA/1 MVP : scan + filter + pick simples uniquement) — refactor via 'let' matérialisé, ou attends le lift-lookup complet v3.`,
					"planner_correlated_subquery_complex_v3",
					span
				);
		}
	}
	visitPlanRootExprs(subplan, (rootExpr) => {
		const nested = findNestedSubquery(rootExpr);
		if (nested !== null) {
			throw new SnqlError(
				`Sub-query corrélée avec sub-query imbriquée dans le sub-find non supportée v1 (PA/1 MVP : 1 niveau de corrélation) — remonte la seconde au niveau outer. Alias outer référencé : '${firstOuterAlias}'.`,
				"planner_correlated_subquery_nested_v3",
				nested.span ?? span
			);
		}
	});
}

/** Cherche récursivement la première subquery/exists imbriquée dans une expression. */
function findNestedSubquery(expr: PlanExpr): PlanExpr | null {
	switch (expr.kind) {
		case "subquery":
		case "exists":
			return expr;
		case "and":
		case "or":
		case "compare":
		case "arith": {
			const l = findNestedSubquery(expr.left);
			if (l !== null) return l;
			return findNestedSubquery(expr.right);
		}
		case "not":
		case "isNull":
		case "cast":
			return findNestedSubquery(expr.operand);
		case "in": {
			const t = findNestedSubquery(expr.target);
			if (t !== null) return t;
			for (const v of expr.values) {
				const n = findNestedSubquery(v);
				if (n !== null) return n;
			}
			return null;
		}
		case "call":
		case "windowCall":
			for (const a of expr.args) {
				const n = findNestedSubquery(a);
				if (n !== null) return n;
			}
			return null;
		case "case":
			for (const b of expr.branches) {
				const c = findNestedSubquery(b.cond);
				if (c !== null) return c;
				const v = findNestedSubquery(b.value);
				if (v !== null) return v;
			}
			return findNestedSubquery(expr.elseValue);
		case "object":
			for (const e of expr.entries) {
				const n = findNestedSubquery(e.value);
				if (n !== null) return n;
			}
			return null;
		case "array":
			for (const i of expr.items) {
				const n = findNestedSubquery(i);
				if (n !== null) return n;
			}
			return null;
		case "literal":
		case "field":
		case "upsertNew":
			return null;
	}
}

/**
 * Walker qui invoque `visit` sur chaque expression-racine d'un plan (predicate
 * de filter, having d'aggregate). Contrairement à `visitPlanExprs` qui envoie
 * chaque sous-expression individuellement, celui-ci envoie la racine complète
 * pour permettre au caller de tracker le contexte (ex. disjonction).
 */
function visitPlanRootExprs(
	plan: LogicalPlan,
	visit: (rootExpr: PlanExpr, context: "predicate" | "having") => void
): void {
	const ops = linearize(plan);
	for (const op of ops) {
		switch (op.op) {
			case "filter":
				visit(op.predicate, "predicate");
				break;
			case "aggregate":
				if (op.having !== undefined) visit(op.having, "having");
				break;
			case "project":
			case "sort":
			case "limit":
			case "join":
			case "scan":
				break;
		}
	}
}

/**
 * Détecte les alias externes référencés dans un sub-plan — extrait de
 * `packages/engine/src/run.ts` PM/2 (D2 walker déplacé au planner). Un alias
 * distinct du scan racine local = corrélation. Récursion sur subquery/exists
 * imbriqués pour couvrir corrélations 2+ niveaux.
 */
function detectOuterAliasesInSubplan(subPlan: LogicalPlan): string[] {
	const ops = linearize(subPlan);
	const scan = ops[0];
	if (scan?.op !== "scan") return [];
	const localAlias = scan.alias;
	const found = new Set<string>();

	const scanExpr = (expr: PlanExpr): void => {
		switch (expr.kind) {
			case "field":
				if (expr.path.length > 1) {
					const head = expr.path[0]!;
					if (head !== localAlias) found.add(head);
				}
				return;
			case "compare":
			case "arith":
			case "and":
			case "or":
				scanExpr(expr.left);
				scanExpr(expr.right);
				return;
			case "not":
				scanExpr(expr.operand);
				return;
			case "isNull":
			case "cast":
				scanExpr(expr.operand);
				return;
			case "call":
			case "windowCall":
				for (const a of expr.args) scanExpr(a);
				return;
			case "in":
				scanExpr(expr.target);
				for (const v of expr.values) scanExpr(v);
				return;
			case "case":
				for (const b of expr.branches) {
					scanExpr(b.cond);
					scanExpr(b.value);
				}
				scanExpr(expr.elseValue);
				return;
			case "object":
				for (const e of expr.entries) scanExpr(e.value);
				return;
			case "array":
				for (const i of expr.items) scanExpr(i);
				return;
			case "subquery":
				for (const outerHead of detectOuterAliasesInSubplan(expr.plan)) {
					if (outerHead !== localAlias) found.add(outerHead);
				}
				return;
			case "exists":
				for (const outerHead of detectOuterAliasesInSubplan(expr.subplan)) {
					if (outerHead !== localAlias) found.add(outerHead);
				}
				return;
			case "literal":
			case "upsertNew":
				return;
		}
	};

	for (const op of ops.slice(1)) {
		switch (op.op) {
			case "filter":
				scanExpr(op.predicate);
				break;
			case "aggregate":
				if (op.having !== undefined) scanExpr(op.having);
				break;
			case "project":
				for (const f of op.fields) if (f.expr !== undefined) scanExpr(f.expr);
				break;
			case "sort":
			case "limit":
			case "join":
			case "scan":
				break;
		}
	}
	return [...found];
}

/** Exposé pour reuse — D16 lowerLet a besoin du même walker. */
export { detectOuterAliasesInSubplan };

function assertAggregateEngineRestrictions(
	plan: LogicalPlan,
	capabilities: Capabilities
): void {
	if (capabilities.engine === "postgres") return;
	// ADR-024 PM/6 item #5 — sum(unique)/avg(unique) désormais supportés sur
	// Mongo via SSA slot 2-stage $addToSet + $sum/$avg (mongodb.ts). KV reste
	// hors scope. Le refus n'est levé que pour les engines non-supportés.
	if (capabilities.engine === "mongodb") return;
	visitPlanExprs(plan, (expr) => {
		if (expr.kind !== "call" || expr.unique !== true) return;
		const entry = SNQL_FUNCTIONS.get(expr.name);
		if (entry?.kind !== "aggregate") return;
		if (expr.name === "sum" || expr.name === "avg") {
			throw new SnqlError(
				`'${expr.name}(unique ...)' non supporté sur '${capabilities.engine}' — utilise 'count(unique x)' ou matérialise côté application`,
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
