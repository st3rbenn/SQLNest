import { SnqlError } from "../diagnostics";
import { checkArity, SNQL_FUNCTIONS } from "../functions";
import type {
	CastTarget,
	CompareOperator,
	Expr,
	LiteralValue
} from "../parser/ast";
import { CAST_TARGETS } from "../parser/ast";
import { lower } from "./lower-query";
import { scopeState } from "./lower-scope";
import type { CompareOp, PlanExpr, SqlValue } from "./plan";

/**
 * Expressions : champs, littéraux, comparaisons, appels de fonction,
 * fenêtres, chemins JSON, sous-requêtes.
 */

// Indice de flottant : présence d'un point décimal ou d'un exposant.
const FLOAT_HINT = /[.eE]/;

const COMPARE_MAP: Readonly<Record<CompareOperator, CompareOp>> = {
	"=": "eq",
	"!=": "ne",
	"<": "lt",
	">": "gt",
	"<=": "le",
	">=": "ge",
	like: "like"
};

export function lowerExpr(expr: Expr): PlanExpr {
	// Le span AST est propagé sur chaque node plan → Phase 3a-b (traçabilité
	// erreurs Postgres → source SNQL). Pour `compare`/`logical`/`not`/`in`,
	// on garde le span du node AST source ; `lowerCompare` peut le remplacer
	// par le span joint quand il canonicalise (isNull, flip d'opérandes).
	switch (expr.type) {
		case "literal":
			return {
				kind: "literal",
				value: literalToValue(expr.value),
				span: expr.span
			};
		case "field":
			return { kind: "field", path: expr.path, span: expr.span };
		case "compare":
			return lowerCompare(
				expr.operator,
				lowerExpr(expr.left),
				lowerExpr(expr.right),
				expr.span
			);
		case "logical":
			return expr.operator === "and"
				? {
						kind: "and",
						left: lowerExpr(expr.left),
						right: lowerExpr(expr.right),
						span: expr.span
					}
				: {
						kind: "or",
						left: lowerExpr(expr.left),
						right: lowerExpr(expr.right),
						span: expr.span
					};
		case "not":
			return { kind: "not", operand: lowerExpr(expr.operand), span: expr.span };
		case "in": {
			// `x in (subquery)` — validate subquery a exactement
			// 1 output field (parité PG `x IN (SELECT y FROM t)`).
			const isSubqueryVariant =
				expr.values.length === 1 && expr.values[0]?.type === "subquery";
			if (isSubqueryVariant) {
				const subExpr = expr.values[0]! as Expr & { type: "subquery" };
				const pickStage = subExpr.query.stages.find((s) => s.type === "pick");
				if (pickStage === undefined || pickStage.type !== "pick") {
					throw new SnqlError(
						"'in (subquery)' — la sub-query doit avoir un 'pick' avec exactement 1 field",
						"lower_in_subquery_no_pick",
						expr.values[0]!.span
					);
				}
				if (pickStage.fields.length !== 1) {
					throw new SnqlError(
						`'in (subquery)' — la sub-query doit projeter exactement 1 field, reçu ${pickStage.fields.length}`,
						"lower_in_subquery_arity",
						expr.values[0]!.span
					);
				}
			}
			return {
				kind: "in",
				target: lowerExpr(expr.target),
				values: expr.values.map(lowerExpr),
				span: expr.span
			};
		}
		case "arith":
			return {
				kind: "arith",
				op: expr.operator,
				left: lowerExpr(expr.left),
				right: lowerExpr(expr.right),
				span: expr.span
			};
		case "call":
			return lowerCall(expr);
		case "windowCall":
			return lowerWindowCall(expr);
		case "subquery": {
			// lower récursif. Le `lower()` détecte le contexte
			// non-null (scopeState.current !== null) et pousse automatiquement le
			// scope outer sur outerScopeStack, permettant à la subquery de
			// résoudre les alias corrélés via checkAliasDefined.
			// Le schema est propagé via scopeState.schema (module state).
			const subPlan = lower(expr.query, scopeState.schema);
			return { kind: "subquery", plan: subPlan, span: expr.span };
		}
		case "exists": {
			// `exists (subquery)` — le subquery est TOUJOURS un Expr.subquery
			// (invariant parser). On unwrap pour obtenir le LogicalPlan direct.
			if (expr.subquery.type !== "subquery") {
				throw new SnqlError(
					"'exists' attend une sub-query (bug parser)",
					"lower_exists_not_subquery",
					expr.span
				);
			}
			const subPlan = lower(expr.subquery.query, scopeState.schema);
			return { kind: "exists", subplan: subPlan, span: expr.span };
		}
		case "cast": {
			// Le parser accepte tout ident lowercase — le lower dispatche
			// builtin (CAST_TARGETS) vs enum-ref (via schema.enums, ADR-030
			// Enum/2b). Refuse typé si ni builtin ni enum connu.
			const target = expr.target;
			if (!CAST_TARGETS.has(target as CastTarget)) {
				const enumDef = scopeState.schema?.enums?.find(
					(e) => e.name === target
				);
				if (enumDef === undefined) {
					const enumsAvail =
						scopeState.schema?.enums?.map((e) => e.name).join(", ") ??
						"(aucun)";
					throw new SnqlError(
						`Type de cast '${target}' inconnu — canoniques builtins (int, float, text, bool, date, timestamp, json) ou enums en scope (${enumsAvail})`,
						"lower_cast_unknown_target",
						expr.targetSpan
					);
				}
				// Cast vers enum — valide member si operand est un string literal.
				const operand = lowerExpr(expr.operand);
				if (
					operand.kind === "literal" &&
					typeof operand.value === "string" &&
					!enumDef.members.includes(operand.value)
				) {
					throw new SnqlError(
						`'${operand.value}' n'est pas un member de l'enum '${enumDef.name}' — valid : ${enumDef.members.join(", ")}`,
						"lower_cast_enum_invalid_member",
						operand.span ?? expr.span
					);
				}
				return {
					kind: "cast",
					target: target as CastTarget,
					operand,
					span: operand.span ?? expr.span
				};
			}
			const operand = lowerExpr(expr.operand);
			// cast(<string literal> as json) : parse au lower
			// et remplacement statique par object/array/scalar literal. Cross-
			// engine (aucun engine-specific code). Fires SnqlError si JSON.parse
			// échoue — signale l'erreur au parse-time, pas au runtime silent.
			if (
				expr.target === "json" &&
				operand.kind === "literal" &&
				typeof operand.value === "string"
			) {
				return parseJsonLiteralToPlanExpr(
					operand.value,
					operand.span ?? expr.span
				);
			}
			// Span de l'operand pour cibler PG 22P02 (`invalid input syntax for … : "X"`)
			// sur le fragment fautif — pas sur le mot-clé `cast`.
			return {
				kind: "cast",
				target: expr.target as CastTarget,
				operand,
				span: operand.span ?? expr.span
			};
		}
		case "object":
			return {
				kind: "object",
				entries: expr.entries.map((e) => ({
					key: e.key,
					value: lowerExpr(e.value)
				})),
				span: expr.span
			};
		case "array":
			return {
				kind: "array",
				items: expr.items.map(lowerExpr),
				span: expr.span
			};
		case "case": {
			// Garde `lower_case_cond_type` : refuse un `cond` dont on peut prouver
			// statiquement qu'il n'est pas bool. On accepte tout ce qu'on ne peut
			// pas prouver faux (field, call, arith, compare, logical, not, in,
			// cast) — la validation runtime PG/Mongo prend le relais si nécessaire.
			for (const branch of expr.branches) {
				assertCondIsBoolShaped(branch.cond, "case");
			}
			// Garde `lower_case_branches_type_mismatch` : si toutes les valeurs
			// (branches + elseValue) sont des littéraux de kinds différents,
			// signaler tôt — PG throwera sinon avec un `CASE types cannot be
			// matched` opaque. Composites (object/array) → kind=`json`.
			assertBranchLiteralsHomogeneous(
				expr.branches.map((b) => b.value).concat(expr.elseValue),
				"case"
			);
			return {
				kind: "case",
				branches: expr.branches.map((b) => ({
					cond: lowerExpr(b.cond),
					value: lowerExpr(b.value)
				})),
				elseValue: lowerExpr(expr.elseValue),
				span: expr.span
			};
		}
	}
}

/**
 * bool-shape check pour `case` / `if` cond. On refuse les
 * littéraux non-bool prouvés (number / string / null / object / array). Un
 * `cond` field/call/arith/etc. passe — trop coûteux à typer statiquement, PG
 * throwera 22P02 si non-bool réel.
 */
function assertCondIsBoolShaped(cond: Expr, ctx: "case" | "if"): void {
	const kind = literalKindOrNull(cond);
	if (kind === null || kind === "boolean") return;
	const errCode =
		ctx === "case" ? "lower_case_cond_type" : "lower_if_cond_type";
	const prefix = ctx === "case" ? "case { cond -> … }" : "if(cond, …, …)";
	throw new SnqlError(
		`${prefix} : cond doit être booléen — reçu littéral ${kind}`,
		errCode,
		cond.span
	);
}

/**
 * garde d'homogénéité des branches. Si TOUTES les valeurs
 * fournies sont des littéraux et que leurs kinds diffèrent, on refuse au lower
 * plutôt que de laisser PG throw un `CASE types cannot be matched` opaque
 * (Mongo tolère plus, mais la promesse SNQL cross-engine impose PG comme
 * plancher). Object/array literals → kind `json` unifié.
 */
function assertBranchLiteralsHomogeneous(
	values: readonly Expr[],
	ctx: "case" | "if"
): void {
	const kinds: string[] = [];
	for (const v of values) {
		const k = literalKindOrNull(v);
		if (k === null) return; // Non-littéral → skip la garde
		if (k === "null") continue; // NULL polymorphe → homogène avec tout
		kinds.push(k);
	}
	const unique = new Set(kinds);
	if (unique.size <= 1) return;
	const errCode =
		ctx === "case"
			? "lower_case_branches_type_mismatch"
			: "lower_if_branches_type_mismatch";
	const prefix = ctx === "case" ? "case { … }" : "if(…)";
	throw new SnqlError(
		`${prefix} : branches de types incompatibles {${[...unique].join(", ")}} — cast explicite requis (ex: cast(x as text))`,
		errCode,
		values[0]!.span
	);
}

/**
 * Retourne le kind statique d'un `Expr` si littéral (`number`, `string`,
 * `boolean`, `null`, `json` pour object/array), sinon `null`. Sert aux gardes
 * `lower_*_cond_type` et `lower_*_branches_type_mismatch`.
 */
function literalKindOrNull(expr: Expr): string | null {
	if (expr.type === "literal") return expr.value.kind;
	if (expr.type === "object" || expr.type === "array") return "json";
	return null;
}

/**
 * Hints par nom de fonction reserved — pointe l'alternative.
 * Utilisé par `lower_call_reserved` pour un message actionnable.
 */
const RESERVED_FUNCTION_HINTS: Readonly<Record<string, string>> = {
	regex_replace: "(registre string étendu)",
	json_contains:
		"(attend object-literal SNQL natif — utilise json_get + composition d'ici là)",
	json_set: "(coordination avec `set doc.a.b = value` natif SNQL)",
	json_delete: "(idem json_set)",
	json_merge: "(design deep-merge vs shallow)",
	json_path:
		"(JSONPath complet — utilise json_get variadic pour l'accès simple)",
	json_array_length:
		"(cluster introspection étendue — utilise length ou compose)",
	json_length:
		"(cardinalité unifiée array/object — utilise length pour arrays)",
	json_object_keys: "(set-returning, nécessite décision array-typed returns)"
};

/**
 * Aliases connus vers les canoniques SNQL — suggestions pour
 * `lower_unknown_function`. Chaque `?` d'un dev perdu = un alias à ajouter.
 */
const FUNCTION_ALIASES: Readonly<Record<string, string>> = {
	regexp_replace: "regex_replace (réservé)",
	position: "strpos",
	instr: "strpos",
	substr: "substring",
	ceiling: "ceil",
	datediff: "date_diff",
	dateadd: "date_add",
	current_date: "today()",
	current_timestamp: "now()",
	sysdate: "now()",
	getdate: "now()"
};

/** Distance d'édition (Damerau-Levenshtein 1-swap) — utilisé pour les
 * suggestions "voulez-vous dire" sur les units. Coût O(n*m), négligeable pour
 * des chaînes de ≤ 20 chars. */
function editDistance(a: string, b: string): number {
	if (a === b) return 0;
	const la = a.length;
	const lb = b.length;
	if (la === 0) return lb;
	if (lb === 0) return la;
	let prev: number[] = Array(lb + 1);
	for (let j = 0; j <= lb; j += 1) prev[j] = j;
	let curr: number[] = Array(lb + 1);
	for (let i = 1; i <= la; i += 1) {
		curr[0] = i;
		for (let j = 1; j <= lb; j += 1) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(
				(curr[j - 1] as number) + 1,
				(prev[j] as number) + 1,
				(prev[j - 1] as number) + cost
			);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[lb] as number;
}

/** Trouve la meilleure suggestion dans une whitelist (distance ≤ 2, plus courte gagne). */
function bestSuggestion(
	input: string,
	candidates: readonly string[]
): string | null {
	let best: { name: string; dist: number } | null = null;
	for (const cand of candidates) {
		const d = editDistance(input.toLowerCase(), cand);
		if (d <= 2 && (best === null || d < best.dist)) {
			best = { name: cand, dist: d };
		}
	}
	return best?.name ?? null;
}

/**
 * Résout un appel de fonction contre le registre : fonction connue, arité
 * conforme, kind non-`reserved`. Types opt-in : si `entry.args` est déclaré et
 * que l'arg correspondant est statiquement typable (littéral), on vérifie.
 * `argEnum` : whitelist pour un arg littéral string (unit de date_*)
 * avec suggestion Levenshtein sur valeur hors whitelist.
 */
function lowerCall(expr: Expr & { type: "call" }): PlanExpr {
	const entry = SNQL_FUNCTIONS.get(expr.name);
	if (entry === undefined) {
		const aliasHint = FUNCTION_ALIASES[expr.name];
		const message =
			aliasHint !== undefined
				? `Fonction '${expr.name}' inconnue — utilisez '${aliasHint}'`
				: `Fonction '${expr.name}' inconnue`;
		throw new SnqlError(message, "lower_unknown_function", expr.span);
	}
	if (entry.kind === "reserved") {
		const hint = RESERVED_FUNCTION_HINTS[expr.name];
		const message =
			hint !== undefined
				? `Fonction '${expr.name}' réservée — ${hint}`
				: `Fonction '${expr.name}' réservée — pas encore implémentée`;
		throw new SnqlError(message, "lower_call_reserved", expr.span);
	}
	// guards call-level pour star / unique / aggregates.
	// Defense-in-depth : le parser fast-path garantit déjà les invariants
	// structurels ; ces checks capturent un PlanExpr construit programmatiquement
	// (tests, futur workflow) qui bypasserait le parser.
	if (expr.star === true && expr.name !== "count") {
		throw new SnqlError(
			`'${expr.name}(*)' — '*' est réservé à count(*)`,
			"lower_call_star_only_count",
			expr.span
		);
	}
	if (expr.unique === true) {
		if (entry.kind !== "aggregate" && entry.kind !== "aggregateMulti") {
			throw new SnqlError(
				`'${expr.name}(unique ...)' — le modifier 'unique' est réservé aux aggregates (count/sum/avg/min/max, array_agg/string_agg/json_agg)`,
				"lower_call_unique_aggregate_only",
				expr.span
			);
		}
		// aggregate mono-arg (count/sum/avg/min/max) exige 1 arg avec unique.
		// aggregateMulti (array_agg, json_agg) : 1 arg. string_agg : 2 args.
		// On check via arity min (déjà validée à la ligne suivante).
		if (entry.kind === "aggregate" && expr.args.length !== 1) {
			throw new SnqlError(
				`'${expr.name}(unique ...)' attend exactement 1 argument, reçu ${expr.args.length} (arité mono-arg cross-engine)`,
				"lower_call_unique_arity",
				expr.span
			);
		}
		if (expr.name === "min" || expr.name === "max") {
			throw new SnqlError(
				`'${expr.name}(unique ...)' refusé — 'unique' n'a pas d'effet sur ${expr.name} (retire 'unique')`,
				"lower_call_unique_no_op_min_max",
				expr.span
			);
		}
	}
	// sortKeys — parser filtre déjà (contextual via registry),
	// defense-in-depth : refuse si présent sur non-aggregateMulti (bug parser).
	if (expr.sortKeys !== undefined && expr.sortKeys.length > 0) {
		if (entry.kind !== "aggregateMulti") {
			throw new SnqlError(
				`'${expr.name}(... sort ...)' — 'sort' intra-call réservé aux aggregateMulti (array_agg / string_agg / json_agg)`,
				"lower_call_sort_aggregate_multi_only",
				expr.span
			);
		}
	}
	// count() nu (sans star, 0 args) — piège UX : arity accepte 0-1 pour count
	// afin de laisser passer count(*), mais count() seul n'a pas de sémantique.
	if (expr.name === "count" && expr.star !== true && expr.args.length === 0) {
		throw new SnqlError(
			"count() sans argument — utilise 'count(*)' pour compter les rows ou 'count(<expr>)' pour compter les non-null",
			"lower_call_count_missing_arg",
			expr.span
		);
	}
	const arityMsg = checkArity(expr.name, entry.arity, expr.args.length);
	if (arityMsg !== null) {
		throw new SnqlError(arityMsg, "lower_call_arity", expr.span);
	}
	// Type check opt-in — on ne vérifie que ce qu'on peut statiquement (littéraux).
	if (entry.args !== undefined) {
		for (let i = 0; i < expr.args.length && i < entry.args.length; i += 1) {
			const declared = entry.args[i];
			if (declared === undefined || declared === "any") continue;
			const arg = expr.args[i];
			if (arg?.type === "literal") {
				const litKind = arg.value.kind;
				const mismatch =
					(declared === "string" && litKind !== "string") ||
					(declared === "number" && litKind !== "number") ||
					(declared === "bool" && litKind !== "boolean");
				if (mismatch) {
					throw new SnqlError(
						`Fonction '${expr.name}' arg ${i + 1} attend ${declared}, reçu ${litKind}`,
						"lower_call_type",
						arg.span
					);
				}
			}
		}
	}
	// argEnum : whitelist stricte pour les unit littéraux (date_*).
	if (entry.argEnum !== undefined) {
		for (let i = 0; i < expr.args.length && i < entry.argEnum.length; i += 1) {
			const whitelist = entry.argEnum[i];
			if (whitelist === undefined) continue;
			const arg = expr.args[i];
			if (arg === undefined) continue;
			if (arg.type !== "literal" || arg.value.kind !== "string") {
				throw new SnqlError(
					`Fonction '${expr.name}' arg ${i + 1} attend un littéral string parmi {${whitelist.join(", ")}}, pas une expression dynamique`,
					"lower_call_enum_literal_required",
					arg.span
				);
			}
			const value = arg.value.value.toLowerCase();
			if (!whitelist.includes(value)) {
				const suggestion = bestSuggestion(value, whitelist);
				const suggestionHint =
					suggestion !== null ? ` — voulez-vous dire '${suggestion}' ?` : "";
				throw new SnqlError(
					`Fonction '${expr.name}' arg ${i + 1} '${arg.value.value}' hors enum {${whitelist.join(", ")}}${suggestionHint}`,
					"lower_call_enum_value",
					arg.span
				);
			}
		}
	}
	// Guards dédiés : catch les pièges courants avec un message actionnable.
	if (entry.name === "substring") {
		const startArg = expr.args[1];
		if (
			startArg?.type === "literal" &&
			startArg.value.kind === "number" &&
			Number(startArg.value.raw) === 0
		) {
			throw new SnqlError(
				"substring est 1-indexed — voulez-vous dire substring(s, 1, ...) ?",
				"lower_call_substring_zero_index",
				startArg.span
			);
		}
	}
	if (entry.name === "replace") {
		const fromArg = expr.args[1];
		if (
			fromArg?.type === "literal" &&
			fromArg.value.kind === "string" &&
			fromArg.value.value === ""
		) {
			throw new SnqlError(
				"replace : `from` vide non supporté cross-engine (PG no-op, Mongo null/throw)",
				"lower_call_replace_empty_find",
				fromArg.span
			);
		}
	}
	if (entry.name === "json_get" || entry.name === "json_get_text") {
		validateJsonPathSegments(expr, entry.name);
	}
	if (entry.name === "json_has_key") {
		validateJsonHasKey(expr);
	}
	// guards spécifiques `if(cond, then, else)` — miroir des
	// gardes `case`. cond bool-shaped + branches homogènes (then/else).
	if (entry.name === "if" && expr.args.length === 3) {
		assertCondIsBoolShaped(expr.args[0]!, "if");
		assertBranchLiteralsHomogeneous([expr.args[1]!, expr.args[2]!], "if");
	}
	// forward star/unique flags sur PlanCall — le codegen les
	// consomme via ctx.star / ctx.unique.
	// forward sortKeys (aggregateMulti) — le codegen les
	// consomme via ctx.sortKeys + accès direct au PlanCall.sortKeys.
	const loweredSortKeys =
		expr.sortKeys !== undefined && expr.sortKeys.length > 0
			? expr.sortKeys.map((k) => ({ path: k.path, direction: k.direction }))
			: undefined;
	return {
		kind: "call",
		name: expr.name,
		args: expr.args.map(lowerExpr),
		...(expr.star === true ? { star: true as const } : {}),
		...(expr.unique === true ? { unique: true as const } : {}),
		...(loweredSortKeys !== undefined ? { sortKeys: loweredSortKeys } : {}),
		span: expr.span
	};
}

/**
 * lower d'un windowCall. Vérifie l'existence dans le registre
 * + kind=window + arité + refus contextes non-pick (validé en amont par le
 * walker). Retourne un PlanExpr.windowCall.
 */
function lowerWindowCall(expr: Expr & { type: "windowCall" }): PlanExpr {
	const entry = SNQL_FUNCTIONS.get(expr.name);
	if (entry === undefined) {
		throw new SnqlError(
			`Fonction '${expr.name}' inconnue`,
			"lower_unknown_function",
			expr.span
		);
	}
	if (entry.kind !== "window") {
		// Defense-in-depth : parser filtre déjà (parse_over_not_window).
		throw new SnqlError(
			`'${expr.name}' n'est pas une window function`,
			"lower_windowcall_not_window",
			expr.span
		);
	}
	const arityMsg = checkArity(expr.name, entry.arity, expr.args.length);
	if (arityMsg !== null) {
		throw new SnqlError(arityMsg, "lower_call_arity", expr.span);
	}
	return {
		kind: "windowCall",
		name: expr.name,
		args: expr.args.map(lowerExpr),
		partitionKeys: expr.partitionKeys,
		sortKeys: expr.sortKeys.map((k) => ({
			path: k.path,
			direction: k.direction
		})),
		span: expr.span
	};
}

/**
 * Valide les segments path d'un `json_get`/`json_get_text` variadic. Chaque
 * segment (args[1..]) doit être un littéral string non-vide OU un littéral
 * number entier positif ≤ INT32_MAX. Rejet précoce au lower — le renderer
 * discrimine sur le type de la value pour choisir `::text` / `::int`.
 */
function validateJsonPathSegments(
	expr: Expr & { type: "call" },
	fnName: string
): void {
	// args[0] = doc, args[1..] = segments path
	if (expr.args.length < 2) {
		throw new SnqlError(
			`Fonction '${fnName}' attend au moins un segment path (ex: ${fnName}(doc, "key") ou ${fnName}(doc, "a", 0, "b"))`,
			"lower_call_json_path_empty",
			expr.span
		);
	}
	for (let i = 1; i < expr.args.length; i += 1) {
		const seg = expr.args[i]!;
		if (seg.type !== "literal") {
			throw new SnqlError(
				`Fonction '${fnName}' segment path ${i} : expression dynamique non supportée v1 — attend un littéral string ou int`,
				"lower_call_json_path_dynamic_segment",
				seg.span
			);
		}
		const v = seg.value;
		if (v.kind === "string") {
			if (v.value === "") {
				throw new SnqlError(
					`Fonction '${fnName}' segment path ${i} : string vide refusée`,
					"lower_call_json_path_empty_segment",
					seg.span
				);
			}
			continue;
		}
		if (v.kind === "number") {
			// Raw parsing : rejeter float, bigint hors range, décimal exact.
			if (FLOAT_HINT.test(v.raw)) {
				throw new SnqlError(
					`Fonction '${fnName}' segment path ${i} : type reçu float — attend int littéral positif`,
					"lower_call_json_path_invalid_segment_type",
					seg.span
				);
			}
			const n = Number(v.raw);
			if (!Number.isInteger(n)) {
				throw new SnqlError(
					`Fonction '${fnName}' segment path ${i} : type reçu non-int — attend int littéral positif`,
					"lower_call_json_path_invalid_segment_type",
					seg.span
				);
			}
			if (n < 0) {
				throw new SnqlError(
					`Fonction '${fnName}' segment path ${i} : index négatif refusé v1 (support natif PG/Mongo différé)`,
					"lower_call_json_path_negative_index",
					seg.span
				);
			}
			if (n > 2147483647) {
				throw new SnqlError(
					`Fonction '${fnName}' segment path ${i} : index > INT32_MAX (PG '->' overload jsonb∘int n'a pas de variante bigint)`,
					"lower_call_json_path_int_overflow",
					seg.span
				);
			}
			continue;
		}
		throw new SnqlError(
			`Fonction '${fnName}' segment path ${i} : type reçu ${v.kind} — attend un littéral string ou int`,
			"lower_call_json_path_invalid_segment_type",
			seg.span
		);
	}
}

/** Valide `json_has_key(doc, key)` : key doit être un literal string non-vide. */
function validateJsonHasKey(expr: Expr & { type: "call" }): void {
	const keyArg = expr.args[1];
	if (keyArg === undefined) return; // arity l'attrapera avant
	if (keyArg.type !== "literal" || keyArg.value.kind !== "string") {
		throw new SnqlError(
			"json_has_key : arg 2 (key) attend un littéral string, pas une expression dynamique",
			"lower_call_json_has_key_dynamic_key",
			keyArg.span
		);
	}
	if (keyArg.value.value === "") {
		throw new SnqlError(
			"json_has_key : arg 2 (key) string vide refusée",
			"lower_call_json_has_key_empty_key",
			keyArg.span
		);
	}
}

/**
 * Refuse un call bool-returning en position bare de prédicat where
 * (`where json_has_key(doc, 'k')` sans `= true/false`). Aligne le comportement
 * cross-engine : PG accepterait bool nu mais Mongo throw à la traduction —
 * l'asymétrie surprend le dev. Rejet au lower avec message actionnable.
 *
 * Bool-returning aujourd'hui = `json_has_key`. Extensible via un
 * champ registry futur ; hardcoded ici pour éviter la modif du shape.
 */
const BOOL_RETURNING_CALLS: ReadonlySet<string> = new Set(["json_has_key"]);

export function assertNoBareCallPredicate(expr: Expr): void {
	// Case en position bare where (`where case { … }`) refusé — non-booléen
	// par nature. Le dev doit comparer explicitement (`case { … } = true`).
	if (expr.type === "case") {
		throw new SnqlError(
			"'case { … }' n'est pas un prédicat — compare le résultat avec une valeur (ex: case { … } = true)",
			"lower_case_bare_predicate",
			expr.span
		);
	}
	if (expr.type !== "call") return;
	if (!BOOL_RETURNING_CALLS.has(expr.name)) return;
	throw new SnqlError(
		`Fonction bool '${expr.name}' en position bare de where — écris '${expr.name}(...) = true' ou '= false' (aligne le comportement cross-engine)`,
		"lower_call_bool_bare_predicate",
		expr.span
	);
}

/** Opérateur symétrique après échange des opérandes (a < b ⇔ b > a). */
const FLIP_OP: Readonly<Record<CompareOp, CompareOp>> = {
	eq: "eq",
	ne: "ne",
	lt: "gt",
	gt: "lt",
	le: "ge",
	ge: "le",
	like: "like"
};

/**
 * Canonicalise une comparaison :
 * 1. null-aware, quel que soit le côté du littéral null (`x = null`, `null = x`, …) → isNull ;
 * 2. `littéral OP champ` → `champ OP' littéral` (opérande champ à gauche). Sans ça, un moteur
 *    document (Mongo) traduit `age < 30` et `30 > age` en formes différentes, avec des sémantiques
 *    divergentes sur les champs absents. Le fallback champ↔champ ($expr) reste, lui, inchangé.
 *
 * Le `span` est celui du node `compare` AST source — il englobe l'expression
 * complète canonicalisée (utile pour souligner `x = null` en une seule marque).
 */
function lowerCompare(
	operator: CompareOperator,
	left: PlanExpr,
	right: PlanExpr,
	span: import("../lexer/token").Span
): PlanExpr {
	const op = COMPARE_MAP[operator];
	if (op === "eq" || op === "ne") {
		const leftNull = isNullLiteral(left);
		const rightNull = isNullLiteral(right);
		if (leftNull || rightNull) {
			const operand = leftNull ? right : left;
			return { kind: "isNull", negated: op === "ne", operand, span };
		}
	}
	// `like` n'est pas commutatif : jamais d'échange.
	if (op !== "like" && left.kind !== "field" && right.kind === "field") {
		return { kind: "compare", op: FLIP_OP[op], left: right, right: left, span };
	}
	return { kind: "compare", op, left, right, span };
}

function isNullLiteral(expr: PlanExpr): boolean {
	return expr.kind === "literal" && expr.value === null;
}

/**
 * parse un JSON string literal en PlanExpr statique. Utilisé
 * pour rewriter `cast('{"k":1}' as json)` en `{k: 1}` object literal au lower,
 * cross-engine. Convertit récursivement chaque valeur JSON en son PlanExpr
 * équivalent (object/array/literal). Fires SnqlError si JSON.parse échoue.
 */
function parseJsonLiteralToPlanExpr(
	raw: string,
	span: import("../lexer/token").Span | undefined
): PlanExpr {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		throw new SnqlError(
			`cast('...' as json) — le string literal n'est pas du JSON valide : ${message}`,
			"lower_cast_json_string_invalid",
			span
		);
	}
	return jsValueToPlanExpr(parsed, span);
}

function jsValueToPlanExpr(
	value: unknown,
	span: import("../lexer/token").Span | undefined
): PlanExpr {
	const spanOpt = span !== undefined ? { span } : {};
	if (value === null) return { kind: "literal", value: null, ...spanOpt };
	if (typeof value === "string") return { kind: "literal", value, ...spanOpt };
	if (typeof value === "boolean") return { kind: "literal", value, ...spanOpt };
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new SnqlError(
				"cast('...' as json) — JSON contient une valeur numérique hors IEEE-754 finie",
				"lower_cast_json_string_invalid",
				span
			);
		}
		return { kind: "literal", value, ...spanOpt };
	}
	if (Array.isArray(value)) {
		return {
			kind: "array",
			items: value.map((item) => jsValueToPlanExpr(item, span)),
			...spanOpt
		};
	}
	if (typeof value === "object") {
		return {
			kind: "object",
			entries: Object.entries(value as Record<string, unknown>).map(
				([key, val]) => ({ key, value: jsValueToPlanExpr(val, span) })
			),
			...spanOpt
		};
	}
	throw new SnqlError(
		`cast('...' as json) — type JSON parsé non supporté (${typeof value})`,
		"lower_cast_json_string_invalid",
		span
	);
}

export function literalToValue(lit: LiteralValue): SqlValue {
	switch (lit.kind) {
		case "number":
			return numberRawToValue(lit.raw);
		case "string":
			return lit.value;
		case "boolean":
			return lit.value;
		case "null":
			return null;
	}
}

/**
 * Préserve la précision : décimal → `SqlDecimal` (texte brut exact) ; entier hors
 * plage sûre → bigint ; sinon number. On ne passe JAMAIS un décimal par `Number()`.
 */
function numberRawToValue(raw: string): SqlValue {
	if (FLOAT_HINT.test(raw)) {
		return { kind: "decimal", raw };
	}
	const asNumber = Number(raw);
	return Number.isSafeInteger(asNumber) ? asNumber : BigInt(raw);
}
