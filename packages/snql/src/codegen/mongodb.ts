import { SnqlError } from "../diagnostics";
import {
	type DDLPlan,
	type IntrospectPlan,
	type LogicalPlan,
	linearize,
	type MutationPlan,
	type PlanNativeNames,
	type RawPlan,
	type TransactionPlan,
	type TransactionPlanItem
} from "../ir/plan";
import type {
	Mapper,
	MongoKeyRename,
	MongoQuery,
	MongoStage,
	MongoTransaction,
	MongoTransactionStep,
	MongoWriteQuery,
	NativeQuery
} from "./mapper";
import {
	mongoColumnType,
	mongoDefaultSpec,
	mongoRefSpec,
	renderMongoAddColumn,
	renderMongoAddEnumMember,
	renderMongoAddIndex,
	renderMongoCreateEnum,
	renderMongoCreateTable,
	renderMongoDropCollection,
	renderMongoDropColumn,
	renderMongoDropEnum,
	renderMongoDropIndex,
	renderMongoDropRef
} from "./mongodb-ddl";
import { appendStage } from "./mongodb-stages";
import {
	renderDocuments,
	renderUpdate,
	renderUpdateJoinPipeline,
	renderUpsertOperations,
	renderWriteFilter
} from "./mongodb-write";

export { MONGO_TEXT_PATTERN } from "./mongodb-ddl";
export { MONGO_CAST_TYPE, mongoRenderCast } from "./mongodb-expr";

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
function keyRenames(
	path: readonly string[],
	nativeNames: PlanNativeNames
): MongoKeyRename[] {
	return Object.entries(nativeNames).map(([from, to]) => ({ path, from, to }));
}

/**
 * Renommages de sortie des collections aliasées (ADR-036 E/1f). Un `_id` à la
 * racine du résultat ne peut venir que de la source (projection et groupe
 * l'écartent sinon) ; celui des documents d'une jointure, que de sa collection.
 */
function outputRenames(ops: readonly LogicalPlan[]): MongoKeyRename[] {
	const renames: MongoKeyRename[] = [];
	for (const op of ops) {
		if (op.op === "scan" && op.nativeNames !== undefined) {
			renames.push(...keyRenames([], op.nativeNames));
		}
		if (
			op.op === "join" &&
			op.kind !== "count" &&
			op.nativeNames !== undefined
		) {
			renames.push(...keyRenames([op.as], op.nativeNames));
		}
	}
	return renames;
}

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
		const renameKeys = outputRenames(ops);
		return {
			engine: "mongodb",
			kind: "mongo",
			collection: scan.collection,
			pipeline,
			...(renameKeys.length > 0 ? { renameKeys } : {})
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
				return {
					...base,
					op: "insert",
					documents: renderDocuments(plan),
					...(plan.nativeNames !== undefined
						? { renameKeys: keyRenames([], plan.nativeNames) }
						: {})
				};
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
	 *
	 * Exception `list schema_events` : le codegen émet un `SqlnestIntrospectQuery`
	 * (route backend SQLNest, jamais le tunnel Mongo). L'engine cible de la
	 * connection user n'importe pas — la table système vit dans SQLNest.
	 */
	mapIntrospect(plan: IntrospectPlan): NativeQuery {
		if (plan.kind === "list-schema-events") {
			return plan.postOps !== undefined && plan.postOps.length > 0
				? {
						engine: "mongodb",
						kind: "sqlnest-introspect",
						target: "schema-events",
						postOps: plan.postOps
					}
				: {
						engine: "mongodb",
						kind: "sqlnest-introspect",
						target: "schema-events"
					};
		}
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
			? {
					engine: "mongodb",
					kind: "mongo-transaction",
					isolation: plan.isolation,
					steps
				}
			: { engine: "mongodb", kind: "mongo-transaction", steps };
	},
	/**
	 * DDL Tier-2 sur Mongo (ADR-029). `create-collection` compensated : émet
	 * un `MongoDDLQuery` avec le validator `$jsonSchema` (types + required)
	 * pré-rendu, les indexes secondaires (unique field-level + PK compound),
	 * et un éventuel `primaryKeyAlias` pour aliaser `id` → `_id` (D13). L'adapter
	 * runtime dispatch vers `db.createCollection` (+ `createIndex` par index) et
	 * catch NamespaceExists code 48 si `ifNotExists=true` (D3).
	 *
	 * Refus D13 admis (invariance sémantique, PAS gap engine) : primary key
	 * single-field sur un field ≠ `id` — Mongo n'a pas de PK secondaire vraie,
	 * l'user doit passer par `add unique index` (DDL/3 v-next) pour un unique
	 * secondaire.
	 */
	mapDDL(plan: DDLPlan): NativeQuery {
		if (plan.kind === "create-table") return renderMongoCreateTable(plan);
		if (plan.kind === "add-column") return renderMongoAddColumn(plan);
		if (plan.kind === "add-index" || plan.kind === "add-unique-index") {
			return renderMongoAddIndex(plan);
		}
		if (plan.kind === "drop-index") return renderMongoDropIndex(plan);
		if (plan.kind === "drop-table") return renderMongoDropCollection(plan);
		if (plan.kind === "drop-column") return renderMongoDropColumn(plan);
		if (plan.kind === "create-enum") return renderMongoCreateEnum(plan);
		if (plan.kind === "add-enum-member") return renderMongoAddEnumMember(plan);
		if (plan.kind === "drop-enum") return renderMongoDropEnum(plan);
		if (plan.kind === "drop-ref") return renderMongoDropRef(plan);
		if (plan.kind === "alter-column") {
			const { action } = plan;
			return {
				engine: "mongodb",
				kind: "mongo-ddl",
				operation: "alter-column",
				collection: plan.target,
				column: plan.column,
				action:
					action.kind === "set-type"
						? {
								kind: "set-type",
								type: action.type,
								...mongoColumnType(action.type, action.storedAs),
								...(action.enumMembers !== undefined
									? { enumMembers: action.enumMembers }
									: {})
							}
						: action.kind === "set-default"
							? { kind: "set-default", ...mongoDefaultSpec(action.value) }
							: { kind: action.kind }
			};
		}
		if (plan.kind === "rename-column") {
			return {
				engine: "mongodb",
				kind: "mongo-ddl",
				operation: "rename-column",
				collection: plan.target,
				column: plan.column,
				newName: plan.newName,
				...(plan.renames !== undefined ? { renames: plan.renames } : {})
			};
		}
		if (plan.kind === "add-ref") {
			return {
				engine: "mongodb",
				kind: "mongo-ddl",
				operation: "add-ref",
				collection: plan.target,
				ref: mongoRefSpec(plan.ref, plan.target)
			};
		}
		throw new SnqlError(
			`DDL kind '${(plan as { kind: string }).kind}' non supporté par le codegen Mongo V1`,
			"codegen_ddl_unsupported"
		);
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
			out.push({
				kind: "query",
				query: mongoMapper.map(item.plan) as MongoQuery
			});
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

function evalLiteralValue(expr: import("../parser/ast").Expr): unknown {
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
