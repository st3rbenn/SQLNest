import type { NativeQuery, ResultSet, Row } from "@sqlnest/snql";
import type { ClientSession, Collection, Document } from "mongodb";
import { EngineExecutionError } from "../errors";
import { bsonMatchKey, hydrateBson, normalizeBson } from "./bson";
import type { MongoContext, MongoWrite } from "./context";
import {
	DECIMAL_TEXT_TYPE,
	declaredPipeline,
	declaredUpdate,
	textDecimals,
	toDeclaredType,
	toDeclaredTypes,
	UUID_TEXT_TYPE
} from "./declared-types";
import { withDefaults } from "./defaults";
import {
	describeMongoExecutionError,
	fkTransactionError,
	writeErrorMessage
} from "./execution-errors";
import {
	assertRefsResolve,
	checkRewrite,
	deleteCascading,
	extractSetFields,
	type FkPlan,
	fkPlan,
	type Journal,
	pipelineSetColumns,
	readColumns,
	snapshotColumns
} from "./fk";
import { loadPkAliases, type PkAlias } from "./introspect";
import {
	columnsOf,
	loadDeclaredTypes,
	renameRowKeys,
	textDecimalsOf
} from "./read";
import { pipelineWithStoredForms, withStoredForms } from "./stored-forms";
import {
	beforeMerge,
	decimalsBackToText,
	lookupCollections,
	withTextDecimalFilter,
	withTextDecimalStages
} from "./text-decimals";

/**
 * Écritures : insert, update, delete, upsert et insert depuis une requête,
 * avec ou sans clés étrangères à faire respecter.
 */

/** Champ témoin d'un upsert : l'insertion le reçoit du filtre, à `null`. */
const UPSERT_MARK = "__snql_upsert";

/**
 * Upsert d'un `add … on conflict` (sprint v3 Mongo), un `updateOne` par
 * ligne. Avec `$set` + `$setOnInsert`, Mongo appliquerait aussi l'edit set
 * au document inséré (ADR-029 D16) : l'edit passe par un update en forme
 * pipeline qui choisit sa branche sur `UPSERT_MARK` — `null` dans le
 * document que l'insertion tire du filtre, absent d'un document existant —
 * puis le retire. Comme sous Postgres, `rowCount` compte les lignes
 * insérées ou modifiées.
 */
async function runUpsert(
	coll: Collection,
	operations: Extract<MongoWrite, { op: "upsert" }>["operations"],
	session?: ClientSession
): Promise<{ rowCount: number; upsertedIds: unknown[] }> {
	const ops = operations.map((op) => {
		const filter = hydrateBson(op.filter, true) as Document;
		// Valeurs stockées, pas un filtre : un `_id` texte reste du texte.
		const row = hydrateBson(op.setOnInsert, false) as Document;
		if (op.set === undefined) {
			return {
				updateOne: { filter, update: { $setOnInsert: row }, upsert: true }
			};
		}
		const edit = hydrateBson(op.set, false) as Document;
		const inserting = { $eq: [{ $type: `$${UPSERT_MARK}` }, "null"] };
		return {
			updateOne: {
				filter: { ...filter, [UPSERT_MARK]: null },
				update: [
					{
						$replaceWith: {
							$cond: [
								inserting,
								{ $mergeObjects: ["$$ROOT", { $literal: row }] },
								{ $mergeObjects: ["$$ROOT", { $literal: edit }] }
							]
						}
					},
					{ $unset: UPSERT_MARK }
				],
				upsert: true
			}
		};
	});
	const res = await coll.bulkWrite(
		ops,
		session !== undefined ? { session } : {}
	);
	const edits = operations.some((op) => op.set !== undefined);
	return {
		rowCount: res.upsertedCount + (edits ? res.matchedCount : 0),
		upsertedIds: Object.values(res.upsertedIds)
	};
}

/** `doc` où la colonne aliasée (`id`, ADR-036 E/1f) passe à `_id`. */
function withAliasKey<T extends object>(doc: T, column: string | undefined): T {
	if (column === undefined) return doc;
	const { [column]: key, ...rest } = doc as Record<string, unknown>;
	return (
		key !== undefined && rest._id === undefined ? { ...rest, _id: key } : doc
	) as T;
}

/**
 * `_id` des documents à la représentation de la clé aliasée : un `uuid` rangé
 * en texte (profil prisma, ADR-036 D6) l'est en minuscules, défaut compris.
 */
function keyAsStored<T extends object>(
	documents: readonly T[],
	alias: PkAlias | undefined,
	where: string
): T[] {
	const declared =
		alias?.storedAs === "string"
			? alias.type === "uuid"
				? UUID_TEXT_TYPE
				: alias.type === "decimal"
					? DECIMAL_TEXT_TYPE
					: undefined
			: alias?.storedAs;
	if (alias === undefined || declared === undefined) return [...documents];
	return documents.map((doc) => {
		const key = (doc as Record<string, unknown>)._id;
		return key === undefined
			? doc
			: ({
					...doc,
					_id: toDeclaredType(key, declared, alias.column, where)
				} as T);
	});
}

/**
 * Exécute une mutation (insertMany/updateMany/deleteMany).
 *
 * **Asymétrie assumée avec Postgres** : `RETURNING *` n'a pas d'équivalent
 * Mongo pour un write multi-documents. L'insert peut rendre les documents
 * (le driver renvoie les `_id` générés) ; update/delete ne rendent que des
 * compteurs → `rows` vide, `rowCount` renseigné. On ne simule pas RETURNING
 * par un fetch séparé : ce serait non atomique, donc mensonger.
 *
 * `matchedCount` (et non `modifiedCount`) pour l'update : Postgres compte les
 * lignes **touchées** même si la valeur écrite est identique à l'ancienne.
 *
 * Les valeurs sont hydratées en BSON ({@link hydrateBson}) : décimal exact,
 * int64, et ObjectId pour un filtre sur `_id`.
 */
/**
 * Dispatch write FK-aware (ADR-031). Si le write touche une FK déclarée
 * dans `_snql_refs` (voir {@link fkPlan}), il s'exécute dans une
 * transaction qui la fait respecter. Sans FK → fast path direct (pas
 * d'overhead transaction). `withTransaction` retry les erreurs
 * transientes ; sur mongod standalone, la tx lève TransactionNotSupported
 * (20) → message guidant (RS requis).
 */
export async function executeWrite(
	cx: MongoContext,
	queryIn: MongoWrite
): Promise<ResultSet> {
	// Défauts posés avant le contrôle FK : une colonne de FK peut en avoir un.
	const query = await prepareWrite(cx, queryIn);
	const plan = await fkPlan(cx, query);
	if (plan === undefined) return executeWritePlain(cx, query);
	const session = cx.client().startSession();
	try {
		let result: ResultSet = { columns: [], rows: [], rowCount: 0 };
		await session.withTransaction(async () => {
			result = await writeEnforcingFK(cx, query, plan, session);
		});
		return result;
	} catch (cause) {
		throw fkTransactionError(query.collection, cause);
	} finally {
		await session.endSession();
	}
}

/**
 * Write prêt à exécuter (ADR-029 D15) : défauts posés, valeurs converties
 * au type que le validateur déclare pour leur colonne, uuid d'un filtre
 * sous ses deux formes. Un insert-select convertit ses documents une fois
 * lus ({@link prepareCopied}).
 */
export async function prepareWrite(
	cx: MongoContext,
	query: MongoWrite,
	session?: ClientSession
): Promise<MongoWrite> {
	if (query.op === "delete") {
		const decimals = textDecimals(
			await loadDeclaredTypes(cx, query.collection)
		);
		return {
			...query,
			filter: withStoredForms(
				withTextDecimalFilter(query.filter, new Set(decimals))
			)
		};
	}
	if (query.op === "insert-select-agg-merge") {
		const decimals = await textDecimalsOf(cx, [
			query.sourceCollection,
			...lookupCollections(query.pipeline)
		]);
		return {
			...query,
			pipeline: pipelineWithStoredForms(
				withTextDecimalStages(
					query.pipeline,
					decimals.get(query.sourceCollection) ?? [],
					(c) => decimals.get(c) ?? []
				)
			)
		};
	}
	const types = await loadDeclaredTypes(cx, query.collection);
	const inserting = `insert dans '${query.collection}'`;
	const updating = `update de '${query.collection}'`;
	switch (query.op) {
		case "insert": {
			const documents = await prepareInsert(
				cx,
				query.collection,
				query.documents,
				session
			);
			return {
				...query,
				documents: documents.map((doc) =>
					toDeclaredTypes(doc, types, inserting)
				)
			};
		}
		case "update": {
			// Un calcul en forme pipeline lit le décimal en nombre, puis le range en texte.
			const decimals = textDecimals(types);
			const update = declaredUpdate(query.update, types, updating);
			return {
				...query,
				filter: withStoredForms(
					withTextDecimalFilter(query.filter, new Set(decimals))
				),
				update:
					Array.isArray(update) && decimals.length > 0
						? [
								...withTextDecimalStages([], decimals, () => []),
								...update,
								decimalsBackToText(decimals)
							]
						: update
			};
		}
		case "update-agg-merge": {
			const decimals = await textDecimalsOf(cx, [
				query.collection,
				...lookupCollections(query.pipeline)
			]);
			const own = decimals.get(query.collection) ?? [];
			const stages = withTextDecimalStages(
				declaredPipeline(
					pipelineWithStoredForms(query.pipeline),
					types,
					updating
				),
				own,
				(c) => decimals.get(c) ?? []
			);
			return {
				...query,
				pipeline:
					own.length > 0 ? beforeMerge(stages, decimalsBackToText(own)) : stages
			};
		}
		case "upsert": {
			// La branche insertion écrit le document d'un `add` : clé aliasée,
			// défauts, types déclarés. Le filtre reste une égalité : à
			// l'insertion, Mongo en copie les champs dans le document.
			const alias = (await loadPkAliases(cx.db())).get(
				query.collection
			)?.column;
			const inserts = await prepareInsert(
				cx,
				query.collection,
				query.operations.map((op) => op.setOnInsert),
				session
			);
			return {
				...query,
				operations: query.operations.map((op, i) => ({
					filter: toDeclaredTypes(
						withAliasKey(op.filter, alias),
						types,
						inserting
					),
					...(op.set !== undefined
						? { set: toDeclaredTypes(op.set, types, updating) }
						: {}),
					setOnInsert: toDeclaredTypes(
						inserts[i] ?? op.setOnInsert,
						types,
						inserting
					)
				}))
			};
		}
	}
}

async function executeWritePlain(
	cx: MongoContext,
	query: Extract<NativeQuery, { kind: "mongo-write" }>
): Promise<ResultSet> {
	const collection = cx.db().collection(query.collection);
	try {
		if (query.op === "insert") {
			// `filter: false` → fidélité BSON #7 : un `_id` fourni en chaîne 24-hex
			// est stocké TEL QUEL (string), pas coercé en ObjectId. Le filtre
			// both-forms (expandIdFilter) retrouve la valeur que `_id` soit string
			// OU ObjectId, donc plus besoin de deviner à l'insert.
			const documents = query.documents.map(
				(doc) => hydrateBson(doc, false) as Document
			);
			const result = await collection.insertMany(documents);
			// Les documents insérés portent maintenant leur `_id` (le driver le
			// pose sur l'objet) → on peut les rendre, comme un RETURNING *.
			const rows = renameRowKeys(
				documents.map((doc) => normalizeBson(doc) as Row),
				query.renameKeys
			);
			return {
				columns: columnsOf(rows),
				rows,
				rowCount: result.insertedCount
			};
		}
		if (query.op === "update") {
			const filter = hydrateBson(query.filter, true) as Document;
			// `filter: false` pour le document/pipeline de mise à jour (valeurs
			// écrites, pas un filtre → pas de coercion `_id`).
			const update = Array.isArray(query.update)
				? (hydrateBson([...query.update], false) as Document[])
				: (hydrateBson(query.update, false) as Document);
			const result = await collection.updateMany(filter, update);
			return { columns: [], rows: [], rowCount: result.matchedCount };
		}
		if (query.op === "update-agg-merge") {
			// Write-join via aggregate + $merge natif. Le $merge est un stage
			// terminal qui écrit comme side-effect ; le cursor result est
			// vide. rowCount = 0 (limitation documentée dans MongoWriteQuery
			// type — 2-pass count optionnel prévu).
			const pipeline = hydrateBson([...query.pipeline], false) as Document[];
			await collection.aggregate(pipeline).toArray();
			return { columns: [], rows: [], rowCount: 0 };
		}
		if (query.op === "insert-select-agg-merge") {
			// Insert-select via aggregate + $merge dans collection cible.
			// $merge NE PEUT PAS être utilisé DANS une session tx Mongo
			// (contrainte driver, toutes versions Mongo 4.2+) : hors
			// session OK, dans session refus au codegen
			// (executeWriteInSession). Le $merge whenMatched='fail' gère
			// les duplicate keys ; non-atomique sur batch mid-failure.
			// Une table SNQL déclare ses types : ses documents passent par
			// l'adapter, comme ceux d'un `add`.
			if ((await loadDeclaredTypes(cx, query.collection)).size > 0) {
				return await insertSelectInBatches(cx, query);
			}
			const sourceColl = cx.db().collection(query.sourceCollection);
			const pipeline = hydrateBson([...query.pipeline], false) as Document[];
			await sourceColl.aggregate(pipeline).toArray();
			return { columns: [], rows: [], rowCount: 0 };
		}
		if (query.op === "upsert") {
			// Hors transaction : chaque document est écrit atomiquement, pas le
			// lot. Sans les docs (l'user avait un upsert, pas un fetch).
			const { rowCount } = await runUpsert(collection, query.operations);
			return { columns: [], rows: [], rowCount };
		}
		const filter = hydrateBson(query.filter, true) as Document;
		const result = await collection.deleteMany(filter);
		return { columns: [], rows: [], rowCount: result.deletedCount };
	} catch (cause) {
		if (cause instanceof EngineExecutionError) throw cause;
		throw new EngineExecutionError(writeErrorMessage(query.op, cause), {
			cause
		});
	}
}

/**
 * Insert-select hors transaction vers une table qui déclare ses types :
 * documents lus par lots de 1 000 et préparés comme ceux d'un `add`.
 * Non atomique, comme le `$merge` qu'il remplace : un échec dit combien
 * de documents sont déjà insérés.
 */
async function insertSelectInBatches(
	cx: MongoContext,
	query: Extract<MongoWrite, { op: "insert-select-agg-merge" }>
): Promise<ResultSet> {
	const db = cx.db();
	const stages = hydrateBson(
		query.pipeline.filter((s) => !("$merge" in s)),
		false
	) as Document[];
	let inserted = 0;
	let batch: Document[] = [];
	const flush = async (): Promise<void> => {
		if (batch.length === 0) return;
		const docs = await prepareCopied(cx, query.collection, batch);
		batch = [];
		inserted += (await db.collection(query.collection).insertMany(docs))
			.insertedCount;
	};
	try {
		for await (const doc of db
			.collection(query.sourceCollection)
			.aggregate(stages)) {
			batch.push(doc);
			if (batch.length >= 1000) await flush();
		}
		await flush();
	} catch (cause) {
		const partial =
			inserted +
			((cause as { result?: { insertedCount?: number } }).result
				?.insertedCount ?? 0);
		if (partial === 0) throw cause;
		const detail =
			cause instanceof EngineExecutionError
				? cause.message
				: describeMongoExecutionError(cause);
		throw new EngineExecutionError(
			`Écriture MongoDB échouée après ${partial} document(s) inséré(s) (insert non atomique) — ${detail}`,
			{ cause }
		);
	}
	return { columns: [], rows: [], rowCount: inserted };
}

/**
 * Exécute `query` dans `session` en faisant respecter `plan` (ADR-031) :
 * valeurs des FK sortantes contrôlées (avant le write pour des littéraux,
 * après sinon), `on update` aux dépendants des clés réécrites, cascade
 * `on delete`. Sous savepoint, chaque effet pose sa compensation dans
 * `journal`.
 */
export async function writeEnforcingFK(
	cx: MongoContext,
	query: MongoWrite,
	plan: FkPlan,
	session: ClientSession,
	journal?: Journal
): Promise<ResultSet> {
	const coll = cx.db().collection(query.collection);
	switch (query.op) {
		case "delete":
			return deleteCascading(cx, query, session, journal);
		case "insert": {
			await assertRefsResolve(
				cx,
				query.collection,
				"insert",
				plan.outgoing,
				query.documents.map((d) => hydrateBson(d, false) as Document),
				undefined,
				session
			);
			return mainWrite(cx, query, session, journal);
		}
		case "insert-select-agg-merge": {
			const documents = await insertSelectDocs(cx, query, session);
			await assertRefsResolve(
				cx,
				query.collection,
				"insert",
				plan.outgoing,
				documents,
				undefined,
				session
			);
			if (documents.length === 0) return { columns: [], rows: [], rowCount: 0 };
			const res = await coll.insertMany(documents, { session });
			return { columns: [], rows: [], rowCount: res.insertedCount };
		}
		case "update": {
			const literal = Array.isArray(query.update)
				? undefined
				: extractSetFields(query.update);
			if (literal !== undefined) {
				await assertRefsResolve(
					cx,
					query.collection,
					"update",
					plan.outgoing,
					[hydrateBson(literal, false) as Document],
					undefined,
					session
				);
			}
			// Forme pipeline : les valeurs ne se lisent qu'après le write.
			const computed = literal === undefined ? plan.outgoing : [];
			if (computed.length === 0 && plan.keyColumns.length === 0) {
				return mainWrite(cx, query, session, journal);
			}
			const before = await readColumns(
				coll,
				hydrateBson(query.filter, true) as Document,
				snapshotColumns(plan, computed),
				session
			);
			const result = await mainWrite(cx, query, session, journal);
			await checkRewrite(
				cx,
				query.collection,
				"update",
				plan,
				computed,
				before,
				[],
				session,
				journal
			);
			return result;
		}
		case "update-agg-merge": {
			const merge = await prepareMergeUpdate(cx, query, session);
			const before = await readColumns(
				coll,
				{ _id: { $in: merge.ids } },
				snapshotColumns(plan, plan.outgoing),
				session
			);
			const result = await merge.write();
			await checkRewrite(
				cx,
				query.collection,
				"update",
				plan,
				plan.outgoing,
				before,
				[],
				session,
				journal
			);
			return result;
		}
		case "upsert": {
			const before = await readColumns(
				coll,
				{
					$or: query.operations.map(
						(op) => hydrateBson(op.filter, true) as Document
					)
				},
				snapshotColumns(plan, plan.outgoing),
				session
			);
			const res = await runUpsert(coll, query.operations, session);
			await checkRewrite(
				cx,
				query.collection,
				"insert",
				plan,
				plan.outgoing,
				before,
				res.upsertedIds,
				session,
				journal
			);
			return { columns: [], rows: [], rowCount: res.rowCount };
		}
	}
}

/** Write principal ; sous savepoint, sa compensation entre dans `journal`. */
async function mainWrite(
	cx: MongoContext,
	query: MongoWrite,
	session: ClientSession,
	journal?: Journal
): Promise<ResultSet> {
	if (journal === undefined) return executeWriteInSession(cx, query, session);
	const { result, compensate } = await execWriteWithCompensation(
		cx,
		query,
		session
	);
	journal.push(compensate);
	return result;
}

/**
 * Write-join (`update … with`) matérialisé dans la session : `$merge` est
 * interdit en transaction. Le pipeline sans son `$merge` calcule les
 * documents, puis un `updateOne` par `_id` pose les champs affectés, comme
 * le `whenMatched: "merge"` de `$merge`. Les `_id` sont connus avant le write.
 */
async function prepareMergeUpdate(
	cx: MongoContext,
	query: Extract<MongoWrite, { op: "update-agg-merge" }>,
	session: ClientSession
): Promise<{ ids: unknown[]; write: () => Promise<ResultSet> }> {
	const coll = cx.db().collection(query.collection);
	const stages = hydrateBson(
		query.pipeline.filter((s) => !("$merge" in s)),
		false
	) as Document[];
	const docs = await coll.aggregate(stages, { session }).toArray();
	const fields = [
		...new Set(
			pipelineSetColumns(query.pipeline).map((c) => c.split(".")[0] ?? c)
		)
	];
	const ops = docs.flatMap((doc) => {
		const set: Document = {};
		for (const f of fields) if (f in doc) set[f] = doc[f];
		return Object.keys(set).length > 0
			? [{ updateOne: { filter: { _id: doc._id }, update: { $set: set } } }]
			: [];
	});
	const rowCount = new Set(docs.map((d) => bsonMatchKey(d._id))).size;
	return {
		ids: docs.map((d) => d._id),
		write: async () => {
			if (ops.length > 0) await coll.bulkWrite(ops, { session });
			return { columns: [], rows: [], rowCount };
		}
	};
}

/**
 * Documents d'un insert-select matérialisés dans la session (`$merge`
 * interdit en transaction) : le pipeline source sans son `$merge`.
 */
async function insertSelectDocs(
	cx: MongoContext,
	query: Extract<MongoWrite, { op: "insert-select-agg-merge" }>,
	session: ClientSession
): Promise<Document[]> {
	const stages = hydrateBson(
		query.pipeline.filter((s) => !("$merge" in s)),
		false
	) as Document[];
	const docs = await cx
		.db()
		.collection(query.sourceCollection)
		.aggregate(stages, { session })
		.toArray();
	return prepareCopied(cx, query.collection, docs, session);
}

/**
 * Documents copiés par un insert-select, préparés comme ceux d'un `add` :
 * défauts, clé aliasée, types déclarés. Ils sortent de la base déjà en
 * BSON, sans hydratation — en mode filtre, elle réécrirait un `_id`
 * chaîne 24-hex en `$in`.
 */
async function prepareCopied(
	cx: MongoContext,
	collection: string,
	docs: readonly Document[],
	session?: ClientSession
): Promise<Document[]> {
	const types = await loadDeclaredTypes(cx, collection);
	const where = `insert dans '${collection}'`;
	return (await prepareInsert(cx, collection, docs, session)).map((doc) =>
		toDeclaredTypes(doc, types, where)
	);
}

/**
 * Documents prêts à insérer : défauts posés, puis clé primaire aliasée
 * vérifiée (ADR-036 E/1f). Sans valeur ni défaut, Mongo poserait un
 * ObjectId à la place de l'`id` déclaré : refus, comme le NOT NULL d'une
 * clé primaire Postgres.
 */
async function prepareInsert<T extends object>(
	cx: MongoContext,
	collection: string,
	documents: readonly T[],
	session?: ClientSession
): Promise<T[]> {
	const alias = (await loadPkAliases(cx.db())).get(collection);
	// Sans schéma, le lower n'a pas réécrit l'alias : la valeur passe à `_id`.
	const keyed = documents.map((doc) => withAliasKey(doc, alias?.column));
	const prepared = keyAsStored(
		await withDefaults(cx, collection, keyed, session),
		alias,
		`insert dans '${collection}'`
	);
	if (
		alias !== undefined &&
		prepared.some((doc) => (doc as Record<string, unknown>)._id === undefined)
	) {
		const withDefault =
			alias.type === "uuid" || alias.type === "string"
				? ` ou donne-lui un défaut : alter column ${collection}.${alias.column} set default uuid()`
				: "";
		throw new EngineExecutionError(
			`insert dans '${collection}' : '${alias.column}' manque — c'est la clé primaire (alias de '_id') ; fournis-la${withDefault}`
		);
	}
	return prepared;
}

/**
 * Variante scopée session de executeWrite. Duplique volontairement la
 * logique de dispatch (insert/update/delete) pour passer `{ session }` au
 * driver — impossible à factoriser proprement sans complexifier la
 * signature publique. L'atomicité de la transaction rend
 * `writeErrorMessage` moins pertinent (partial insert impossible dans une
 * tx qui rollback), mais on garde le format pour homogénéité.
 */
export async function executeWriteInSession(
	cx: MongoContext,
	query: Extract<NativeQuery, { kind: "mongo-write" }>,
	session: ClientSession
): Promise<ResultSet> {
	const collection = cx.db().collection(query.collection);
	try {
		if (query.op === "insert") {
			const documents = query.documents.map(
				(doc) => hydrateBson(doc, false) as Document
			);
			const result = await collection.insertMany(documents, { session });
			const rows = renameRowKeys(
				documents.map((doc) => normalizeBson(doc) as Row),
				query.renameKeys
			);
			return {
				columns: columnsOf(rows),
				rows,
				rowCount: result.insertedCount
			};
		}
		if (query.op === "update") {
			const filter = hydrateBson(query.filter, true) as Document;
			const update = Array.isArray(query.update)
				? (hydrateBson([...query.update], false) as Document[])
				: (hydrateBson(query.update, false) as Document);
			const result = await collection.updateMany(filter, update, { session });
			return { columns: [], rows: [], rowCount: result.matchedCount };
		}
		if (query.op === "update-agg-merge") {
			return (await prepareMergeUpdate(cx, query, session)).write();
		}
		if (query.op === "insert-select-agg-merge") {
			// Insert-select DANS session tx via matérialisation client +
			// insertMany (le $merge natif est interdit en session tx). Le
			// pipeline est split : (a) source-fetch = toutes les stages avant
			// $merge (retourne des docs), (b) $merge terminal droppé.
			// insertMany écrit atomiquement dans la même session tx. Whole-tx
			// rollback protège en cas d'erreur. Non-atomique par-doc sur
			// duplicate key (insertMany ordonné throw à la première collision)
			// — même sémantique que $merge whenMatched='fail' hors tx.
			const docsToInsert = await insertSelectDocs(cx, query, session);
			if (docsToInsert.length === 0) {
				return { columns: [], rows: [], rowCount: 0 };
			}
			const targetColl = cx.db().collection(query.collection);
			const result = await targetColl.insertMany(docsToInsert, {
				session
			});
			return {
				columns: [],
				rows: [],
				rowCount: result.insertedCount
			};
		}
		if (query.op === "upsert") {
			const { rowCount } = await runUpsert(
				collection,
				query.operations,
				session
			);
			return { columns: [], rows: [], rowCount };
		}
		const filter = hydrateBson(query.filter, true) as Document;
		const result = await collection.deleteMany(filter, { session });
		return { columns: [], rows: [], rowCount: result.deletedCount };
	} catch (cause) {
		if (cause instanceof EngineExecutionError) throw cause;
		throw new EngineExecutionError(writeErrorMessage(query.op, cause), {
			cause
		});
	}
}

/**
 * Exécute un write dans une session tx ET retourne la compensation inverse
 * à appliquer si le savepoint doit rollback. Snapshot pre-write capturé
 * côté RAM avant l'exec (find via session, cohérence intra-tx).
 */
export async function execWriteWithCompensation(
	cx: MongoContext,
	query: import("@sqlnest/snql").MongoWriteQuery,
	session: ClientSession
): Promise<{ result: ResultSet; compensate: () => Promise<void> }> {
	const collection = cx.db().collection(query.collection);
	if (query.op === "insert") {
		const documents = query.documents.map(
			(doc) => hydrateBson(doc, false) as Document
		);
		const insertResult = await collection.insertMany(documents, {
			session
		});
		const insertedIds = Object.values(insertResult.insertedIds);
		const rows = renameRowKeys(
			documents.map((doc) => normalizeBson(doc) as Row),
			query.renameKeys
		);
		return {
			result: {
				columns: columnsOf(rows),
				rows,
				rowCount: insertResult.insertedCount
			},
			compensate: async () => {
				if (insertedIds.length === 0) return;
				await collection.deleteMany({ _id: { $in: insertedIds } }, { session });
			}
		};
	}
	if (query.op === "update") {
		const filter = hydrateBson(query.filter, true) as Document;
		const fields = extractUpdateFields(query.update);
		const projection: Document = { _id: 1 };
		for (const f of fields) projection[f] = 1;
		const snapshot = (await collection
			.find(filter, { session, projection })
			.toArray()) as Document[];
		const update = Array.isArray(query.update)
			? (hydrateBson([...query.update], false) as Document[])
			: (hydrateBson(query.update, false) as Document);
		const upResult = await collection.updateMany(filter, update, { session });
		return {
			result: { columns: [], rows: [], rowCount: upResult.matchedCount },
			compensate: async () => {
				for (const row of snapshot) {
					const oldSet: Document = {};
					const oldUnset: Document = {};
					for (const f of fields) {
						if (row[f] === undefined) oldUnset[f] = "";
						else oldSet[f] = row[f];
					}
					const restoreUpdate: Document = {};
					if (Object.keys(oldSet).length > 0) restoreUpdate["$set"] = oldSet;
					if (Object.keys(oldUnset).length > 0)
						restoreUpdate["$unset"] = oldUnset;
					if (Object.keys(restoreUpdate).length === 0) continue;
					await collection.updateOne(
						{ _id: row["_id"] } as Document,
						restoreUpdate,
						{ session }
					);
				}
			}
		};
	}
	if (query.op === "delete") {
		const filter = hydrateBson(query.filter, true) as Document;
		const snapshot = (await collection
			.find(filter, { session })
			.toArray()) as Document[];
		const delResult = await collection.deleteMany(filter, { session });
		return {
			result: { columns: [], rows: [], rowCount: delResult.deletedCount },
			compensate: async () => {
				if (snapshot.length === 0) return;
				await collection.insertMany(snapshot, { session });
			}
		};
	}
	// Les autres ops (update-agg-merge, insert-select-agg-merge, upsert) sont
	// refusés au planner pour un body savepoint (voir assertSavepointBody
	// Analyzable). Defense-in-depth ici pour éviter une exec silencieuse
	// sans compensation.
	throw new EngineExecutionError(
		`Savepoint : op '${query.op}' non supporté v1 MVP (planner devrait avoir refusé)`
	);
}

/**
 * Extrait les noms de fields écrits par un update Mongo (forme classique
 * `{$set: {...}}` ou pipeline `[{$set: {...}}]`). Utilisé pour builder la
 * projection du snapshot pre-write (retenir les old values seulement pour les
 * champs qui vont être modifiés).
 */
function extractUpdateFields(update: unknown): string[] {
	const stages = Array.isArray(update) ? update : [update];
	const fields = new Set<string>();
	for (const stage of stages) {
		const s = stage as { $set?: Record<string, unknown> };
		if (s.$set !== undefined) {
			for (const k of Object.keys(s.$set)) fields.add(k);
		}
	}
	return [...fields];
}
