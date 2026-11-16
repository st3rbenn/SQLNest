import { SnqlError } from "../diagnostics";
import { SNQL_FUNCTIONS } from "../functions";
import {
	type CastTarget,
	type CompareOp,
	isSqlDecimal,
	type PlanExpr,
	type SqlValue
} from "../ir/plan";
import { defined } from "../invariant";

/**
 * Valeurs et expressions : littéraux BSON, chemins de champ, opérandes
 * d'agrégation, conversions de type.
 */

/**
 * Rendu d'une PlanExpr en expression aggregation Mongo ($expr form). Les refs
 * au champ local restent `$field` (alias local stripped) ; les refs outer
 * (path[0] !== subLocalAlias) sont rewrité en `$$<letVar>` via `outerLetVars`.
 *
 * MVP scope : compare + and/or/not/isNull + in + literal/field/arith/cast. Le
 * planner refuse `codegen_mongo_agg_expr` pour les autres (call, case, etc.).
 */
export function renderMongoAggExpr(
	expr: PlanExpr,
	subLocalAlias: string | undefined,
	outerLetVars: ReadonlyMap<string, string>
): unknown {
	switch (expr.kind) {
		case "literal": {
			// Sous `$expr`, l'adapter ne voit pas de condition de champ : un
			// décimal y reste un double, comme avant ADR-029 D17.
			const raw = bsonValue(expr.value);
			const value = isSqlDecimal(raw) ? Number(raw.raw) : raw;
			return typeof value === "string" && value.startsWith("$")
				? { $literal: value }
				: value;
		}
		case "field": {
			if (expr.path.length > 1) {
				const head = defined(expr.path[0]);
				if (head !== subLocalAlias) {
					const col = expr.path.slice(1).join(".");
					const letVar = outerLetVars.get(col);
					if (letVar !== undefined) return `$$${letVar}`;
					if (outerLetVars.size > 0) {
						throw new SnqlError(
							`Ref outer '${head}.${col}' inconnue dans let vars (correlated subquery)`,
							"codegen_mongo_subquery_unsupported",
							expr.span
						);
					}
					// write context : pas de scope outer déclaré → path traité
					// comme un champ local nested (dot-notation Mongo).
					return `$${expr.path.join(".")}`;
				}
			}
			return `$${mongoField(expr.path, subLocalAlias)}`;
		}
		case "compare":
			return {
				[MONGO_OP[expr.op]]: [
					renderMongoAggExpr(expr.left, subLocalAlias, outerLetVars),
					renderMongoAggExpr(expr.right, subLocalAlias, outerLetVars)
				]
			};
		case "and":
			return {
				$and: [
					renderMongoAggExpr(expr.left, subLocalAlias, outerLetVars),
					renderMongoAggExpr(expr.right, subLocalAlias, outerLetVars)
				]
			};
		case "or":
			return {
				$or: [
					renderMongoAggExpr(expr.left, subLocalAlias, outerLetVars),
					renderMongoAggExpr(expr.right, subLocalAlias, outerLetVars)
				]
			};
		case "not":
			return {
				$not: renderMongoAggExpr(expr.operand, subLocalAlias, outerLetVars)
			};
		case "isNull":
			return {
				[expr.negated ? "$ne" : "$eq"]: [
					renderMongoAggExpr(expr.operand, subLocalAlias, outerLetVars),
					null
				]
			};
		case "arith":
			return {
				[ARITH_TO_MONGO[expr.op]]: [
					renderMongoAggExpr(expr.left, subLocalAlias, outerLetVars),
					renderMongoAggExpr(expr.right, subLocalAlias, outerLetVars)
				]
			};
		case "in":
			return {
				$in: [
					renderMongoAggExpr(expr.target, subLocalAlias, outerLetVars),
					expr.values.map((v) =>
						renderMongoAggExpr(v, subLocalAlias, outerLetVars)
					)
				]
			};
		case "cast": {
			const inner = renderMongoAggExpr(
				expr.operand,
				subLocalAlias,
				outerLetVars
			);
			return mongoRenderCast(inner, expr.target, expr.operand.kind === "field");
		}
		default:
			throw new SnqlError(
				`Expression '${expr.kind}' non supportée dans un sub-pipeline correlated Mongo MVP`,
				"codegen_mongo_subquery_unsupported",
				expr.span
			);
	}
}

export const MONGO_OP: Readonly<Record<CompareOp, string>> = {
	eq: "$eq",
	ne: "$ne",
	lt: "$lt",
	gt: "$gt",
	le: "$lte",
	ge: "$gte",
	like: "$regex"
};

// Bornes d'un entier signé 64 bits (BSON Long). Au-delà, un `bigint` JS ne peut
// pas être stocké par Mongo sans repli silencieux → on refuse plutôt que corrompre.
const INT64_MAX = 9223372036854775807n;

const INT64_MIN = -9223372036854775808n;

/** Refuse un `bigint` hors int64 (repli silencieux de BSON sinon). */
function assertInt64(value: SqlValue): void {
	if (typeof value === "bigint" && (value > INT64_MAX || value < INT64_MIN)) {
		throw new SnqlError(
			"Entier hors de la plage int64 : MongoDB ne peut pas le stocker sans perte de précision",
			"codegen_mongo_int64_overflow"
		);
	}
}

/**
 * Valeur littérale envoyée à Mongo : document inséré, `set col = littéral`,
 * filtre. Le marqueur {@link SqlDecimal} est préservé : l'engine l'hydrate en
 * **Decimal128** dans un document (un `Number()` perdrait la précision que
 * Postgres conserve) ; dans un filtre, il le compare en double aux valeurs
 * stockées en double et en Decimal128 aux decimal (ADR-029 D17).
 */
export function bsonValue(value: SqlValue): unknown {
	assertInt64(value);
	return value;
}

/**
 * Opérande d'une **expression d'agrégation** (`$expr`, update en forme pipeline).
 * Dans ce contexte, Mongo lit toute chaîne préfixée `$` comme un **chemin de
 * champ** : un littéral `"$price"` deviendrait silencieusement la valeur du champ
 * `price`. On enveloppe donc ces chaînes dans `$literal` pour forcer la donnée.
 */
export function toExprOperand(
	expr: PlanExpr,
	alias: string | undefined
): unknown {
	if (expr.kind === "field") {
		return `$${mongoField(expr.path, alias)}`;
	}
	if (expr.kind === "literal") {
		// Opérande d'un `set` en forme pipeline = valeur stockée → fidélité BSON.
		const value = bsonValue(expr.value);
		return typeof value === "string" && value.startsWith("$")
			? { $literal: value }
			: value;
	}
	if (expr.kind === "arith") {
		return {
			[ARITH_TO_MONGO[expr.op]]: [
				toExprOperand(expr.left, alias),
				toExprOperand(expr.right, alias)
			]
		};
	}
	if (expr.kind === "call") {
		// Délégation au registre : le renderer Mongo assemble le BSON à partir
		// des args (déjà convertis via toExprOperand récursif).
		const entry = SNQL_FUNCTIONS.get(expr.name);
		if (entry?.engines.mongodb === undefined) {
			throw new SnqlError(
				`Fonction '${expr.name}' : renderer MongoDB absent du registre`,
				"codegen_missing_function_mapping"
			);
		}
		// propage star/unique (defense-in-depth; les aggregates
		// arrivent normalement via renderAggregatePipeline, pas ici).
		return entry.engines.mongodb(expr.args, {
			renderExpr: (arg) => toExprOperand(arg as PlanExpr, alias),
			...(expr.star === true ? { star: true } : {}),
			...(expr.unique === true ? { unique: true } : {})
		});
	}
	if (expr.kind === "cast") {
		// mongoRenderCast centralise le rendu — no-op sur json
		// (BSON = JSON natif, string literals déjà parsés au lower), $dateTrunc
		// unit:"day" pour target="date" (émule PG date-only, comble div #15),
		// $convert sinon avec $ifNull wrap sur field pour parité NULL PG.
		return mongoRenderCast(
			toExprOperand(expr.operand, alias),
			expr.target,
			expr.operand.kind === "field"
		);
	}
	if (expr.kind === "object") {
		// BSON natif — chaque value passe par toExprOperand récursif qui applique
		// $literal wrap sur strings $-préfixées (infra). Les guards Mongo
		// (dollar/dot keys) sont refusés au planner AVANT d'arriver ici.
		const out: Record<string, unknown> = {};
		for (const entry of expr.entries) {
			out[entry.key] = toExprOperand(entry.value, alias);
		}
		return out;
	}
	if (expr.kind === "array") {
		// BSON array natif — chaque item passe par toExprOperand récursif.
		return expr.items.map((item) => toExprOperand(item, alias));
	}
	if (expr.kind === "case") {
		// `$switch` natif Mongo. Sémantique `case`/`then` (bool
		// évalué → then), avec `default` obligatoire (miroir de l'else surface).
		return {
			$switch: {
				branches: expr.branches.map((b) => ({
					case: toExprOperand(b.cond, alias),
					then: toExprOperand(b.value, alias)
				})),
				default: toExprOperand(expr.elseValue, alias)
			}
		};
	}
	// compare/and/or/not/isNull/in en forme $expr — nécessaires
	// dès que ces nodes apparaissent comme sous-expressions (cond d'un case/if,
	// arg d'un call, etc.). Avant, ces cas étaient invisibles car la surface
	// ne permettait pas de sous-prédicats dans les expressions. Le lower `case`
	// les fait tous transiter par toExprOperand — d'où l'ajout au step 10.
	if (expr.kind === "compare") {
		return {
			[MONGO_OP[expr.op]]: [
				toExprOperand(expr.left, alias),
				toExprOperand(expr.right, alias)
			]
		};
	}
	if (expr.kind === "and") {
		return {
			$and: [toExprOperand(expr.left, alias), toExprOperand(expr.right, alias)]
		};
	}
	if (expr.kind === "or") {
		return {
			$or: [toExprOperand(expr.left, alias), toExprOperand(expr.right, alias)]
		};
	}
	if (expr.kind === "not") {
		return { $not: toExprOperand(expr.operand, alias) };
	}
	if (expr.kind === "isNull") {
		const op = expr.negated ? "$ne" : "$eq";
		return { [op]: [toExprOperand(expr.operand, alias), null] };
	}
	if (expr.kind === "in") {
		return {
			$in: [
				toExprOperand(expr.target, alias),
				expr.values.map((v) => toExprOperand(v, alias))
			]
		};
	}
	throw new SnqlError(
		"Opérande non supporté dans une comparaison $expr Mongo",
		"codegen_mongo_expr"
	);
}

export const ARITH_TO_MONGO: Readonly<
	Record<"+" | "-" | "*" | "/" | "%", string>
> = {
	"+": "$add",
	"-": "$subtract",
	"*": "$multiply",
	"/": "$divide",
	"%": "$mod"
};

/**
 * Mapping des targets canoniques SNQL vers les types BSON de `$convert.to`.
 * `json` est absent : les documents Mongo sont déjà des BSON, le planner
 * refuse `cast(_ as json)` via Capabilities.castTargets.
 * `date` et `timestamp` collapsent tous deux vers BSON Date (Mongo n'a pas de
 * type date-only distinct — divergence documentée).
 */
export const MONGO_CAST_TYPE: Readonly<
	Record<Exclude<CastTarget, "json">, string>
> = {
	int: "long",
	float: "double",
	text: "string",
	bool: "bool",
	date: "date",
	timestamp: "date"
};

/**
 * helper centralisé pour rendre un `cast(x as target)`
 * Mongo. Comble partiellement divergence #15 (BSON collapse date/timestamp)
 * pour `target = "date"` : au lieu de `$convert{to:"date"}` (timestamp full),
 * émet `$dateTrunc{date, unit:"day", timezone:"UTC"}` pour émuler PG date-only.
 * `target = "timestamp"` reste `$convert{to:"date"}` (parity timestamp full).
 *
 * `operandIsField` pilote le wrap `$ifNull` : sans lui `$convert` sur un field
 * manquant throw `ConversionFailure` côté Mongo. Avec fallback null, la row
 * est préservée avec un cast null (parité PG NULL propagation).
 */
export function mongoRenderCast(
	inputExpr: unknown,
	target: CastTarget,
	operandIsField: boolean
): unknown {
	if (target === "json") return inputExpr;
	// Enum-ref (ADR-030 Enum/2b) — Mongo n'a pas de type cast SQL, la
	// validation member est faite au lower + le validator $jsonSchema enum
	// des colonnes typées enum enforce à l'insert. Passe-plat côté agrégation.
	if (MONGO_CAST_TYPE[target as Exclude<CastTarget, "json">] === undefined) {
		return inputExpr;
	}
	const wrapped = operandIsField ? { $ifNull: [inputExpr, null] } : inputExpr;
	if (target === "date") {
		return {
			$dateTrunc: {
				date: { $convert: { input: wrapped, to: "date" } },
				unit: "day",
				timezone: "UTC"
			}
		};
	}
	return {
		$convert: {
			input: wrapped,
			to: MONGO_CAST_TYPE[target as Exclude<CastTarget, "json">]
		}
	};
}

export function literalValue(expr: PlanExpr): unknown {
	if (expr.kind !== "literal") {
		throw new SnqlError(
			"Valeur littérale attendue dans une liste 'in'",
			"codegen_mongo_in_value"
		);
	}
	return bsonValue(expr.value);
}

/**
 * Résout un chemin de champ pour Mongo. L'alias de collection (`get users as u`)
 * n'a pas de sens en document : `u.age` → champ `age`. Les vrais chemins imbriqués
 * (`address.city`) sont conservés en notation pointée native.
 */
export function mongoField(
	path: readonly string[],
	alias: string | undefined
): string {
	const parts =
		alias !== undefined && path.length > 1 && path[0] === alias
			? path.slice(1)
			: path;
	return parts.join(".");
}
