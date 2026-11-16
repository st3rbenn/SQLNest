import { SnqlError } from "../diagnostics";
import { SNQL_FUNCTIONS } from "../functions";
import type { CompareOp, PlanExpr } from "../ir/plan";
import {
	bsonValue,
	literalValue,
	MONGO_OP,
	mongoField,
	toExprOperand
} from "./mongodb-expr";
import { defined } from "../invariant";

/**
 * Filtres : prédicats rendus en `$match`, avec la logique à trois valeurs
 * de SQL (un `null` ne satisfait ni une comparaison ni sa négation).
 */

/**
 * Combine le doc $match du predicate résiduel avec les match additions liftées.
 * Cas résiduel null → utilise seulement les additions ($and si multiples, sinon
 * flat). Cas additions vides → utilise seulement le résiduel. Cas mix → `$and`.
 */
export function mergeMatchDocs(
	residual: Record<string, unknown> | null,
	additions: readonly Record<string, unknown>[]
): Record<string, unknown> {
	if (residual === null) {
		if (additions.length === 1) return defined(additions[0]);
		return { $and: [...additions] };
	}
	if (additions.length === 0) return residual;
	return { $and: [residual, ...additions] };
}

/**
 * Contexte de rendu d'un prédicat. En **écriture**, les négations sont rendues
 * existence-aware (parité 3VL SQL) : `where age != 30` ne doit PAS supprimer les
 * documents où `age` est absent ou null, sinon un `remove` détruit des données
 * que Postgres épargnerait. En lecture, on garde la sémantique Mongo native (la
 * question 3VL reste ouverte, cf. [[Questions ouvertes]]).
 */
type MatchMode = "read" | "write";

export function renderMatch(
	expr: PlanExpr,
	alias: string | undefined,
	mode: MatchMode
): Record<string, unknown> {
	switch (expr.kind) {
		case "and":
			return {
				$and: [
					renderMatch(expr.left, alias, mode),
					renderMatch(expr.right, alias, mode)
				]
			};
		case "or":
			return {
				$or: [
					renderMatch(expr.left, alias, mode),
					renderMatch(expr.right, alias, mode)
				]
			};
		case "not":
			// Négation existence-aware dans les DEUX modes (ADR-032) : on pousse la
			// négation aux feuilles (De Morgan) avec gardes d'existence. L'ancien
			// `$nor` en lecture matchait l'absent/null → divergence 3VL vs PG.
			return negateMatch(expr.operand, alias, mode);
		case "isNull": {
			// is null sur un call JSON hoistable → `{path: {$exists: bool}}`.
			// `where json_get(doc, 'k') is null` équivaut à `not $exists` (missing key).
			// `is not null` équivaut à `$exists: true`.
			if (expr.operand.kind === "call") {
				const entry = SNQL_FUNCTIONS.get(expr.operand.name);
				const hoist = entry?.mongoMatchHoist;
				if (hoist !== undefined && hoist.kind !== "exists") {
					const path = hoist.toPath(expr.operand.args, alias);
					if (path !== null) {
						return { [path]: { $exists: expr.negated } };
					}
				}
			}
			if (expr.operand.kind !== "field") {
				throw new SnqlError(
					"IS NULL Mongo attend un champ",
					"codegen_mongo_isnull"
				);
			}
			const field = mongoField(expr.operand.path, alias);
			return { [field]: expr.negated ? { $ne: null } : null };
		}
		case "in": {
			if (expr.target.kind !== "field") {
				throw new SnqlError(
					"'in' Mongo attend un champ à gauche",
					"codegen_mongo_in"
				);
			}
			// `$in` positif exclut déjà l'absent/null → identique en lecture/écriture.
			return {
				[mongoField(expr.target.path, alias)]: {
					$in: expr.values.map(literalValue)
				}
			};
		}
		case "compare":
			return renderCompare(expr.op, expr.left, expr.right, alias, mode);
		case "cast": {
			// Cast top-level dans un where n'est pas un prédicat — un dev doit
			// comparer explicitement. Message adapté au target : bool → suggère
			// `= true` ; autres → compare le résultat.
			const hint =
				expr.target === "bool"
					? "écris `cast(x as bool) = true`"
					: "compare le résultat avec une valeur";
			throw new SnqlError(
				`Un cast n'est pas un prédicat — ${hint}`,
				"codegen_mongo_cast_predicate",
				expr.span
			);
		}
		case "literal":
		case "field":
		case "arith":
		case "call":
			throw new SnqlError(
				"Prédicat non supporté par le codegen Mongo (attendu une comparaison)",
				"codegen_mongo_predicate"
			);
		case "object":
		case "array":
			// Un object/array literal seul n'est pas booléen — le lower
			// (assertNoBareCallPredicate) devrait avoir rejeté avant.
			throw new SnqlError(
				`Un ${expr.kind} literal n'est pas un prédicat — compare-le avec une valeur (ex: json_contains)`,
				"codegen_mongo_predicate",
				expr.span
			);
		case "case":
			throw new SnqlError(
				"`case { … }` n'est pas un prédicat — compare le résultat avec une valeur (ex: case { … } = true)",
				"codegen_mongo_predicate",
				expr.span
			);
		case "windowCall":
			// windowCall en where refusé au lower — defense.
			throw new SnqlError(
				"Window function dans un prédicat non supporté (refusé au lower normalement)",
				"codegen_mongo_predicate",
				expr.span
			);
		case "subquery":
		case "exists":
			// sub-queries refusées au planner (Mongo n'a pas
			// la capability). Defense — jamais atteint normalement.
			throw new SnqlError(
				"Sub-query dans un prédicat Mongo non supportée (planner_subquery_unsupported attendu avant)",
				"codegen_mongo_subquery_unsupported",
				expr.span
			);
		case "upsertNew":
			// upsert refusé au planner sur Mongo (capability upsert
			// absente). Defense — jamais atteint normalement.
			throw new SnqlError(
				"'new.<col>' Mongo non supporté (upsert refusé au planner)",
				"codegen_mongo_upsert_unsupported",
				expr.span
			);
	}
}

/**
 * Négation existence-aware d'un prédicat (écriture uniquement). Pousse la
 * négation aux feuilles via De Morgan (3VL-safe) ; chaque feuille exclut
 * l'absent/null, comme la 3VL de SQL exclut les lignes où le prédicat est UNKNOWN.
 */
function negateMatch(
	expr: PlanExpr,
	alias: string | undefined,
	mode: MatchMode
): Record<string, unknown> {
	switch (expr.kind) {
		case "and":
			return {
				$or: [
					negateMatch(expr.left, alias, mode),
					negateMatch(expr.right, alias, mode)
				]
			};
		case "or":
			return {
				$and: [
					negateMatch(expr.left, alias, mode),
					negateMatch(expr.right, alias, mode)
				]
			};
		case "not":
			// Double négation : on revient au prédicat positif.
			return renderMatch(expr.operand, alias, mode);
		case "isNull": {
			if (expr.operand.kind !== "field") {
				throw new SnqlError(
					"IS NULL Mongo attend un champ",
					"codegen_mongo_isnull"
				);
			}
			const field = mongoField(expr.operand.path, alias);
			// not(IS NULL) = IS NOT NULL ; not(IS NOT NULL) = IS NULL.
			return { [field]: expr.negated ? null : { $ne: null } };
		}
		case "in": {
			if (expr.target.kind !== "field") {
				throw new SnqlError(
					"'in' Mongo attend un champ à gauche",
					"codegen_mongo_in"
				);
			}
			// not(x IN vals) = x NOT IN vals, existence-aware (`$nin` inclut null → exclut l'absent).
			return {
				[mongoField(expr.target.path, alias)]: {
					$nin: [...expr.values.map(literalValue), null]
				}
			};
		}
		case "compare":
			return negateCompare(expr.op, expr.left, expr.right, alias, mode);
		case "cast": {
			const hint =
				expr.target === "bool"
					? "écris `cast(x as bool) = true`"
					: "compare le résultat avec une valeur";
			throw new SnqlError(
				`Un cast n'est pas un prédicat — ${hint}`,
				"codegen_mongo_cast_predicate",
				expr.span
			);
		}
		case "literal":
		case "field":
		case "arith":
		case "call":
			throw new SnqlError(
				"Négation d'un prédicat non supporté par le codegen Mongo",
				"codegen_mongo_predicate"
			);
		case "object":
		case "array":
			throw new SnqlError(
				`Négation d'un ${expr.kind} literal non supportée (pas un prédicat)`,
				"codegen_mongo_predicate",
				expr.span
			);
		case "case":
			throw new SnqlError(
				"Négation d'un `case { … }` non supportée (pas un prédicat) — compare avec une valeur d'abord",
				"codegen_mongo_predicate",
				expr.span
			);
		case "windowCall":
			// négation d'un windowCall refusé (refusé au lower).
			throw new SnqlError(
				"Négation d'un window function non supportée",
				"codegen_mongo_predicate",
				expr.span
			);
		case "subquery":
		case "exists":
			throw new SnqlError(
				"Négation d'une sub-query Mongo non supportée",
				"codegen_mongo_subquery_unsupported",
				expr.span
			);
		case "upsertNew":
			throw new SnqlError(
				"'new.<col>' Mongo non supporté (upsert refusé au planner)",
				"codegen_mongo_upsert_unsupported",
				expr.span
			);
	}
}

/** Opérateur inverse (3VL) d'une comparaison, pour la négation en écriture. */
const NEGATED_COMPARE: Readonly<Record<CompareOp, string>> = {
	eq: "$nin", // not(=) → != (existence-aware, cas spécial ci-dessous)
	ne: "$eq",
	lt: "$gte",
	le: "$gt",
	gt: "$lte",
	ge: "$lt",
	like: "$regex"
};

/**
 * Opérateur SNQL inverse pour la négation via hoist. `not (json_has_key
 * = true)` doit hoister comme `json_has_key = false` avec op inversé. Undefined
 * = pas de hoist négation (like : forme complexe $not+$regex+$ne préservée).
 */
const NEGATED_HOIST_OP: Readonly<Partial<Record<CompareOp, CompareOp>>> = {
	eq: "ne",
	ne: "eq",
	lt: "ge",
	le: "gt",
	gt: "le",
	ge: "lt"
};

function negateCompare(
	op: CompareOp,
	left: PlanExpr,
	right: PlanExpr,
	alias: string | undefined,
	mode: MatchMode
): Record<string, unknown> {
	// Mirror hoist JSON dans la négation. `not (json_get(x,'k')='v')`
	// et `not (json_has_key(x,'k')=true)` doivent produire l'inverse hoisté
	// natif (sinon fallback $expr non-indexable via composition not/$eq).
	const negatedOp = NEGATED_HOIST_OP[op];
	if (negatedOp !== undefined) {
		const hoisted = tryMongoMatchHoist(negatedOp, left, right, alias, mode);
		if (hoisted !== null) return hoisted;
	}
	// Cas idiomatique `champ op littéral` : on inverse l'opérateur.
	if (left.kind === "field" && right.kind === "literal") {
		const field = mongoField(left.path, alias);
		if (op === "like") {
			// Même garde de type que la forme positive (renderLike) : `like` exige
			// un motif chaîne, sinon `String(marqueur)` produirait un regex absurde
			// qui sur-matcherait (perte de données sur un remove).
			if (typeof right.value !== "string") {
				throw new SnqlError(
					'LIKE Mongo attend `champ like "motif"`',
					"codegen_mongo_like"
				);
			}
			// not(champ LIKE motif) = existe, non-null, ne matche pas.
			return {
				[field]: { $not: { $regex: likeToRegex(right.value) }, $ne: null }
			};
		}
		const value = bsonValue(right.value);
		if (op === "eq") {
			// not(=) équivaut à != : exclure la valeur ET l'absent/null (3VL).
			return { [field]: { $nin: [value, null] } };
		}
		// lt/le/gt/ge : les opérateurs de comparaison Mongo excluent déjà l'absent/null.
		return { [field]: { [NEGATED_COMPARE[op]]: value } };
	}
	// champ↔champ / fonction. Écriture : `renderCompare` refuse (3VL ambiguë).
	// Lecture (ADR-032 1b) : `$expr` gardé, comparaison négée — parité PG (les
	// deux opérandes doivent être non-null, sinon UNKNOWN → exclu).
	return mode === "write"
		? renderCompare(op, left, right, alias, "write")
		: guardedExpr(op, left, right, alias, true);
}

function renderCompare(
	op: CompareOp,
	left: PlanExpr,
	right: PlanExpr,
	alias: string | undefined,
	mode: MatchMode
): Record<string, unknown> {
	// Garde write : un cast dans un filtre de mutation Mongo passerait par
	// `$expr` (via toExprOperand), or Mongo v5+ supporte `$expr` en update
	// filter, mais un `$convert` sur un field absent throw ConversionFailure
	// et une purge silencieuse de la mauvaise ligne est bien pire qu'une
	// erreur. Message DÉDIÉ (pas de réutilisation champ↔champ trompeuse).
	if (mode === "write" && (left.kind === "cast" || right.kind === "cast")) {
		throw new SnqlError(
			"cast dans un filtre de mutation Mongo non supporté v1 — matérialise la valeur convertie côté application, ou match sur la valeur brute",
			"codegen_mongo_write_cast_predicate",
			left.kind === "cast" ? left.span : right.span
		);
	}
	if (op === "like") {
		return renderLike(left, right, alias);
	}
	// hoist JSON via mongoMatchHoist si applicable. Traduit
	// `where json_get(doc, 'a', 'b') = 'v'` en `{'doc.a.b': 'v'}` indexable
	// natif (au lieu du fallback $expr COLLSCAN).
	const hoisted = tryMongoMatchHoist(op, left, right, alias, mode);
	if (hoisted !== null) return hoisted;
	// Forme idiomatique : `{ champ: { $op: valeur } }`.
	if (left.kind === "field" && right.kind === "literal") {
		const field = mongoField(left.path, alias);
		// `!=` : `$ne` matcherait aussi l'absent/null. En écriture = perte de données
		// (`remove`/`update`) ; en lecture = divergence 3VL vs PG (ADR-032). `$nin:
		// [v, null]` exclut la valeur ET l'absent/null, comme `<>` en SQL — parité
		// dans les DEUX modes.
		if (op === "ne") {
			return { [field]: { $nin: [bsonValue(right.value), null] } };
		}
		return { [field]: { [MONGO_OP[op]]: bsonValue(right.value) } };
	}
	// Repli $expr : en écriture, on refuse — deux codes selon l'origine :
	//  - call / cast (fonction ou cast dans un prédicat write, non hoisté) :
	//    message actionnable pointant vers un pattern hoistable ou matérialisation
	// côté application (nouveau `codegen_mongo_write_expr_predicate`).
	//  - vrais champ↔champ : ancien message conservé (`codegen_mongo_write_field_compare`).
	if (mode === "write") {
		const isExprLike =
			left.kind === "call" ||
			left.kind === "cast" ||
			left.kind === "case" ||
			right.kind === "call" ||
			right.kind === "cast" ||
			right.kind === "case";
		if (isExprLike) {
			throw new SnqlError(
				"Expression fonction/cast/case dans un filtre de mutation Mongo non hoistable — matérialise le filtre côté application, ou utilise un pattern hoistable (json_get(field, ...literals) = literal)",
				"codegen_mongo_write_expr_predicate",
				left.kind === "call" || left.kind === "cast" || left.kind === "case"
					? left.span
					: right.span
			);
		}
		throw new SnqlError(
			"Comparaison champ↔champ non supportée dans un filtre d'écriture (sémantique 3VL ambiguë sur les champs absents/null)",
			"codegen_mongo_write_field_compare"
		);
	}
	// Read : `$expr` champ↔champ / fonction, avec gardes d'existence 3VL (ADR-032
	// 1b) — un opérande null/absent → prédicat UNKNOWN → ligne exclue (parité PG).
	// Sans les gardes, `a = b` avec les deux null matcherait (`$eq:[null,null]`→true).
	return guardedExpr(op, left, right, alias, false);
}

/**
 * `$expr` avec gardes d'existence 3VL (ADR-032 1b). La ligne n'est incluse que
 * si les DEUX opérandes sont non-null (sinon prédicat UNKNOWN → exclu, parité
 * SQL), puis la comparaison (ou sa négation). `$ne: [x, null]` capture missing
 * ET null (en agrégation, un field absent s'évalue à null). Read only — le
 * write refuse déjà champ↔champ en amont.
 */
function guardedExpr(
	op: CompareOp,
	left: PlanExpr,
	right: PlanExpr,
	alias: string | undefined,
	negate: boolean
): Record<string, unknown> {
	const a = toExprOperand(left, alias);
	const b = toExprOperand(right, alias);
	const cmp = { [MONGO_OP[op]]: [a, b] };
	return {
		$expr: {
			$and: [
				{ $ne: [a, null] },
				{ $ne: [b, null] },
				negate ? { $not: [cmp] } : cmp
			]
		}
	};
}

function renderLike(
	left: PlanExpr,
	right: PlanExpr,
	alias: string | undefined
): Record<string, unknown> {
	if (
		left.kind !== "field" ||
		right.kind !== "literal" ||
		typeof right.value !== "string"
	) {
		throw new SnqlError(
			'LIKE Mongo attend `champ like "motif"`',
			"codegen_mongo_like"
		);
	}
	return {
		[mongoField(left.path, alias)]: { $regex: likeToRegex(right.value) }
	};
}

// Caractères spéciaux regex à échapper lors de la conversion LIKE → $regex.
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/;

/**
 * hoist opt-in d'un `call` vers dot-notation Mongo native
 * indexable. Consomme `entry.mongoMatchHoist` :
 *  - kind='value' (json_get) : `{path: <op literal>}` — réutilise la logique
 *    fast-path field/literal existante (write mode inclus : ne → $nin[v,null]).
 *  - kind='exists' (json_has_key) : `{path: {$exists: bool}}` — right doit
 *    être boolean literal, op ∈ {eq, ne}.
 *
 * Renvoie `null` si le hoist échoue (pas de call à gauche, pas de descripteur,
 * toPath renvoie null, right pas literal…). Le codegen bascule alors sur le
 * fast-path field/literal ou le fallback $expr.
 */
function tryMongoMatchHoist(
	op: CompareOp,
	left: PlanExpr,
	right: PlanExpr,
	alias: string | undefined,
	mode: MatchMode
): Record<string, unknown> | null {
	if (left.kind !== "call") return null;
	if (right.kind !== "literal") return null;
	const entry = SNQL_FUNCTIONS.get(left.name);
	const hoist = entry?.mongoMatchHoist;
	if (hoist === undefined) return null;
	const path = hoist.toPath(left.args, alias);
	if (path === null) return null;
	if (hoist.kind === "exists") {
		if (typeof right.value !== "boolean") return null;
		if (op !== "eq" && op !== "ne") return null;
		// eq true → exists true. eq false → exists false. ne inverse.
		const wantExists = (op === "eq") === right.value;
		return { [path]: { $exists: wantExists } };
	}
	// kind='value' (défaut). Réutilise la logique field/literal existante.
	if (op === "ne" && mode === "write") {
		return { [path]: { $nin: [bsonValue(right.value), null] } };
	}
	return { [path]: { [MONGO_OP[op]]: bsonValue(right.value) } };
}

/**
 * Convertit un motif SQL LIKE en regex ancrée sur toute la chaîne.
 * `%`→`[\s\S]*`, `_`→`[\s\S]` (les classes matchent aussi les newlines, comme SQL LIKE) ;
 * ancre de fin `\z` (fin absolue, pas avant un `\n` final comme le ferait `$` en PCRE).
 */
function likeToRegex(pattern: string): string {
	let out = "^";
	for (const ch of pattern) {
		if (ch === "%") {
			out += "[\\s\\S]*";
		} else if (ch === "_") {
			out += "[\\s\\S]";
		} else {
			out += REGEX_SPECIAL.test(ch) ? `\\${ch}` : ch;
		}
	}
	return `${out}\\z`;
}
