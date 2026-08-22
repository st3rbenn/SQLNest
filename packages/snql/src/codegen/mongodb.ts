import { SnqlError } from "../diagnostics";
import { SNQL_FUNCTIONS } from "../functions";
import type {
	CastTarget,
	CompareOp,
	IntrospectPlan,
	LogicalPlan,
	MutationPlan,
	PlanColumnValue,
	PlanExpr,
	PlanProjectField,
	PlanSortKey,
	RawPlan,
	SqlValue,
	TransactionPlan,
	TransactionPlanItem
} from "../ir/plan";
import { isSqlDecimal, linearize } from "../ir/plan";
import type {
	Mapper,
	MongoQuery,
	MongoStage,
	MongoTransaction,
	MongoTransactionStep,
	MongoWriteQuery,
	NativeQuery
} from "./mapper";

/**
 * Mapper MongoDB — pur, génère une aggregation pipeline.
 *
 * Une pipeline Mongo est **intrinsèquement ordonnée** (chaque stage nourrit le
 * suivant), donc l'ordre de l'IR mappe 1:1 sur les stages — pas besoin
 * d'imbrication (contrairement à SQL). 
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
				// Sprint v3 Mongo : upsert = insert + onConflict → op séparé côté
				// native (dispatch bulkWrite adapter-side vs insertMany).
				if (plan.onConflict !== undefined) {
					return {
						...base,
						op: "upsert",
						operations: renderUpsertOperations(plan)
					};
				}
				// insert-select Mongo via aggregate + $merge
				// dans une collection différente. Le sourcePlan est rendu comme
				// pipeline normale via mongoMapper.map ; on ajoute $merge terminal.
				if (plan.sourcePlan !== undefined) {
					const sourceNative = mongoMapper.map(plan.sourcePlan) as MongoQuery;
					return {
						...base,
						op: "insert-select-agg-merge",
						sourceCollection: sourceNative.collection,
						pipeline: [
							...sourceNative.pipeline,
							{
								$merge: {
									into: plan.collection,
									whenMatched: "fail",
									whenNotMatched: "insert"
								}
							}
						]
					};
				}
				return { ...base, op: "insert", documents: renderDocuments(plan) };
			case "update":
				// write-join Mongo via aggregate + $merge natif.
				// Emit un pipeline [$match?, $lookup+$unwind par join, $set, $unset
				// aliases join, $merge into:self]. Le $merge est terminal, écrit
				// comme side-effect. Atomicité par-doc via whenMatched='merge'.
				if (plan.joins !== undefined && plan.joins.length > 0) {
					return {
						...base,
						op: "update-agg-merge",
						pipeline: renderUpdateJoinPipeline(plan)
					};
				}
				return {
					...base,
					op: "update",
					filter: renderWriteFilter(plan.predicate, plan.alias),
					update: renderUpdate(plan.assignments)
				};
			case "delete":
				return {
					...base,
					op: "delete",
					filter: renderWriteFilter(plan.predicate, undefined)
				};
		}
	},
	/**
	 * passe l'IntrospectPlan tel quel au shape MongoIntrospectQuery.
	 * L'adapter Mongo dispatch selon `plan.kind` (list-tables → db.listCollections
	 * sur la DB de la connection). Namespace (DB name) déjà dans la connection —
	 * l'adapter n'a pas besoin de le lire depuis ctx.
	 */
	mapIntrospect(plan: IntrospectPlan): NativeQuery {
		return { engine: "mongodb", kind: "mongo-introspect", plan };
	},
	/**
	 * Sprint TxMongo : bloc `transaction { … }` sur Mongo (requiert un replica
	 * set côté serveur). Refus explicit des `savepoint` (Mongo n'en a pas ; on
	 * ne les simule pas — un savepoint qui "rollback juste ma sous-section"
	 * demanderait de re-jouer le reste, sémantique dangereuse). Les isolation
	 * levels SNQL (read_committed / repeatable_read / serializable) sont
	 * mappés côté adapter en readConcern + writeConcern sur la session.
	 */
	mapTransaction(plan: TransactionPlan): MongoTransaction {
		const steps: MongoTransactionStep[] = [];
		flattenMongoTransactionBody(plan.body, steps);
		return plan.isolation !== undefined
			? { engine: "mongodb", kind: "mongo-transaction", isolation: plan.isolation, steps }
			: { engine: "mongodb", kind: "mongo-transaction", steps };
	},
	/**
	 * `raw {...}` Mongo → MongoRawQuery pour db.runCommand().
	 * L'Expr.object est évalué en Record<string, unknown> — refuse toute
	 * expression non-literal (field, call, etc. n'ont pas de sens dans une
	 * command). Refus explicit d'un `raw "SQL"` (payload PG sur engine Mongo).
	 */
	mapRaw(plan: RawPlan): NativeQuery {
		if (plan.payload.kind !== "mongo") {
			throw new SnqlError(
				"'raw \"...\"' est du SQL — sur MongoDB utilise 'raw {command: \"...\"}'.",
				"codegen_raw_shape_mismatch"
			);
		}
		return {
			engine: "mongodb",
			kind: "mongo-raw",
			command: evalObjectLiteral(plan.payload.command)
		};
	}
};

/**
 * Sprint TxMongo : aplatit un body TransactionPlan en steps Mongo pré-rendus.
 * Réutilise `mongoMapper.map` / `mongoMapper.mapMutation` pour éviter la
 * duplication de la logique de codegen — chaque item est mappé exactement
 * comme s'il était isolé, l'adapter passe juste la `session` au driver au
 * moment d'exécuter. Refus explicit d'un savepoint : Mongo n'a pas d'API
 * pour rollback partiel — le simuler exige de re-jouer les steps précédents
 * hors transaction, avec une sémantique de conflit ingérable.
 */
function flattenMongoTransactionBody(
	body: readonly TransactionPlanItem[],
	out: MongoTransactionStep[]
): void {
	for (const item of body) {
		if (item.kind === "read") {
			out.push({ kind: "query", query: mongoMapper.map(item.plan) as MongoQuery });
		} else if (item.kind === "write") {
			out.push({
				kind: "write",
				write: mongoMapper.mapMutation(item.plan) as MongoWriteQuery
			});
		} else {
			// savepoint préservé comme step dédié (plus flatten).
			// L'adapter Mongo capture snapshot pre-write + compensation runtime si
			// erreur dans le body. Les gates MVP (nested, upsert, write-join,
			// insert-select, raw) sont refusés au planner en amont.
			const nested: MongoTransactionStep[] = [];
			flattenMongoTransactionBody(item.body, nested);
			out.push({ kind: "savepoint", name: item.name, body: nested });
		}
	}
}

/**
 * Évalue récursivement un Expr.object en Record littéral pour un raw Mongo.
 * Refuse tout non-literal (field, call, subquery, cast) — un command Mongo
 * doit être 100% autonome, aucune référence à une col ou fn SNQL.
 */
function evalObjectLiteral(
	expr: import("../parser/ast").Expr
): Record<string, unknown> {
	if (expr.type !== "object") {
		throw new SnqlError(
			"'raw' Mongo attend un object literal — pas de field/call/expression",
			"codegen_raw_non_literal"
		);
	}
	const out: Record<string, unknown> = {};
	for (const entry of expr.entries) {
		out[entry.key] = evalLiteralValue(entry.value);
	}
	return out;
}

function evalLiteralValue(
	expr: import("../parser/ast").Expr
): unknown {
	if (expr.type === "literal") {
		const v = expr.value;
		if (v.kind === "number") return Number(v.raw);
		if (v.kind === "string") return v.value;
		if (v.kind === "boolean") return v.value;
		return null;
	}
	if (expr.type === "object") return evalObjectLiteral(expr);
	if (expr.type === "array") return expr.items.map(evalLiteralValue);
	throw new SnqlError(
		`'raw' Mongo : expression '${expr.type}' non literal — command doit être autonome`,
		"codegen_raw_non_literal",
		expr.span
	);
}

/**
 * Sprint v3 Mongo : upsert = insert + onConflict. Chaque row du batch génère
 * une entrée bulkWrite avec :
 *  - `filter` : {key_col_i: row_value_i} pour les cols du conflict target
 *  - `setOnInsert` : les fields du doc à créer si aucun match (tous les cols
 *    sauf ceux dans `set`)
 *  - `set` (edit only) : les assignments — mais uniquement literals ou
 *    upsertNew (référence à la row d'insert) v1. Toute expression composite
 *    (arith, call…) est refusée : la forme classique Mongo `$set` n'accepte
 *    pas d'expression, et la forme pipeline perd `$setOnInsert`. Ticket
 *    futur : pipeline avec `$cond` pour simuler set-if-insert.
 *
 * Refus v1 : `sourcePlan` (upsert INSERT-SELECT) et `action.where` (guard
 * PG-only ON CONFLICT ... WHERE) — les deux ont un mapping Mongo non-trivial.
 */
function renderUpsertOperations(
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
				bsonMapping.set(column, bsonStoreValue(cell.value));
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
		if (onConflict.action.kind === "ignore") {
			// Tous les cols de la row → $setOnInsert. Sur match : aucun $set,
			// donc no-op (comportement DO NOTHING PG).
			const setOnInsert: Record<string, unknown> = {};
			for (const [col, val] of bsonMapping) setOnInsert[col] = val;
			ops.push({ filter, setOnInsert });
			continue;
		}
		const setCols = new Set<string>();
		const set: Record<string, unknown> = {};
		for (const a of onConflict.action.assignments) {
			const substituted = substUpsertNewToLiteral(a.value, literalMapping);
			// Après subst : accepte uniquement literal ou jsonLiteral pur — pas
			// d'expression composite (v1). Rend en BSON via bsonStoreValue (pas
			// toExprOperand qui produit du $expr indexed differently).
			if (substituted.kind === "literal") {
				set[a.column] = bsonStoreValue(substituted.value);
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
			setCols.add(a.column);
		}
		const setOnInsert: Record<string, unknown> = {};
		for (const [col, val] of bsonMapping) {
			if (!setCols.has(col)) setOnInsert[col] = val;
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
			const cell = row[index];
			if (cell === undefined) {
				doc[column] = null;
				return;
			}
			// Sprint object-literals : dispatch scalar (bsonStoreValue historique)
			// vs jsonLiteral (composite → BSON récursif via toExprOperand).
			doc[column] =
				cell.kind === "scalar"
					? bsonStoreValue(cell.value)
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
function renderWriteFilter(
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
			return expr.entries.some((e) =>
				containsNonJsonCastInPredicate(e.value)
			);
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
function renderUpdateJoinPipeline(plan: {
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

function appendStage(
	pipeline: MongoStage[],
	op: LogicalPlan,
	alias: string | undefined
): void {
	switch (op.op) {
		case "scan":
			return;
		case "filter": {
			// extract les subqueries correlated en $lookup{let,
			// pipeline} liftés AVANT le $match, remplace-les par des refs à des
			// slots synthétiques __sq_N, puis $unset les slots après le $match.
			const lifted = extractCorrelatedLookups(op.predicate, alias);
			if (lifted !== null) {
				for (const stage of lifted.lookupStages) pipeline.push(stage);
				const matchDoc = mergeMatchDocs(
					lifted.predicateResidual === null
						? null
						: renderMatch(lifted.predicateResidual, alias, "read"),
					lifted.matchAdditions
				);
				pipeline.push({ $match: matchDoc });
				pipeline.push({ $unset: lifted.synthFields });
				return;
			}
			pipeline.push({ $match: renderMatch(op.predicate, alias, "read") });
			return;
		}
		case "project": {
			// windowCalls dans project.fields → $setWindowFields
			// AVANT $project (assign compute per row, réf en alias). Le project
			// final projette les alias comme des field refs directs.
			const windowSlots = extractWindowCallsToSlots(op.fields, alias);
			for (const stage of windowSlots.stages) pipeline.push(stage);
			pipeline.push({
				$project: renderProject(op.fields, alias, windowSlots.slotByKey)
			});
			// DISTINCT / DISTINCT ON via $group + $first APRÈS
			// $project (les fields projetés sont déjà top-level, plus simple).
			if (op.unique === true || op.distinctOnKeys !== undefined) {
				appendDistinctStages(pipeline, op);
			}
			return;
		}
		case "aggregate": {
			// PAIRE [$group{_id:null,...accs}, $project{_id:0,...renames}]
			// via SSA extract. op.groupKeys peuplé → `_id: <keys>`
			// non-null (flat object), $project inclut les groupKeys ; op.having
			// → SSA extract sur having aussi (aggregates partagent slots avec
			// pick), $match {$expr:...} après $project, $unset des slots
			// having-only à la fin.
			const { groupStage, projectStage, havingExpr, havingSlots } =
				renderAggregatePipeline(op.fields, alias, op.groupKeys, op.having);
			pipeline.push({ $group: groupStage });
			pipeline.push({ $project: projectStage });
			if (havingExpr !== undefined) {
				pipeline.push({ $match: { $expr: havingExpr } });
				if (havingSlots.length > 0) {
					pipeline.push({ $unset: havingSlots });
				}
			}
			return;
		}
		case "sort": {
			// $sort après $project doit référencer les champs projetés.
			// Si une sort key référence un field DROPPÉ par le project précédent, on
			// insère $sort AVANT $project — sort opère alors sur les docs sources
			// qui contiennent encore le field (aligné SQL ORDER BY sur FROM col).
			// Cas group/aggregate : jamais reorder ($group détruit les rows sources,
			// sort DOIT rester après).
			const sortStage: MongoStage = { $sort: renderSort(op.keys, alias) };
			const prev = pipeline[pipeline.length - 1];
			if (prev !== undefined && "$project" in prev) {
				const projectOut = prev.$project as Record<string, unknown>;
				const projectedFields = new Set<string>();
				for (const key of Object.keys(projectOut)) {
					if (key === "_id") continue;
					if (projectOut[key] !== 0 && projectOut[key] !== false) projectedFields.add(key);
				}
				const sortRefsMissing = op.keys.some((k) => {
					const path = mongoField(k.path, alias);
					const head = path.split(".")[0]!;
					return !projectedFields.has(head);
				});
				if (sortRefsMissing) {
					// Insérer $sort avant $project (à la position du $project).
					pipeline.splice(pipeline.length - 1, 0, sortStage);
					return;
				}
			}
			pipeline.push(sortStage);
			return;
		}
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

// ─────────────────────────────────────────────────────────────────────────────
// Correlated subquery lift-lookup ($lookup{let,pipeline})
// ─────────────────────────────────────────────────────────────────────────────

interface CorrelatedLift {
	readonly lookupStages: readonly MongoStage[];
	readonly matchAdditions: readonly Record<string, unknown>[];
	readonly predicateResidual: PlanExpr | null;
	readonly synthFields: readonly string[];
}

interface CorrelatedLiftState {
	lookupStages: MongoStage[];
	matchAdditions: Record<string, unknown>[];
	predicateResidual: PlanExpr | null;
	synthFields: string[];
	counter: number;
}

/**
 * Extract les sub-queries corrélées d'un predicate WHERE en stages liftés.
 * Retourne `null` si le predicate n'en contient aucune (fast-path : appendStage
 * reste sur son chemin $match direct). Sinon retourne les lookup stages à
 * insérer AVANT le $match, les match doc additions à combiner avec le
 * predicate résiduel, et les synth fields à $unset APRÈS le $match.
 *
 * Traverse uniquement les nœuds `and` — le planner refuse déjà (via
 * `assertCorrelatedSubqueryLiftable`) toute corrélée sous OR/NOT/case ; on
 * peut donc supposer top-level ou AND-chain ici en toute sécurité.
 *
 * Reconnaît 3 formes :
 *  - `exists (subq)` correlated → lookup + `{__sq_N: {$ne: []}}`
 *  - `not exists (subq)` correlated → lookup + `{__sq_N: {$eq: []}}`
 *  - `x in (subq pick col)` correlated → lookup + `{$expr: {$in: [$x, $__sq_N.col]}}`
 */
function extractCorrelatedLookups(
	predicate: PlanExpr,
	outerAlias: string | undefined
): CorrelatedLift | null {
	const state: CorrelatedLiftState = {
		lookupStages: [],
		matchAdditions: [],
		predicateResidual: null,
		synthFields: [],
		counter: 0
	};
	state.predicateResidual = consumeCorrelatedNode(predicate, outerAlias, state);
	if (state.lookupStages.length === 0) return null;
	return {
		lookupStages: state.lookupStages,
		matchAdditions: state.matchAdditions,
		predicateResidual: state.predicateResidual,
		synthFields: state.synthFields
	};
}

function consumeCorrelatedNode(
	expr: PlanExpr,
	outerAlias: string | undefined,
	state: CorrelatedLiftState
): PlanExpr | null {
	// Cas 1 : exists correlated top-level.
	if (expr.kind === "exists") {
		if (!isCorrelatedSubplan(expr.subplan)) return expr;
		const synth = `__sq_${state.counter++}`;
		state.lookupStages.push(
			buildCorrelatedLookupStage(expr.subplan, outerAlias, synth)
		);
		state.matchAdditions = [
			...state.matchAdditions,
			{ [synth]: { $ne: [] } }
		];
		state.synthFields.push(synth);
		return null;
	}
	// Cas 2 : not exists correlated.
	if (
		expr.kind === "not" &&
		expr.operand.kind === "exists" &&
		isCorrelatedSubplan(expr.operand.subplan)
	) {
		const synth = `__sq_${state.counter++}`;
		state.lookupStages.push(
			buildCorrelatedLookupStage(expr.operand.subplan, outerAlias, synth)
		);
		state.matchAdditions = [
			...state.matchAdditions,
			{ [synth]: { $eq: [] } }
		];
		state.synthFields.push(synth);
		return null;
	}
	// Cas 3 : `x in (subq)` correlated (une seule value, kind subquery).
	if (
		expr.kind === "in" &&
		expr.values.length === 1 &&
		expr.values[0]?.kind === "subquery" &&
		isCorrelatedSubplan(expr.values[0].plan)
	) {
		const subplan = expr.values[0].plan;
		if (expr.target.kind !== "field") return expr;
		const synth = `__sq_${state.counter++}`;
		state.lookupStages.push(
			buildCorrelatedLookupStage(subplan, outerAlias, synth)
		);
		const targetPath = mongoField(expr.target.path, outerAlias);
		const pickedField = extractPickedFieldFromSubplan(subplan);
		const rhs =
			pickedField === null ? `$${synth}` : `$${synth}.${pickedField}`;
		state.matchAdditions = [
			...state.matchAdditions,
			{ $expr: { $in: [`$${targetPath}`, rhs] } }
		];
		state.synthFields.push(synth);
		return null;
	}
	// AND-chain : descendre récursivement, garder le résidu.
	if (expr.kind === "and") {
		const l = consumeCorrelatedNode(expr.left, outerAlias, state);
		const r = consumeCorrelatedNode(expr.right, outerAlias, state);
		if (l === null && r === null) return null;
		if (l === null) return r;
		if (r === null) return l;
		return { kind: "and", left: l, right: r };
	}
	return expr;
}

function isCorrelatedSubplan(subplan: LogicalPlan): boolean {
	const ops = linearize(subplan);
	const scan = ops[0];
	if (scan?.op !== "scan") return false;
	const localAlias = scan.alias;
	let found = false;
	const walk = (e: PlanExpr): void => {
		if (found) return;
		switch (e.kind) {
			case "field":
				if (e.path.length > 1 && e.path[0] !== localAlias) found = true;
				return;
			case "compare":
			case "arith":
			case "and":
			case "or":
				walk(e.left);
				walk(e.right);
				return;
			case "not":
			case "isNull":
			case "cast":
				walk(e.operand);
				return;
			case "in":
				walk(e.target);
				for (const v of e.values) walk(v);
				return;
			case "call":
			case "windowCall":
				for (const a of e.args) walk(a);
				return;
			case "case":
				for (const b of e.branches) {
					walk(b.cond);
					walk(b.value);
				}
				walk(e.elseValue);
				return;
			case "object":
				for (const en of e.entries) walk(en.value);
				return;
			case "array":
				for (const i of e.items) walk(i);
				return;
			case "subquery":
			case "exists":
			case "literal":
			case "upsertNew":
				return;
		}
	};
	for (const op of ops.slice(1)) {
		if (op.op === "filter") walk(op.predicate);
		else if (op.op === "aggregate" && op.having !== undefined) walk(op.having);
		else if (op.op === "project") {
			for (const f of op.fields) if (f.expr !== undefined) walk(f.expr);
		}
	}
	return found;
}

/** Extrait la première projection field simple (`pick col`) du subplan, ou null. */
function extractPickedFieldFromSubplan(subplan: LogicalPlan): string | null {
	const ops = linearize(subplan);
	for (const op of ops) {
		if (op.op !== "project") continue;
		const first = op.fields[0];
		if (first === undefined) return null;
		if (first.expr?.kind === "field") {
			return first.expr.path[first.expr.path.length - 1] ?? null;
		}
		if (first.expr === undefined && first.path.length > 0) {
			return first.path[first.path.length - 1] ?? null;
		}
	}
	return null;
}

/**
 * Construit un stage `$lookup {from, let, pipeline, as}` pour un sub-plan
 * correlated. Le pipeline interne :
 *  - `$match: {$expr: <rewrite du filter du subplan>}` où chaque ref au champ
 *    outer devient `$$<letVar>` et chaque ref local reste `$field`.
 *  - `$project: {_id: 0, <col>: 1}` si le subplan a un `pick`.
 *
 * `let` mappe chaque colonne outer référencée à `$<col>` (accessible sous
 * `$$<letVar>` dans le pipeline). Conventions : `<outerAlias>_<col>` lowercased.
 */
function buildCorrelatedLookupStage(
	subplan: LogicalPlan,
	_outerAlias: string | undefined,
	asField: string
): MongoStage {
	const ops = linearize(subplan);
	const scan = ops[0];
	if (scan?.op !== "scan") {
		throw new SnqlError(
			"Correlated subquery : scan racine manquant (planner assert liftable devrait avoir refusé)",
			"codegen_mongo_subquery_unsupported"
		);
	}
	const collection = scan.collection;
	const subLocalAlias = scan.alias;
	const filter = ops.find((o) => o.op === "filter");
	const project = ops.find((o) => o.op === "project");

	const outerColRefs = collectOuterColumnRefsInSubplan(subplan);
	const letDoc: Record<string, string> = {};
	const letVarMap = new Map<string, string>();
	for (const col of outerColRefs) {
		const varName = `outer_${col}`.toLowerCase();
		letDoc[varName] = `$${col}`;
		letVarMap.set(col, varName);
	}

	const pipeline: MongoStage[] = [];
	if (filter !== undefined && filter.op === "filter") {
		pipeline.push({
			$match: {
				$expr: renderMongoAggExpr(filter.predicate, subLocalAlias, letVarMap)
			}
		});
	}
	if (project !== undefined && project.op === "project") {
		const projectDoc: Record<string, unknown> = { _id: 0 };
		for (const f of project.fields) {
			let colName: string | undefined;
			if (f.expr?.kind === "field") {
				colName = f.expr.path[f.expr.path.length - 1];
			} else if (f.expr === undefined && f.path.length > 0) {
				colName = f.path[f.path.length - 1];
			}
			if (colName !== undefined) projectDoc[colName] = 1;
		}
		pipeline.push({ $project: projectDoc });
	}

	return {
		$lookup: {
			from: collection,
			let: letDoc,
			pipeline,
			as: asField
		}
	};
}

/**
 * Collecte les colonnes outer référencées dans un subplan correlated. Une col
 * = le path[1..] d'un field ref dont path[0] n'est pas l'alias local du scan
 * racine. Assumption MVP : 1 seul alias outer (planner refuse le multi-alias).
 */
function collectOuterColumnRefsInSubplan(subplan: LogicalPlan): string[] {
	const ops = linearize(subplan);
	const scan = ops[0];
	if (scan?.op !== "scan") return [];
	const localAlias = scan.alias;
	const cols = new Set<string>();
	const walk = (e: PlanExpr): void => {
		switch (e.kind) {
			case "field":
				if (e.path.length > 1 && e.path[0] !== localAlias) {
					cols.add(e.path.slice(1).join("."));
				}
				return;
			case "compare":
			case "arith":
			case "and":
			case "or":
				walk(e.left);
				walk(e.right);
				return;
			case "not":
			case "isNull":
			case "cast":
				walk(e.operand);
				return;
			case "in":
				walk(e.target);
				for (const v of e.values) walk(v);
				return;
			case "call":
			case "windowCall":
				for (const a of e.args) walk(a);
				return;
			case "case":
				for (const b of e.branches) {
					walk(b.cond);
					walk(b.value);
				}
				walk(e.elseValue);
				return;
			case "object":
				for (const en of e.entries) walk(en.value);
				return;
			case "array":
				for (const i of e.items) walk(i);
				return;
			case "subquery":
			case "exists":
			case "literal":
			case "upsertNew":
				return;
		}
	};
	for (const op of ops.slice(1)) {
		if (op.op === "filter") walk(op.predicate);
		else if (op.op === "project") {
			for (const f of op.fields) if (f.expr !== undefined) walk(f.expr);
		}
	}
	return [...cols];
}

/**
 * Rendu d'une PlanExpr en expression aggregation Mongo ($expr form). Les refs
 * au champ local restent `$field` (alias local stripped) ; les refs outer
 * (path[0] !== subLocalAlias) sont rewrité en `$$<letVar>` via `outerLetVars`.
 *
 * MVP scope : compare + and/or/not/isNull + in + literal/field/arith/cast. Le
 * planner refuse `codegen_mongo_agg_expr` pour les autres (call, case, etc.).
 */
function renderMongoAggExpr(
	expr: PlanExpr,
	subLocalAlias: string | undefined,
	outerLetVars: ReadonlyMap<string, string>
): unknown {
	switch (expr.kind) {
		case "literal": {
			const value = bsonValue(expr.value);
			return typeof value === "string" && value.startsWith("$")
				? { $literal: value }
				: value;
		}
		case "field": {
			if (expr.path.length > 1) {
				const head = expr.path[0]!;
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
			const inner = renderMongoAggExpr(expr.operand, subLocalAlias, outerLetVars);
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

/**
 * Combine le doc $match du predicate résiduel avec les match additions liftées.
 * Cas résiduel null → utilise seulement les additions ($and si multiples, sinon
 * flat). Cas additions vides → utilise seulement le résiduel. Cas mix → `$and`.
 */
function mergeMatchDocs(
	residual: Record<string, unknown> | null,
	additions: readonly Record<string, unknown>[]
): Record<string, unknown> {
	if (residual === null) {
		if (additions.length === 1) return additions[0]!;
		return { $and: [...additions] };
	}
	if (additions.length === 0) return residual;
	return { $and: [residual, ...additions] };
}

/**
 * SSA extract pour un stage aggregate. Décompose les fields en :
 *  - `groupStage` : {_id: null, __agg_0: {$sum:...}, __agg_1: {$avg:...}, ...}
 *  - `projectStage` : {_id: 0, <alias>: <expr>, ...} — chaque expression
 *    référence les slots __agg_N via `$__agg_N`.
 *
 * Déduplication : clé stable = name + JSON.stringify(argsCanonical) + flags.
 * Deux fields référençant `sum(x)` partagent le même slot.
 *
 * count(unique x) : 2-stage hardcodé — $addToSet dans $group (filtre NULL via
 * $cond+$$REMOVE pour parité PG COUNT(DISTINCT)), $size dans $project.
 * sum(unique)/avg(unique) refusés au planner (planner_agg_unique_mongo_...).
 */
function renderAggregatePipeline(
	fields: readonly PlanProjectField[],
	alias: string | undefined,
	groupKeys?: readonly (readonly string[])[],
	having?: PlanExpr
): {
	groupStage: Record<string, unknown>;
	projectStage: Record<string, unknown>;
	havingExpr?: unknown;
	havingSlots: readonly string[];
} {
	// _id = null si pas de group by, sinon flat object
	// {<lastSeg>: '$<path>'} — noms canoniques stables cross-key. Un mono-key
	// `group by year` → `_id: {year: '$year'}`. Multi-key `group by year, code`
	// → `_id: {year: '$year', code: '$code'}`.
	const groupIdInner: Record<string, unknown> = {};
	if (groupKeys !== undefined) {
		for (const key of groupKeys) {
			const lastSeg = key[key.length - 1] as string;
			groupIdInner[lastSeg] = `$${mongoField(key, alias)}`;
		}
	}
	const groupStage: Record<string, unknown> =
		groupKeys !== undefined ? { _id: groupIdInner } : { _id: null };
	const projectStage: Record<string, unknown> = { _id: 0 };
	// projette les groupKeys depuis _id via `$_id.<lastSeg>`.
	if (groupKeys !== undefined) {
		for (const key of groupKeys) {
			const lastSeg = key[key.length - 1] as string;
			projectStage[lastSeg] = `$_id.${lastSeg}`;
		}
	}
	const slotByKey = new Map<string, string>();
	let slotCounter = 0;
	let uSlotCounter = 0;

	function aggKeyOf(expr: PlanExpr & { kind: "call" }): string {
		// Clé de dédup stable — strip les spans en canonicalisant récursivement.
		return JSON.stringify({
			name: expr.name,
			args: expr.args.map(canonicalizeExpr),
			star: expr.star === true,
			unique: expr.unique === true
		});
	}

	function canonicalizeExpr(e: PlanExpr): unknown {
		if (e.kind === "literal") return { k: "literal", v: e.value };
		if (e.kind === "field") return { k: "field", p: e.path };
		if (e.kind === "call")
			return {
				k: "call",
				n: e.name,
				a: e.args.map(canonicalizeExpr),
				s: e.star === true,
				u: e.unique === true
			};
		if (e.kind === "arith")
			return {
				k: "arith",
				o: e.op,
				l: canonicalizeExpr(e.left),
				r: canonicalizeExpr(e.right)
			};
		if (e.kind === "cast")
			return { k: "cast", t: e.target, o: canonicalizeExpr(e.operand) };
		return { k: e.kind };
	}

	/**
	 * wrap le slot d'un aggregateMulti avec le post-processing
	 * approprié (sortArray + string_agg reduce). Appliqué en $project après
	 * le $group.
	 *
	 * - array_agg / json_agg : `$__agg_N` direct, ou `{$sortArray: {input, sortBy}}`
	 *   si sortKeys.
	 * - string_agg : reduce avec sep, filter NULL, éventuel sortArray.
	 */
	function wrapAggregateMultiSlot(
		call: PlanExpr & { kind: "call" },
		slot: string
	): unknown {
		const slotRef = `$${slot}`;
		// Sort intra-call : $sortArray (MongoDB 5.2+). sortBy = Record<string, 1|-1>.
		// Note : les sort keys référencent des paths SUR LES DOCS DU BUCKET
		// (pas sur la valeur pushée). Mongo permet ça via $sortArray car chaque
		// élément est un doc/scalar dont on lit le path.
		let base: unknown = slotRef;
		if (call.sortKeys !== undefined && call.sortKeys.length > 0) {
			const sortBy: Record<string, 1 | -1> = {};
			for (const k of call.sortKeys) {
				const path = k.path.join(".");
				sortBy[path] = k.direction === "desc" ? -1 : 1;
			}
			base = { $sortArray: { input: slotRef, sortBy } };
		}
		// string_agg : filter NULL puis $reduce avec sep.
		if (call.name === "string_agg") {
			const sep = call.args[1];
			if (sep === undefined) {
				throw new SnqlError(
					"string_agg attend 2 args (expr, sep) — bug lower/codegen",
					"codegen_mongo_string_agg_arity"
				);
			}
			const sepRendered = toExprOperand(sep, alias);
			// $filter pour skip null (parité PG STRING_AGG).
			const filtered = {
				$filter: {
					input: base,
					cond: { $ne: ["$$this", null] }
				}
			};
			// $reduce : join avec sep. Cast $$this en string via $toString.
			// Init "" ; premier elem → juste sa string ; suivants → $$value + sep + $$this.
			return {
				$cond: {
					if: { $eq: [{ $size: filtered }, 0] },
					then: null,
					else: {
						$reduce: {
							input: filtered,
							initialValue: "",
							in: {
								$cond: [
									{ $eq: ["$$value", ""] },
									{ $toString: "$$this" },
									{
										$concat: [
											"$$value",
											{ $toString: sepRendered },
											{ $toString: "$$this" }
										]
									}
								]
							}
						}
					}
				}
			};
		}
		// array_agg / json_agg : le slot (possibly sorted) direct.
		return base;
	}

	function transformExpr(expr: PlanExpr, insideAggArg: boolean): unknown {
		if (expr.kind === "call") {
			const entry = SNQL_FUNCTIONS.get(expr.name);
			if (entry?.kind === "aggregate" || entry?.kind === "aggregateMulti") {
				// Aggregate nested dans un arg d'agg → refusé au lower (defense).
				if (insideAggArg) {
					throw new SnqlError(
						`Aggregate imbriqué '${expr.name}(...)' — bug de sync lower/codegen (lower_agg_nested attendu)`,
						"codegen_mongo_agg_nested",
						expr.span
					);
				}
				const key = aggKeyOf(expr as PlanExpr & { kind: "call" });
				// count/sum/avg(unique x) : 2-stage $addToSet + fold hardcodé.
				// item #5 : sum(unique) et avg(unique) réutilisent le
				// même pattern SSA que count(unique) — le slot uSet stocke un set
				// des valeurs distinctes non-null, le project fold via $size / $sum /
				// $avg selon la fonction.
				if (
					expr.unique === true &&
					(expr.name === "count" ||
						expr.name === "sum" ||
						expr.name === "avg")
				) {
					const foldOf = (slot: string): Record<string, unknown> => {
						if (expr.name === "count") return { $size: `$${slot}` };
						if (expr.name === "sum") return { $sum: `$${slot}` };
						return { $avg: `$${slot}` };
					};
					const existing = slotByKey.get(key);
					if (existing !== undefined) return foldOf(existing);
					const argRendered = toExprOperand(expr.args[0]!, alias);
					const uSlot = `__u_${uSlotCounter}`;
					uSlotCounter += 1;
					slotByKey.set(key, uSlot);
					groupStage[uSlot] = {
						$addToSet: {
							$cond: [
								{ $ne: [argRendered, null] },
								argRendered,
								"$$REMOVE"
							]
						}
					};
					return foldOf(uSlot);
				}
				// Cas standard : appel du renderer aggregate (accumulator body).
				const existing = slotByKey.get(key);
				if (existing !== undefined) return `$${existing}`;
				if (entry.engines.mongodb === undefined) {
					throw new SnqlError(
						`Fonction '${expr.name}' : renderer MongoDB absent du registre`,
						"codegen_missing_function_mapping"
					);
				}
				const accBody = entry.engines.mongodb(expr.args, {
					renderExpr: (arg) => toExprOperand(arg as PlanExpr, alias),
					...(expr.star === true ? { star: true } : {}),
					...(expr.unique === true ? { unique: true } : {})
				});
				const slot = `__agg_${slotCounter}`;
				slotCounter += 1;
				slotByKey.set(key, slot);
				groupStage[slot] = accBody as Record<string, unknown>;
				// post-processing aggregateMulti — $sortArray si
				// sortKeys, $reduce pour string_agg (concat), $filter pour
				// string_agg NULL-skip.
				if (entry.kind === "aggregateMulti") {
					return wrapAggregateMultiSlot(
						expr as PlanExpr & { kind: "call" },
						slot
					);
				}
				return `$${slot}`;
			}
			// Scalar call. Args passent via transformExpr (catch nested aggregates
			// dans coalesce(sum(x), 0) → sum(x) devient '$__agg_0', 0 reste literal).
			if (entry?.engines.mongodb === undefined) {
				throw new SnqlError(
					`Fonction '${expr.name}' : renderer MongoDB absent du registre`,
					"codegen_missing_function_mapping"
				);
			}
			return entry.engines.mongodb(expr.args, {
				renderExpr: (arg) => transformExpr(arg as PlanExpr, insideAggArg)
			});
		}
		if (expr.kind === "literal") {
			const value = bsonStoreValue(expr.value);
			return typeof value === "string" && value.startsWith("$")
				? { $literal: value }
				: value;
		}
		if (expr.kind === "field") {
			// Field bare dans un pick agg field.expr → normalement refusé au lower
			// (lower_bare_field_in_agg_scalar_wrapper). Defense : rendu direct.
			return `$${mongoField(expr.path, alias)}`;
		}
		if (expr.kind === "arith") {
			return {
				[ARITH_TO_MONGO[expr.op]]: [
					transformExpr(expr.left, insideAggArg),
					transformExpr(expr.right, insideAggArg)
				]
			};
		}
		if (expr.kind === "cast") {
			// #7 : cast(_ as json) no-op sur Mongo (BSON = JSON natif),
			// squiggly INFO éditeur alerte sur `cast(str as json)` (trap type).
			// cast(<string literal> as json) parsé au lower vers
			// object/array literal — l'operand est déjà transformé. mongoRenderCast
			// centralise le rendu ($dateTrunc pour target="date", $convert sinon).
			const inner = transformExpr(expr.operand, insideAggArg);
			return mongoRenderCast(inner, expr.target, expr.operand.kind === "field");
		}
		if (expr.kind === "object") {
			const out: Record<string, unknown> = {};
			for (const e of expr.entries) {
				out[e.key] = transformExpr(e.value, insideAggArg);
			}
			return out;
		}
		if (expr.kind === "array") {
			return expr.items.map((i) => transformExpr(i, insideAggArg));
		}
		if (expr.kind === "case") {
			return {
				$switch: {
					branches: expr.branches.map((b) => ({
						case: transformExpr(b.cond, insideAggArg),
						then: transformExpr(b.value, insideAggArg)
					})),
					default: transformExpr(expr.elseValue, insideAggArg)
				}
			};
		}
		if (expr.kind === "compare") {
			return {
				[MONGO_OP[expr.op]]: [
					transformExpr(expr.left, insideAggArg),
					transformExpr(expr.right, insideAggArg)
				]
			};
		}
		if (expr.kind === "and") {
			return {
				$and: [
					transformExpr(expr.left, insideAggArg),
					transformExpr(expr.right, insideAggArg)
				]
			};
		}
		if (expr.kind === "or") {
			return {
				$or: [
					transformExpr(expr.left, insideAggArg),
					transformExpr(expr.right, insideAggArg)
				]
			};
		}
		if (expr.kind === "not") {
			return { $not: transformExpr(expr.operand, insideAggArg) };
		}
		if (expr.kind === "isNull") {
			const op = expr.negated ? "$ne" : "$eq";
			return {
				[op]: [transformExpr(expr.operand, insideAggArg), null]
			};
		}
		if (expr.kind === "in") {
			return {
				$in: [
					transformExpr(expr.target, insideAggArg),
					expr.values.map((v) => transformExpr(v, insideAggArg))
				]
			};
		}
		throw new SnqlError(
			"Opérande non supporté dans une pipeline agrégée Mongo",
			"codegen_mongo_agg_expr"
		);
	}

	// lookup rapide pour reconnaître les path-only fields comme
	// group keys — alias-stripped, dernière-seg = clé du _id.
	const groupKeyLastSegs = new Set<string>();
	if (groupKeys !== undefined) {
		for (const k of groupKeys) {
			const last = k[k.length - 1];
			if (last !== undefined) groupKeyLastSegs.add(last);
		}
	}
	// map key stable (fully-qualified last-seg join) → project
	// alias name — utile pour having qui référence les aggregates par leur
	// alias post-$project. Peuplé au fur et à mesure de la traversée des fields.
	const aggKeyToProjectAlias = new Map<string, string>();

	for (const field of fields) {
		const aliasName = (field.alias ?? field.path[field.path.length - 1]) as string;
		if (field.expr !== undefined) {
			// Enregistrer le mapping aggKey → aliasName si le top-level expr est un agg
			// direct : permet à having de le référencer via `$<alias>`.
			if (field.expr.kind === "call") {
				const entry = SNQL_FUNCTIONS.get(field.expr.name);
				if (entry?.kind === "aggregate") {
					aggKeyToProjectAlias.set(aggKeyOf(field.expr as PlanExpr & { kind: "call" }), aliasName);
				}
			}
			projectStage[aliasName] = transformExpr(field.expr, false);
		} else if (field.path.length > 0) {
			const stripped = mongoField(field.path, alias);
			const lastSeg = field.path[field.path.length - 1] as string;
			if (groupKeys !== undefined && groupKeyLastSegs.has(lastSeg)) {
				if (aliasName !== lastSeg) {
					projectStage[aliasName] = `$_id.${lastSeg}`;
				}
			} else {
				throw new SnqlError(
					`Field bare '${stripped}' dans un pick agg — bug de sync lower/codegen`,
					"codegen_mongo_agg_bare_field"
				);
			}
		} else {
			throw new SnqlError(
				`Field bare vide dans un pick agg — bug de sync lower/codegen`,
				"codegen_mongo_agg_bare_field"
			);
		}
	}

	// traverse having pour extraire ses aggregates (partagent le
	// slot map). Field refs matchant un group key → `$<lastSeg>` post-project.
	// Aggregates avec alias existant → `$<alias>` ; sinon nouveau slot projeté
	// nommé __hslot_N (unset après $match).
	const havingSlots: string[] = [];
	let havingSlotCounter = 0;

	function transformHaving(expr: PlanExpr): unknown {
		if (expr.kind === "call") {
			const entry = SNQL_FUNCTIONS.get(expr.name);
			if (entry?.kind === "aggregate") {
				const key = aggKeyOf(expr as PlanExpr & { kind: "call" });
				const existingAlias = aggKeyToProjectAlias.get(key);
				if (existingAlias !== undefined) {
					return `$${existingAlias}`;
				}
				// Force extraction dans groupStage (via transformExpr), puis assign
				// à un slot projeté anonyme.
				const raw = transformExpr(expr, false);
				const hSlot = `__hslot_${havingSlotCounter}`;
				havingSlotCounter += 1;
				projectStage[hSlot] = raw;
				havingSlots.push(hSlot);
				aggKeyToProjectAlias.set(key, hSlot);
				return `$${hSlot}`;
			}
			// Scalar call — args passent par transformHaving pour catcher aggregates
			// nested (ex: coalesce(sum(x), 0) > 100 dans having).
			if (entry?.engines.mongodb === undefined) {
				throw new SnqlError(
					`Fonction '${expr.name}' : renderer MongoDB absent du registre`,
					"codegen_missing_function_mapping"
				);
			}
			return entry.engines.mongodb(expr.args, {
				renderExpr: (arg) => transformHaving(arg as PlanExpr)
			});
		}
		if (expr.kind === "field") {
			// Field bare dans having doit référencer une group key (validé lower).
			// Après $project, la group key est top-level sous son lastSeg.
			const lastSeg = expr.path[expr.path.length - 1] as string;
			if (groupKeys !== undefined && groupKeyLastSegs.has(lastSeg)) {
				return `$${lastSeg}`;
			}
			// Defense — arriver ici = bug lower.
			throw new SnqlError(
				`Field bare '${expr.path.join(".")}' dans having sans group key correspondante — bug lower/codegen`,
				"codegen_mongo_having_bare_field"
			);
		}
		if (expr.kind === "literal") {
			const value = bsonStoreValue(expr.value);
			return typeof value === "string" && value.startsWith("$")
				? { $literal: value }
				: value;
		}
		if (expr.kind === "arith") {
			return {
				[ARITH_TO_MONGO[expr.op]]: [
					transformHaving(expr.left),
					transformHaving(expr.right)
				]
			};
		}
		if (expr.kind === "cast") {
			// cast(_ as json) déjà résolu au lower pour les string literals;
			// operand non-literal → no-op (BSON = JSON natif). mongoRenderCast
			// centralise $dateTrunc pour target="date", $convert sinon.
			return mongoRenderCast(
				transformHaving(expr.operand),
				expr.target,
				expr.operand.kind === "field"
			);
		}
		if (expr.kind === "compare") {
			return {
				[MONGO_OP[expr.op]]: [
					transformHaving(expr.left),
					transformHaving(expr.right)
				]
			};
		}
		if (expr.kind === "and") {
			return { $and: [transformHaving(expr.left), transformHaving(expr.right)] };
		}
		if (expr.kind === "or") {
			return { $or: [transformHaving(expr.left), transformHaving(expr.right)] };
		}
		if (expr.kind === "not") {
			return { $not: transformHaving(expr.operand) };
		}
		if (expr.kind === "isNull") {
			const op = expr.negated ? "$ne" : "$eq";
			return { [op]: [transformHaving(expr.operand), null] };
		}
		if (expr.kind === "in") {
			return {
				$in: [
					transformHaving(expr.target),
					expr.values.map((v) => transformHaving(v))
				]
			};
		}
		if (expr.kind === "case") {
			return {
				$switch: {
					branches: expr.branches.map((b) => ({
						case: transformHaving(b.cond),
						then: transformHaving(b.value)
					})),
					default: transformHaving(expr.elseValue)
				}
			};
		}
		if (expr.kind === "object" || expr.kind === "array") {
			throw new SnqlError(
				"Object/array literal dans having non supporté",
				"codegen_mongo_having_literal"
			);
		}
		throw new SnqlError(
			"Expression non supportée dans having Mongo",
			"codegen_mongo_having_expr"
		);
	}

	let havingExpr: unknown | undefined;
	if (having !== undefined) {
		havingExpr = transformHaving(having);
	}

	return { groupStage, projectStage, havingExpr, havingSlots };
}

/**
 * émet les stages Mongo pour DISTINCT / DISTINCT ON après un
 * $project. Deux variantes :
 *
 *  - `unique` seul (SELECT DISTINCT) : $group par TOUS les fields output,
 *    puis $replaceRoot pour remettre à plat.
 *  - `distinctOnKeys` (DISTINCT ON (k1, k2)) : $group par k1, k2 (accum
 *    $first sur les autres fields — le sort en amont détermine "first"),
 *    puis $replaceRoot avec l'objet reconstruit.
 *
 * Note : $group détruit l'ordre. Le sort post-DISTINCT devra re-trier si
 * demandé — géré par le prochain stage `sort` dans la pipeline.
 */
function appendDistinctStages(
	pipeline: MongoStage[],
	op: Extract<LogicalPlan, { op: "project" }>
): void {
	// Récupère les noms de sortie des fields projetés (alias ou last-seg).
	const outputNames = op.fields.map((f) => {
		if (f.alias !== undefined) return f.alias;
		return (f.path[f.path.length - 1] as string) ?? "";
	});
	if (op.distinctOnKeys !== undefined && op.distinctOnKeys.length > 0) {
		// DISTINCT ON — group par les keys, $first sur les autres.
		const idInner: Record<string, unknown> = {};
		for (const k of op.distinctOnKeys) {
			const seg = k[k.length - 1] as string;
			idInner[seg] = `$${seg}`;
		}
		const groupFields: Record<string, unknown> = { _id: idInner };
		const keySet = new Set(op.distinctOnKeys.map((k) => k[k.length - 1] as string));
		for (const name of outputNames) {
			if (keySet.has(name)) continue;
			groupFields[name] = { $first: `$${name}` };
		}
		pipeline.push({ $group: groupFields });
		// Reconstitue l'objet plat : keys sortent de _id, autres sont déjà top.
		const projectBack: Record<string, unknown> = { _id: 0 };
		for (const name of outputNames) {
			projectBack[name] = keySet.has(name) ? `$_id.${name}` : `$${name}`;
		}
		pipeline.push({ $project: projectBack });
		return;
	}
	// DISTINCT (unique seul) — group par TOUS les output fields.
	const idInner: Record<string, unknown> = {};
	for (const name of outputNames) {
		idInner[name] = `$${name}`;
	}
	pipeline.push({ $group: { _id: idInner } });
	const projectBack: Record<string, unknown> = { _id: 0 };
	for (const name of outputNames) {
		projectBack[name] = `$_id.${name}`;
	}
	pipeline.push({ $project: projectBack });
}

function renderProject(
	fields: readonly PlanProjectField[],
	alias: string | undefined,
	windowSlots?: Map<string, string>
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	let picksId = false;
	for (const field of fields) {
		if (field.expr !== undefined) {
			// si l'expr est un windowCall, référencer le slot
			// précalculé par $setWindowFields (au lieu de tenter toExprOperand
			// qui ne saurait pas gérer windowCall).
			if (field.expr.kind === "windowCall" && windowSlots !== undefined) {
				const slot = windowSlots.get(windowCallKey(field.expr));
				if (slot !== undefined) {
					out[field.alias as string] = `$${slot}`;
					if (field.alias === "_id") picksId = true;
					continue;
				}
			}
			out[field.alias as string] = toExprOperand(field.expr, alias);
			if (field.alias === "_id") {
				picksId = true;
			}
			continue;
		}
		// Path nested (`pick users.email`) : Mongo interprète `{ "users.email": 1 }`
		// comme "projette le sous-champ" et retourne `{ users: { email: ... } }`.
		// Le contrat cross-engine SQL est un col top-level `email` (PG :
		// `SELECT users.email FROM ...` → col `email`). Pour parité, on rewrite :
		// path multi-segment sans alias → key = dernier segment, value = `$path`
		// (extraction explicite). Path single-segment reste `{ col: 1 }`.
		const isNestedNoAlias =
			field.alias === undefined && field.path.length > 1;
		const key =
			field.alias !== undefined
				? field.alias
				: isNestedNoAlias
					? (field.path[field.path.length - 1] as string)
					: mongoField(field.path, alias);
		out[key] =
			field.alias !== undefined || isNestedNoAlias
				? `$${mongoField(field.path, alias)}`
				: 1;
		if (key === "_id") {
			picksId = true;
		}
	}
	if (!picksId) {
		out._id = 0;
	}
	return out;
}

/**
 * clé stable pour dédup les windowCalls identiques (même fn +
 * partition + sort) — deux fields référençant le même windowCall partagent
 * un seul slot dans $setWindowFields.
 */
function windowCallKey(expr: PlanExpr & { kind: "windowCall" }): string {
	return JSON.stringify({
		n: expr.name,
		p: expr.partitionKeys,
		s: expr.sortKeys.map((k) => ({ p: k.path, d: k.direction }))
	});
}

/**
 * scanne les fields pour extraire les windowCalls, produit les
 * $setWindowFields stages à insérer avant $project. Retourne aussi le
 * slotByKey pour que renderProject référence `$__win_N` au lieu d'essayer de
 * rendre l'expression.
 *
 * `$setWindowFields` a une contrainte : un seul stage peut avoir une seule
 * `partitionBy` + `sortBy`. Pour des windows différents (partition/sort
 * différents), on émet plusieurs stages consécutifs.
 */
function extractWindowCallsToSlots(
	fields: readonly PlanProjectField[],
	alias: string | undefined
): {
	stages: MongoStage[];
	slotByKey: Map<string, string>;
} {
	const slotByKey = new Map<string, string>();
	// Group par (partition, sort) key — chaque groupe = un $setWindowFields.
	const groupsByPartitionSort = new Map<
		string,
		{
			partitionBy: unknown;
			sortBy: Record<string, 1 | -1> | undefined;
			outputs: Record<string, unknown>;
		}
	>();
	let slotCounter = 0;
	for (const field of fields) {
		if (field.expr?.kind !== "windowCall") continue;
		const w = field.expr;
		const key = windowCallKey(w);
		if (slotByKey.has(key)) continue; // dédup
		const slot = `__win_${slotCounter}`;
		slotCounter += 1;
		slotByKey.set(key, slot);
		// Group key : partition + sort canonique.
		const groupKey = JSON.stringify({ p: w.partitionKeys, s: w.sortKeys });
		let group = groupsByPartitionSort.get(groupKey);
		if (group === undefined) {
			const partitionBy =
				w.partitionKeys.length === 0
					? null
					: w.partitionKeys.length === 1
						? `$${mongoField(w.partitionKeys[0]!, alias)}`
						: w.partitionKeys.reduce<Record<string, string>>((acc, p) => {
								const seg = p[p.length - 1]!;
								acc[seg] = `$${mongoField(p, alias)}`;
								return acc;
							}, {});
			const sortBy: Record<string, 1 | -1> | undefined =
				w.sortKeys.length === 0
					? undefined
					: w.sortKeys.reduce<Record<string, 1 | -1>>((acc, k) => {
							acc[mongoField(k.path, alias)] = k.direction === "desc" ? -1 : 1;
							return acc;
						}, {});
			group = { partitionBy, sortBy, outputs: {} };
			groupsByPartitionSort.set(groupKey, group);
		}
		// Renderer body du windowCall.
		const entry = SNQL_FUNCTIONS.get(w.name);
		if (entry?.engines.mongodb === undefined) {
			throw new SnqlError(
				`Window function '${w.name}' : renderer MongoDB absent`,
				"codegen_missing_function_mapping"
			);
		}
		const body = entry.engines.mongodb(w.args, {
			renderExpr: (a) => toExprOperand(a as PlanExpr, alias)
		});
		group.outputs[slot] = body;
	}
	const stages: MongoStage[] = [];
	for (const group of groupsByPartitionSort.values()) {
		const setStage: Record<string, unknown> = {
			partitionBy: group.partitionBy,
			output: group.outputs
		};
		if (group.sortBy !== undefined) setStage.sortBy = group.sortBy;
		stages.push({ $setWindowFields: setStage });
	}
	return { stages, slotByKey };
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
	alias: string | undefined
): Record<string, unknown> {
	// Mirror hoist JSON dans la négation. `not (json_get(x,'k')='v')`
	// et `not (json_has_key(x,'k')=true)` doivent produire l'inverse hoisté
	// natif (sinon fallback $expr non-indexable via composition not/$eq).
	const negatedOp = NEGATED_HOIST_OP[op];
	if (negatedOp !== undefined) {
		const hoisted = tryMongoMatchHoist(negatedOp, left, right, alias, "write");
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
	// Garde write : un cast dans un filtre de mutation Mongo passerait par
	// `$expr` (via toExprOperand), or Mongo v5+ supporte `$expr` en update
	// filter, mais un `$convert` sur un field absent throw ConversionFailure
	// et une purge silencieuse de la mauvaise ligne est bien pire qu'une
	// erreur. Message DÉDIÉ (pas de réutilisation champ↔champ trompeuse).
	if (
		mode === "write" &&
		(left.kind === "cast" || right.kind === "cast")
	) {
		throw new SnqlError(
			"cast dans un filtre de mutation Mongo non supporté v1 — matérialise la valeur convertie côté application, ou match sur la valeur brute",
			"codegen_mongo_write_cast_predicate",
			(left.kind === "cast" ? left.span : right.span)
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
		// `!=` en écriture : `$ne` matcherait aussi l'absent/null → perte de données
		// sur un `remove`/`update`. `$nin: [v, null]` exclut la valeur ET l'absent/null,
		// comme `<>` en SQL (3VL). En lecture, sémantique Mongo native conservée.
		if (op === "ne" && mode === "write") {
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
			$and: [
				toExprOperand(expr.left, alias),
				toExprOperand(expr.right, alias)
			]
		};
	}
	if (expr.kind === "or") {
		return {
			$or: [
				toExprOperand(expr.left, alias),
				toExprOperand(expr.right, alias)
			]
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

const ARITH_TO_MONGO: Readonly<Record<"+" | "-" | "*" | "/" | "%", string>> = {
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
