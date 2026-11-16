import { SnqlError } from "../diagnostics";
import type { MutationPlan, PlanColumnValue, PlanExpr } from "../ir/plan";
import type { MongoStage } from "./mapper";
import {
	bsonValue,
	mongoField,
	renderMongoAggExpr,
	toExprOperand
} from "./mongodb-expr";
import { renderMatch } from "./mongodb-match";

/**
 * Écritures : documents à insérer, filtres, mises à jour, upsert, jointure
 * dans un `update`.
 */

/**
 * Sprint v3 Mongo : upsert = insert + onConflict. Chaque row du batch génère
 * une entrée bulkWrite avec :
 *  - `filter` : {key_col_i: row_value_i} pour les cols du conflict target
 *  - `setOnInsert` : la row proposée, toutes ses cols — le doc à créer si
 *    aucun match (ADR-029 D16)
 *  - `set` (edit only) : les assignments, pour la ligne qui existait déjà
 *    — mais uniquement literals ou
 *    upsertNew (référence à la row d'insert) v1. Toute expression composite
 *    (arith, call…) est refusée : la forme classique Mongo `$set` n'accepte
 *    pas d'expression, et la forme pipeline perd `$setOnInsert`. Ticket
 *    futur : pipeline avec `$cond` pour simuler set-if-insert.
 *
 * Refus v1 : `sourcePlan` (upsert INSERT-SELECT) et `action.where` (guard
 * PG-only ON CONFLICT ... WHERE) — les deux ont un mapping Mongo non-trivial.
 */
export function renderUpsertOperations(
	plan: Extract<MutationPlan, { op: "insert" }>
): {
	filter: Record<string, unknown>;
	set?: Record<string, unknown>;
	setOnInsert: Record<string, unknown>;
}[] {
	if (plan.sourcePlan !== undefined) {
		throw new SnqlError(
			"Upsert Mongo v1 : 'add (find …) into t on conflict …' non supporté (INSERT SELECT + ON CONFLICT). Matérialise le SELECT côté application ou utilise Postgres.",
			"codegen_mongo_upsert_source_plan"
		);
	}
	const onConflict = plan.onConflict;
	if (onConflict === undefined) {
		throw new SnqlError(
			"renderUpsertOperations sans onConflict (bug dispatch mapMutation)",
			"codegen_mongo_upsert_missing_conflict"
		);
	}
	if (
		onConflict.action.kind === "update" &&
		onConflict.action.where !== undefined
	) {
		throw new SnqlError(
			"Upsert Mongo v1 : 'on conflict (…) edit set … where …' non supporté — le prédicat sélectif de PG n'a pas d'équivalent direct dans un updateOne Mongo.",
			"codegen_mongo_upsert_action_where"
		);
	}
	const ops: {
		filter: Record<string, unknown>;
		set?: Record<string, unknown>;
		setOnInsert: Record<string, unknown>;
	}[] = [];
	for (const row of plan.rows) {
		if (row.length !== plan.columns.length) {
			throw new SnqlError(
				"Upsert Mongo : ligne désalignée des colonnes",
				"codegen_mongo_upsert_arity"
			);
		}
		// Mapping BSON (pour filter + setOnInsert) + literal PlanExpr (pour subst
		// upsertNew dans les assignments edit).
		const bsonMapping = new Map<string, unknown>();
		const literalMapping = new Map<string, PlanExpr>();
		plan.columns.forEach((column, index) => {
			const cell = row[index];
			if (cell === undefined) {
				bsonMapping.set(column, null);
				literalMapping.set(column, { kind: "literal", value: null });
				return;
			}
			if (cell.kind === "scalar") {
				bsonMapping.set(column, bsonValue(cell.value));
				literalMapping.set(column, { kind: "literal", value: cell.value });
			} else {
				// jsonLiteral (composite — object/array). Non substituable en literal
				// SqlValue → interdit dans les $set d'upsert (v1). Stocké en BSON pour
				// $setOnInsert uniquement.
				bsonMapping.set(column, toExprOperand(cell.expr, undefined));
				literalMapping.set(column, cell.expr);
			}
		});
		const filter: Record<string, unknown> = {};
		for (const k of onConflict.keys) {
			if (!bsonMapping.has(k)) {
				throw new SnqlError(
					`Upsert Mongo : key col '${k}' absente des colonnes du batch — le conflict target doit référencer une col insérée.`,
					"codegen_mongo_upsert_missing_key"
				);
			}
			filter[k] = bsonMapping.get(k);
		}
		// Tous les cols de la row → $setOnInsert, y compris ceux de l'edit set :
		// une insertion écrit la row proposée, comme Postgres.
		const setOnInsert: Record<string, unknown> =
			Object.fromEntries(bsonMapping);
		if (onConflict.action.kind === "ignore") {
			// Sur match : aucun $set, donc no-op (comportement DO NOTHING PG).
			ops.push({ filter, setOnInsert });
			continue;
		}
		const set: Record<string, unknown> = {};
		for (const a of onConflict.action.assignments) {
			const substituted = substUpsertNewToLiteral(a.value, literalMapping);
			// Après subst : accepte uniquement literal ou jsonLiteral pur — pas
			// d'expression composite (v1). Rend en BSON via bsonValue (pas
			// toExprOperand qui produit du $expr indexed differently).
			if (substituted.kind === "literal") {
				set[a.column] = bsonValue(substituted.value);
			} else if (
				substituted.kind === "object" ||
				substituted.kind === "array"
			) {
				set[a.column] = toExprOperand(substituted, undefined);
			} else {
				throw new SnqlError(
					`Upsert Mongo v1 : 'on conflict edit set ${a.column} = <expr>' n'accepte que des littéraux ou 'new.<col>' (pas d'arithmétique/call). Postgres pushdown natif de EXCLUDED.<col> + arith — Mongo v2.`,
					"codegen_mongo_upsert_edit_composite"
				);
			}
		}
		ops.push({ filter, set, setOnInsert });
	}
	return ops;
}

/**
 * Substitue récursivement tout `upsertNew.<col>` par le literal PlanExpr
 * correspondant à la valeur de la row en cours. Utilisé pour rendre les
 * assignments `on conflict edit set` évaluables sans référence au symbole
 * `EXCLUDED` (qui n'a pas d'équivalent Mongo natif).
 */
function substUpsertNewToLiteral(
	expr: PlanExpr,
	mapping: ReadonlyMap<string, PlanExpr>
): PlanExpr {
	if (expr.kind === "upsertNew") {
		const v = mapping.get(expr.column);
		if (v === undefined) {
			throw new SnqlError(
				`Upsert Mongo : 'new.${expr.column}' référence une col absente du batch.`,
				"codegen_mongo_upsert_new_missing"
			);
		}
		return v;
	}
	if (expr.kind === "arith") {
		return {
			kind: "arith",
			op: expr.op,
			left: substUpsertNewToLiteral(expr.left, mapping),
			right: substUpsertNewToLiteral(expr.right, mapping)
		};
	}
	if (expr.kind === "call") {
		return {
			...expr,
			args: expr.args.map((a) => substUpsertNewToLiteral(a, mapping))
		};
	}
	if (expr.kind === "cast") {
		return {
			kind: "cast",
			target: expr.target,
			operand: substUpsertNewToLiteral(expr.operand, mapping)
		};
	}
	return expr;
}

/** Lignes d'un insert (colonnes homogènes) → documents BSON. */
export function renderDocuments(
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
			const cell = row[index];
			if (cell === undefined) {
				doc[column] = null;
				return;
			}
			// Sprint object-literals : dispatch scalar (bsonValue historique)
			// vs jsonLiteral (composite → BSON récursif via toExprOperand).
			doc[column] =
				cell.kind === "scalar"
					? bsonValue(cell.value)
					: toExprOperand(cell.expr, undefined);
		});
		return doc;
	});
}

/**
 * filtre write Mongo qui route via `$expr` + `$convert`
 * quand le predicate contient un cast (non-json). Sinon fallback sur la forme
 * `renderMatch` classique (idiomatique champ↔littéral indexable).
 *
 * Les casts type coercitifs ambigus (bool/date/timestamp) ont déjà été
 * refusés au planner via `assertMongoMutationWriteCastCoercive` — donc ici
 * on ne rencontre que int/text/float/decimal (safe pour `$convert`).
 */
export function renderWriteFilter(
	predicate: PlanExpr | undefined,
	alias: string | undefined
): Record<string, unknown> {
	if (predicate === undefined) return {};
	if (containsNonJsonCastInPredicate(predicate)) {
		return {
			$expr: renderMongoAggExpr(predicate, alias, new Map())
		};
	}
	return renderMatch(predicate, alias, "write");
}

/** Walker : true si le predicate contient au moins un cast non-json. */
function containsNonJsonCastInPredicate(expr: PlanExpr): boolean {
	switch (expr.kind) {
		case "cast":
			if (expr.target !== "json") return true;
			return containsNonJsonCastInPredicate(expr.operand);
		case "and":
		case "or":
		case "compare":
		case "arith":
			return (
				containsNonJsonCastInPredicate(expr.left) ||
				containsNonJsonCastInPredicate(expr.right)
			);
		case "not":
		case "isNull":
			return containsNonJsonCastInPredicate(expr.operand);
		case "in":
			if (containsNonJsonCastInPredicate(expr.target)) return true;
			return expr.values.some(containsNonJsonCastInPredicate);
		case "call":
		case "windowCall":
			return expr.args.some(containsNonJsonCastInPredicate);
		case "case":
			for (const b of expr.branches) {
				if (
					containsNonJsonCastInPredicate(b.cond) ||
					containsNonJsonCastInPredicate(b.value)
				)
					return true;
			}
			return containsNonJsonCastInPredicate(expr.elseValue);
		case "object":
			return expr.entries.some((e) => containsNonJsonCastInPredicate(e.value));
		case "array":
			return expr.items.some(containsNonJsonCastInPredicate);
		case "literal":
		case "field":
		case "subquery":
		case "exists":
		case "upsertNew":
			return false;
	}
}

/**
 * Affectations → document de mise à jour. Tout littéral ⇒ `{ $set: … }` (forme
 * classique). Dès qu'une valeur référence un champ (`set total = price`), on
 * bascule sur la **forme pipeline** `[{ $set: … }]` : seule forme où Mongo évalue
 * une expression sur le document courant.
 */
export function renderUpdate(
	assignments: readonly PlanColumnValue[]
): Record<string, unknown> | MongoStage[] {
	const literalOnly = assignments.every((a) => a.value.kind === "literal");
	const set: Record<string, unknown> = {};
	for (const { column, value } of assignments) {
		if (value.kind === "literal" && literalOnly) {
			set[column] = bsonValue(value.value);
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

/**
 * pipeline aggregate + `$merge` pour write-join Mongo.
 * Le pipeline lit `plan.collection`, joint les tables via `$lookup+$unwind`,
 * évalue `$set` avec les valeurs jointes (aliases join = `plan.joins[i].as`
 * → référencés en `$<alias>.<col>` dans les exprs), retire les alias join,
 * puis `$merge` de retour dans la collection cible.
 *
 * Sémantique cross-engine :
 *  - `with one X` = inner join (equiv PG `UPDATE ... FROM X WHERE l = f`) →
 *    `$unwind` sans `preserveNullAndEmptyArrays` (docs sans match droppés,
 *    pas d'update — cohérent PG où le join filtre l'update).
 *  - `whenMatched: 'merge'` = shallow merge des champs `$set` sur le doc
 *    existant (cohérent PG UPDATE ... SET semantics).
 *  - `whenNotMatched: 'discard'` = pas d'insert accidentel (le pipeline ne
 *    lit que la collection cible, donc chaque doc existe déjà — discard
 *    est un safeguard contre les edge cases).
 *
 * Limitation MVP : rowCount non-reporté. Le `$merge` en tant que stage
 * terminal ne renvoie rien via le cursor — l'adapter retourne `rowCount=null`
 * jusqu'à ce que branche un 2-pass count optionnel.
 */
export function renderUpdateJoinPipeline(plan: {
	readonly collection: string;
	readonly alias?: string;
	readonly joins?: readonly import("../ir/plan").PlanUpdateJoin[];
	readonly assignments: readonly PlanColumnValue[];
	readonly predicate?: PlanExpr;
}): MongoStage[] {
	const pipeline: MongoStage[] = [];
	// $match — predicate racine sur le doc cible (avant lookup, pour indexer).
	if (plan.predicate !== undefined) {
		pipeline.push({
			$match: renderMatch(plan.predicate, plan.alias, "write")
		});
	}
	// $lookup + $unwind par join. L'alias user (`joins[i].as`) devient le
	// nom du champ contenant le doc joint — les exprs qui référencent
	// `alias.col` produiront naturellement `$alias.col`.
	const joins = plan.joins ?? [];
	const joinAliases: string[] = [];
	for (const join of joins) {
		joinAliases.push(join.as);
		// foreignField : strip le préfixe alias (`u.id` → `id`) car Mongo
		// $lookup.foreignField est un path RELATIF à la collection jointe.
		const foreignPath =
			join.foreignField.length > 1 && join.foreignField[0] === join.as
				? join.foreignField.slice(1)
				: join.foreignField;
		pipeline.push({
			$lookup: {
				from: join.collection,
				localField: mongoField(join.localField, plan.alias),
				foreignField: foreignPath.join("."),
				as: join.as
			}
		});
		pipeline.push({
			$unwind: {
				path: `$${join.as}`,
				preserveNullAndEmptyArrays: false
			}
		});
	}
	// $set — assignments. Les exprs peuvent référencer les alias join.
	const setDoc: Record<string, unknown> = {};
	for (const { column, value } of plan.assignments) {
		const operand = toExprOperand(value, plan.alias);
		setDoc[column] =
			value.kind === "field" ? { $ifNull: [operand, null] } : operand;
	}
	pipeline.push({ $set: setDoc });
	// $unset des alias join — sinon $merge les écrirait dans le doc cible.
	if (joinAliases.length > 0) {
		pipeline.push({ $unset: joinAliases });
	}
	// $merge terminal — écrit dans la collection cible. whenMatched='merge'
	// applique un shallow merge (cohérent SET semantics), whenNotMatched=
	// 'discard' est un safeguard (jamais atteint car source=target).
	pipeline.push({
		$merge: {
			into: plan.collection,
			whenMatched: "merge",
			whenNotMatched: "discard"
		}
	});
	return pipeline;
}
