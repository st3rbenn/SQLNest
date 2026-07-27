import { SnqlError } from "../diagnostics";
import type {
	CompareOp,
	LogicalPlan,
	PlanExpr,
	PlanProjectField,
	PlanSortKey,
	SqlValue
} from "../ir/plan";
import { linearize } from "../ir/plan";
import type { Mapper, MongoStage, NativeQuery } from "./mapper";

/**
 * Mapper MongoDB — pur, génère une aggregation pipeline.
 *
 * Une pipeline Mongo est **intrinsèquement ordonnée** (chaque stage nourrit le
 * suivant), donc l'ordre de l'IR mappe 1:1 sur les stages — pas besoin
 * d'imbrication (contrairement à SQL). Voir [[ADR-006]].
 *
 * Sûreté : les valeurs sont inline dans les objets BSON (données, pas de chaîne
 * concaténée) → pas de surface d'injection.
 */
export const mongoMapper: Mapper = {
	engine: "mongodb",
	map(plan: LogicalPlan): NativeQuery {
		const ops = linearize(plan);
		const scan = ops[0];
		if (scan === undefined || scan.op !== "scan") {
			throw new SnqlError(
				"Plan sans collection source (scan manquant)",
				"codegen_no_scan"
			);
		}
		const alias = scan.alias;
		const pipeline: MongoStage[] = [];
		for (let i = 1; i < ops.length; i += 1) {
			const op = ops[i];
			if (op !== undefined) {
				appendStage(pipeline, op, alias);
			}
		}
		return {
			engine: "mongodb",
			kind: "mongo",
			collection: scan.collection,
			pipeline
		};
	},
	mapMutation(): NativeQuery {
		throw new SnqlError(
			"Les mutations MongoDB arrivent dans une slice ultérieure",
			"codegen_mongo_mutation_unsupported"
		);
	}
};

function appendStage(
	pipeline: MongoStage[],
	op: LogicalPlan,
	alias: string | undefined
): void {
	switch (op.op) {
		case "scan":
			return;
		case "filter":
			pipeline.push({ $match: renderMatch(op.predicate, alias) });
			return;
		case "project":
			pipeline.push({ $project: renderProject(op.fields, alias) });
			return;
		case "sort":
			pipeline.push({ $sort: renderSort(op.keys, alias) });
			return;
		case "limit":
			// $skip AVANT $limit : « sauter M puis prendre N » (comme LIMIT N OFFSET M).
			if (op.offset !== undefined) {
				pipeline.push({ $skip: op.offset });
			}
			pipeline.push({ $limit: op.count });
			return;
		case "join":
			// Embed natif : $lookup imbrique les documents matchés dans le champ `as`.
			pipeline.push({
				$lookup: {
					from: op.collection,
					localField: mongoField(op.localField, alias),
					foreignField: op.foreignField.join("."),
					as: op.as
				}
			});
			return;
	}
}

function renderProject(
	fields: readonly PlanProjectField[],
	alias: string | undefined
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	let picksId = false;
	for (const field of fields) {
		const key =
			field.alias !== undefined ? field.alias : mongoField(field.path, alias);
		out[key] =
			field.alias !== undefined ? `$${mongoField(field.path, alias)}` : 1;
		if (key === "_id") {
			picksId = true;
		}
	}
	// Mongo inclut `_id` par défaut ; on le supprime pour coller à la sémantique
	// « pick = exactement ces champs » (parité avec SQL), sauf si `_id` est explicitement projeté.
	if (!picksId) {
		out._id = 0;
	}
	return out;
}

function renderSort(
	keys: readonly PlanSortKey[],
	alias: string | undefined
): Record<string, 1 | -1> {
	const out: Record<string, 1 | -1> = {};
	for (const key of keys) {
		out[mongoField(key.path, alias)] = key.direction === "desc" ? -1 : 1;
	}
	return out;
}

function renderMatch(
	expr: PlanExpr,
	alias: string | undefined
): Record<string, unknown> {
	switch (expr.kind) {
		case "and":
			return {
				$and: [renderMatch(expr.left, alias), renderMatch(expr.right, alias)]
			};
		case "or":
			return {
				$or: [renderMatch(expr.left, alias), renderMatch(expr.right, alias)]
			};
		case "not":
			return { $nor: [renderMatch(expr.operand, alias)] };
		case "isNull": {
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
			return {
				[mongoField(expr.target.path, alias)]: {
					$in: expr.values.map(literalValue)
				}
			};
		}
		case "compare":
			return renderCompare(expr.op, expr.left, expr.right, alias);
		case "literal":
		case "field":
			throw new SnqlError(
				"Prédicat non supporté par le codegen Mongo (attendu une comparaison)",
				"codegen_mongo_predicate"
			);
	}
}

const MONGO_OP: Readonly<Record<CompareOp, string>> = {
	eq: "$eq",
	ne: "$ne",
	lt: "$lt",
	gt: "$gt",
	le: "$lte",
	ge: "$gte",
	like: "$regex"
};

function renderCompare(
	op: CompareOp,
	left: PlanExpr,
	right: PlanExpr,
	alias: string | undefined
): Record<string, unknown> {
	if (op === "like") {
		return renderLike(left, right, alias);
	}
	// Forme idiomatique : `{ champ: { $op: valeur } }`.
	if (left.kind === "field" && right.kind === "literal") {
		return { [mongoField(left.path, alias)]: { [MONGO_OP[op]]: right.value } };
	}
	// Repli $expr pour champ↔champ ou littéral à gauche.
	return {
		$expr: {
			[MONGO_OP[op]]: [toExprOperand(left, alias), toExprOperand(right, alias)]
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

function toExprOperand(expr: PlanExpr, alias: string | undefined): unknown {
	if (expr.kind === "field") {
		return `$${mongoField(expr.path, alias)}`;
	}
	if (expr.kind === "literal") {
		return expr.value;
	}
	throw new SnqlError(
		"Opérande non supporté dans une comparaison $expr Mongo",
		"codegen_mongo_expr"
	);
}

function literalValue(expr: PlanExpr): SqlValue {
	if (expr.kind !== "literal") {
		throw new SnqlError(
			"Valeur littérale attendue dans une liste 'in'",
			"codegen_mongo_in_value"
		);
	}
	return expr.value;
}

/**
 * Résout un chemin de champ pour Mongo. L'alias de collection (`get users as u`)
 * n'a pas de sens en document : `u.age` → champ `age`. Les vrais chemins imbriqués
 * (`address.city`) sont conservés en notation pointée native.
 */
function mongoField(
	path: readonly string[],
	alias: string | undefined
): string {
	const parts =
		alias !== undefined && path.length > 1 && path[0] === alias
			? path.slice(1)
			: path;
	return parts.join(".");
}

// Caractères spéciaux regex à échapper lors de la conversion LIKE → $regex.
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/;

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
