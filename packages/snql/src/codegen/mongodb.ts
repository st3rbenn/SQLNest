import { SnqlError } from "../diagnostics";
import type {
	CompareOp,
	LogicalPlan,
	MutationPlan,
	PlanColumnValue,
	PlanExpr,
	PlanProjectField,
	PlanSortKey,
	SqlValue
} from "../ir/plan";
import { isSqlDecimal, linearize } from "../ir/plan";
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
	mapMutation(plan: MutationPlan): NativeQuery {
		const base = {
			engine: "mongodb",
			kind: "mongo-write",
			collection: plan.collection
		} as const;
		switch (plan.op) {
			case "insert":
				return { ...base, op: "insert", documents: renderDocuments(plan) };
			case "update":
				return {
					...base,
					op: "update",
					filter: renderFilter(plan.predicate),
					update: renderUpdate(plan.assignments)
				};
			case "delete":
				return { ...base, op: "delete", filter: renderFilter(plan.predicate) };
		}
	}
};

/** Lignes d'un insert (colonnes homogènes) → documents BSON. */
function renderDocuments(
	plan: Extract<MutationPlan, { op: "insert" }>
): Record<string, unknown>[] {
	return plan.rows.map((row) => {
		if (row.length !== plan.columns.length) {
			throw new SnqlError(
				"Insert Mongo : ligne désalignée des colonnes",
				"codegen_mongo_insert_arity"
			);
		}
		const doc: Record<string, unknown> = {};
		plan.columns.forEach((column, index) => {
			// `row[index]` est garanti présent par le contrôle d'arité ci-dessus ;
			// `?? null` satisfait noUncheckedIndexedAccess sans masquer d'erreur.
			doc[column] = bsonStoreValue(row[index] ?? null);
		});
		return doc;
	});
}

/** Prédicat → filtre Mongo. Absent ⇒ `{}` : toutes les lignes (assumé, ADR-012). */
function renderFilter(
	predicate: PlanExpr | undefined
): Record<string, unknown> {
	return predicate === undefined
		? {}
		: renderMatch(predicate, undefined, "write");
}

/**
 * Affectations → document de mise à jour. Tout littéral ⇒ `{ $set: … }` (forme
 * classique). Dès qu'une valeur référence un champ (`set total = price`), on
 * bascule sur la **forme pipeline** `[{ $set: … }]` : seule forme où Mongo évalue
 * une expression sur le document courant.
 */
function renderUpdate(
	assignments: readonly PlanColumnValue[]
): Record<string, unknown> | MongoStage[] {
	const literalOnly = assignments.every((a) => a.value.kind === "literal");
	const set: Record<string, unknown> = {};
	for (const { column, value } of assignments) {
		if (value.kind === "literal" && literalOnly) {
			set[column] = bsonStoreValue(value.value);
			continue;
		}
		const operand = toExprOperand(value, undefined);
		// En forme pipeline, une expression qui résout à *missing* fait OMETTRE la
		// clé : `set total = price` SUPPRIMERAIT `total` sur un document sans
		// `price`. `$ifNull` force `null` — la sémantique de Postgres, qui écrit
		// NULL plutôt que de faire disparaître la colonne.
		set[column] =
			value.kind === "field" ? { $ifNull: [operand, null] } : operand;
	}
	return literalOnly ? { $set: set } : [{ $set: set }];
}

function appendStage(
	pipeline: MongoStage[],
	op: LogicalPlan,
	alias: string | undefined
): void {
	switch (op.op) {
		case "scan":
			return;
		case "filter":
			pipeline.push({ $match: renderMatch(op.predicate, alias, "read") });
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
			// $lookup : imbrique les documents matchés dans le champ `as` (array).
			pipeline.push({
				$lookup: {
					from: op.collection,
					localField: mongoField(op.localField, alias),
					foreignField: op.foreignField.join("."),
					as: op.as
				}
			});
			// Kind `join` (many-to-one / one-to-one) : on aplatit l'array en objet unique
			// via $unwind avec preserveNullAndEmptyArrays (garde les lignes sans match,
			// équivalent LEFT JOIN vs INNER JOIN). Kind `embed` : on laisse l'array tel
			// quel (comportement historique, one-to-many).
			if (op.kind === "join") {
				pipeline.push({
					$unwind: {
						path: `$${op.as}`,
						preserveNullAndEmptyArrays: true
					}
				});
			}
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

/**
 * Contexte de rendu d'un prédicat. En **écriture**, les négations sont rendues
 * existence-aware (parité 3VL SQL) : `where age != 30` ne doit PAS supprimer les
 * documents où `age` est absent ou null, sinon un `remove` détruit des données
 * que Postgres épargnerait. En lecture, on garde la sémantique Mongo native (la
 * question 3VL reste ouverte, cf. [[Questions ouvertes]]).
 */
type MatchMode = "read" | "write";

function renderMatch(
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
			// En écriture, on pousse la négation aux feuilles (De Morgan) avec des
			// gardes d'existence ; `$nor` (lecture) matcherait aussi l'absent/null.
			return mode === "write"
				? negateMatch(expr.operand, alias)
				: { $nor: [renderMatch(expr.operand, alias, mode)] };
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
			// `$in` positif exclut déjà l'absent/null → identique en lecture/écriture.
			return {
				[mongoField(expr.target.path, alias)]: {
					$in: expr.values.map(literalValue)
				}
			};
		}
		case "compare":
			return renderCompare(expr.op, expr.left, expr.right, alias, mode);
		case "literal":
		case "field":
			throw new SnqlError(
				"Prédicat non supporté par le codegen Mongo (attendu une comparaison)",
				"codegen_mongo_predicate"
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
	alias: string | undefined
): Record<string, unknown> {
	switch (expr.kind) {
		case "and":
			return {
				$or: [negateMatch(expr.left, alias), negateMatch(expr.right, alias)]
			};
		case "or":
			return {
				$and: [negateMatch(expr.left, alias), negateMatch(expr.right, alias)]
			};
		case "not":
			// Double négation : on revient au prédicat positif (mode écriture).
			return renderMatch(expr.operand, alias, "write");
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
			return negateCompare(expr.op, expr.left, expr.right, alias);
		case "literal":
		case "field":
			throw new SnqlError(
				"Négation d'un prédicat non supporté par le codegen Mongo",
				"codegen_mongo_predicate"
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

function negateCompare(
	op: CompareOp,
	left: PlanExpr,
	right: PlanExpr,
	alias: string | undefined
): Record<string, unknown> {
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
	// champ↔champ : `renderCompare` en mode écriture refuse (3VL ambiguë).
	return renderCompare(op, left, right, alias, "write");
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
	alias: string | undefined,
	mode: MatchMode
): Record<string, unknown> {
	if (op === "like") {
		return renderLike(left, right, alias);
	}
	// Forme idiomatique : `{ champ: { $op: valeur } }`.
	if (left.kind === "field" && right.kind === "literal") {
		const field = mongoField(left.path, alias);
		// `!=` en écriture : `$ne` matcherait aussi l'absent/null → perte de données
		// sur un `remove`/`update`. `$nin: [v, null]` exclut la valeur ET l'absent/null,
		// comme `<>` en SQL (3VL). En lecture, sémantique Mongo native conservée.
		if (op === "ne" && mode === "write") {
			return { [field]: { $nin: [bsonValue(right.value), null] } };
		}
		return { [field]: { [MONGO_OP[op]]: bsonValue(right.value) } };
	}
	// Repli $expr pour champ↔champ. En ÉCRITURE, la 3VL d'une comparaison
	// champ↔champ (a=b, a!=b avec a/b absents/null) diverge de SQL et `$expr` ne
	// distingue pas absent/null → on REFUSE plutôt que de risquer une
	// sur-suppression. (La lecture garde la sémantique Mongo.)
	if (mode === "write") {
		throw new SnqlError(
			"Comparaison champ↔champ non supportée dans un filtre d'écriture (sémantique 3VL ambiguë sur les champs absents/null)",
			"codegen_mongo_write_field_compare"
		);
	}
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
 * Valeur d'un **filtre** (comparaison, `$in`). Un décimal exact est ramené à un
 * `double` : c'est ce que stocke la plupart des données Mongo (et la lecture
 * historique), donc `where price = 1.5` matche les doubles stockés. La fidélité
 * Decimal128 est réservée à l'ÉCRITURE de valeurs ({@link bsonStoreValue}).
 */
function bsonValue(value: SqlValue): unknown {
	assertInt64(value);
	return isSqlDecimal(value) ? Number(value.raw) : value;
}

/**
 * Valeur **stockée** (document inséré, `set col = littéral`). Le marqueur
 * {@link SqlDecimal} est préservé → l'engine l'hydrate en **Decimal128** (exact) ;
 * un `Number()` ici perdrait la précision que Postgres conserve.
 */
function bsonStoreValue(value: SqlValue): unknown {
	assertInt64(value);
	return value;
}

/**
 * Opérande d'une **expression d'agrégation** (`$expr`, update en forme pipeline).
 * Dans ce contexte, Mongo lit toute chaîne préfixée `$` comme un **chemin de
 * champ** : un littéral `"$price"` deviendrait silencieusement la valeur du champ
 * `price`. On enveloppe donc ces chaînes dans `$literal` pour forcer la donnée.
 */
function toExprOperand(expr: PlanExpr, alias: string | undefined): unknown {
	if (expr.kind === "field") {
		return `$${mongoField(expr.path, alias)}`;
	}
	if (expr.kind === "literal") {
		// Opérande d'un `set` en forme pipeline = valeur stockée → fidélité BSON.
		const value = bsonStoreValue(expr.value);
		return typeof value === "string" && value.startsWith("$")
			? { $literal: value }
			: value;
	}
	throw new SnqlError(
		"Opérande non supporté dans une comparaison $expr Mongo",
		"codegen_mongo_expr"
	);
}

function literalValue(expr: PlanExpr): unknown {
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
