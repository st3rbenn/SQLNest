import type { NativeQuery, ResultSet } from "@sqlnest/snql";
import { EngineExecutionError } from "../errors";
import { normalizeBson } from "./bson";
import type { MongoContext } from "./context";
import { describeMongoExecutionError } from "./execution-errors";
import { missingRefTargets, physicalRef } from "./fk";
import { loadPkAliases } from "./introspect";

/**
 * DDL émulé — clés étrangères déclarées.
 */

/**
 * FK/3 drop ref Mongo (ADR-031). La FK déclarée vit dans `_snql_refs`
 * (`_id` = nom de contrainte, upsert FK/1a) — un `deleteOne` suffit :
 * l'enforcement write-precheck/cascade s'arrête de lui-même puisque
 * `loadRefs` recharge la collection à chaque write (aucun cache).
 * Le filtre inclut `fromCollection` = parité sémantique PG (`ALTER TABLE
 * t DROP CONSTRAINT name` exige la contrainte SUR t). D3 : deletedCount 0
 * → silence si `ifExists`, sinon refus typé. Auto-cleanup : `_snql_refs`
 * vide → drop de la collection metadata (aucun artefact SQLNest dans le
 * dump, miroir du cleanup `_snql_enums`).
 */
export async function executeDDLDropRef(
	cx: MongoContext,
	query: Extract<NativeQuery, { kind: "mongo-ddl"; operation: "drop-ref" }>
): Promise<ResultSet> {
	const db = cx.db();
	const refsCol = db.collection("_snql_refs");
	try {
		const res = await refsCol.deleteOne({
			_id: query.name as unknown as import("mongodb").ObjectId,
			fromCollection: query.collection
		});
		if (res.deletedCount === 0 && !query.ifExists) {
			throw new EngineExecutionError(
				`drop ref échouée : foreign key '${query.name}' inconnue sur '${query.collection}' — rien dans _snql_refs (utilise 'if exists' pour ignorer)`
			);
		}
		const remaining = await refsCol.countDocuments({});
		if (remaining === 0) {
			try {
				await refsCol.drop();
			} catch (cleanupCause) {
				const code = (cleanupCause as { code?: unknown } | null)?.code;
				// NamespaceNotFound = collection jamais créée ou déjà purgée — safe.
				if (code !== 26) throw cleanupCause;
			}
		}
		return { columns: [], rows: [], rowCount: 0 };
	} catch (cause) {
		if (cause instanceof EngineExecutionError) throw cause;
		throw new EngineExecutionError(
			`drop ref MongoDB échouée sur '${query.name}' — ${describeMongoExecutionError(cause)}`,
			{ cause }
		);
	}
}

/**
 * `add ref` Mongo (ADR-036 E/1a). PG refuse une FK posée sur des orphelins ;
 * ici le préflight les compte avec la règle du write-precheck FK/1b (valeur
 * cherchée sous `toColumn`, et sous `_id` quand la cible est `id`), puis la
 * FK entre dans `_snql_refs` — `insertOne` : un nom déjà pris est refusé.
 */
export async function executeDDLAddRef(
	cx: MongoContext,
	query: Extract<NativeQuery, { kind: "mongo-ddl"; operation: "add-ref" }>
): Promise<ResultSet> {
	const db = cx.db();
	const { ref } = query;
	try {
		const exists = await db
			.listCollections({ name: query.collection }, { nameOnly: true })
			.toArray();
		if (exists.length === 0) {
			throw new EngineExecutionError(
				`add ref échouée : collection '${query.collection}' inexistante`
			);
		}
		const unresolved = await findUnresolvedRefValues(
			cx,
			physicalRef(
				{ ...ref, fromCollection: query.collection },
				await loadPkAliases(db)
			)
		);
		if (unresolved.count > 0) {
			const sample = unresolved.sample
				.map((v) => JSON.stringify(normalizeBson(v)))
				.join(", ");
			throw new EngineExecutionError(
				`${unresolved.count} docs de '${query.collection}' ont '${ref.fromColumn}' sans correspondance dans ${ref.toCollection}.${ref.toColumn} (ex. ${sample}) — corrige-les d'abord, par exemple : update ${query.collection} where ${ref.fromColumn} = ${JSON.stringify(normalizeBson(unresolved.sample[0]))} set ${ref.fromColumn} = null, puis relance add ref`
			);
		}
		await db.collection("_snql_refs").insertOne({
			_id: ref.name as unknown as import("mongodb").ObjectId,
			fromCollection: ref.fromCollection,
			fromColumn: ref.fromColumn,
			toCollection: ref.toCollection,
			toColumn: ref.toColumn,
			onDelete: ref.onDelete,
			onUpdate: ref.onUpdate
		});
		return { columns: [], rows: [], rowCount: 0 };
	} catch (cause) {
		if (cause instanceof EngineExecutionError) throw cause;
		if ((cause as { code?: unknown } | null)?.code === 11000) {
			throw new EngineExecutionError(
				`add ref échouée : une foreign key '${ref.name}' existe déjà — choisis un autre nom avec 'as <nom>'`,
				{ cause }
			);
		}
		throw new EngineExecutionError(
			`add ref MongoDB échouée sur '${ref.name}' — ${describeMongoExecutionError(cause)}`,
			{ cause }
		);
	}
}

/**
 * Valeurs de `fromColumn` qui ne résolvent pas dans la cible : valeurs
 * distinctes par paquets de 1000, résolues en un `$in` par paquet, puis
 * nombre de documents concernés. Les valeurs sortent de la base, déjà en
 * BSON — pas d'hydratation.
 */
async function findUnresolvedRefValues(
	cx: MongoContext,
	ref: {
		readonly fromCollection: string;
		readonly fromColumn: string;
		readonly toCollection: string;
		readonly toColumn: string;
	}
): Promise<{ count: number; sample: unknown[] }> {
	const db = cx.db();
	const from = db.collection(ref.fromCollection);
	const missing: unknown[] = [];
	let batch: unknown[] = [];
	const resolve = async (): Promise<void> => {
		if (batch.length === 0) return;
		missing.push(...(await missingRefTargets(cx, ref, batch)));
		batch = [];
	};
	const distinct = from.aggregate(
		[
			{ $match: { [ref.fromColumn]: { $exists: true, $ne: null } } },
			{ $group: { _id: `$${ref.fromColumn}` } }
		],
		{ allowDiskUse: true, batchSize: 1000 }
	);
	for await (const group of distinct) {
		batch.push((group as { _id: unknown })._id);
		if (batch.length >= 1000) await resolve();
	}
	await resolve();
	let count = 0;
	for (let i = 0; i < missing.length; i += 1000) {
		count += await from.countDocuments({
			[ref.fromColumn]: { $in: missing.slice(i, i + 1000) }
		});
	}
	return { count, sample: missing.slice(0, 3) };
}

/**
 * Stocke des FK déclarées dans la collection metadata `_snql_refs`
 * (ADR-031 FK/1a). `_id` = nom de contrainte (idempotent : upsert pour
 * qu'un re-run create-table `if not exists` ne double pas). Déclaration
 * seulement à ce stade — l'enforcement runtime arrive en FK/1b.
 */
export async function storeRefs(
	cx: MongoContext,
	refs: readonly {
		name: string;
		fromCollection: string;
		fromColumn: string;
		toCollection: string;
		toColumn: string;
		onDelete: string;
		onUpdate: string;
	}[]
): Promise<void> {
	const col = cx.db().collection("_snql_refs");
	for (const r of refs) {
		await col.updateOne(
			{ _id: r.name as unknown as import("mongodb").ObjectId },
			{
				$set: {
					fromCollection: r.fromCollection,
					fromColumn: r.fromColumn,
					toCollection: r.toCollection,
					toColumn: r.toColumn,
					onDelete: r.onDelete,
					onUpdate: r.onUpdate
				}
			},
			{ upsert: true }
		);
	}
}
