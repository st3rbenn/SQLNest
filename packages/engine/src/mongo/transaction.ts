import type { NativeQuery, ResultSet, Row } from "@sqlnest/snql";
import type { ClientSession } from "mongodb";
import { EngineExecutionError } from "../errors";
import { normalizeBson } from "./bson";
import type { MongoContext } from "./context";
import {
	describeMongoExecutionError,
	isExpectedAbortError
} from "./execution-errors";
import { fkPlan, type Journal } from "./fk";
import { columnsOf, readPipeline, renameRowKeys } from "./read";
import {
	executeWriteInSession,
	execWriteWithCompensation,
	prepareWrite,
	writeEnforcingFK
} from "./write";

/**
 * Transactions et savepoints.
 */

/**
 * Bloc `transaction { … }` sur Mongo (requiert un replica set côté
 * serveur). Une session unique porte startTransaction → commit ou
 * abort. Chaque step reçoit `{ session }` — sans ça, le driver exécute
 * la commande hors transaction et le rollback ne réagira pas dessus.
 *
 * Renvoie le dernier ResultSet du body (parité PG). Un body vide renvoie
 * un ResultSet vide — pas d'appel Mongo. Sur erreur du body : abort
 * best-effort puis re-throw ; l'erreur d'origine prime toujours sur une
 * éventuelle erreur d'abort.
 *
 * Mongo lève `TransactionNotSupported` (code 20) sur un mongod standalone —
 * on laisse remonter, avec le hint que le serveur doit être en RS.
 */
export async function executeTransaction(
	cx: MongoContext,
	query: Extract<NativeQuery, { kind: "mongo-transaction" }>
): Promise<ResultSet> {
	const client = cx.client();
	const db = cx.db();
	const session = client.startSession();
	let lastResult: ResultSet = { columns: [], rows: [], rowCount: 0 };
	const txOptions = mongoTransactionOptions(query.isolation);
	try {
		session.startTransaction(txOptions);
		for (const step of query.steps) {
			if (step.kind === "query") {
				const pipeline = await readPipeline(
					cx,
					step.query.collection,
					step.query.pipeline
				);
				const docs = await db
					.collection(step.query.collection)
					.aggregate(pipeline, { session })
					.toArray();
				const rows = renameRowKeys(
					docs.map((doc) => normalizeBson(doc) as Row),
					step.query.renameKeys
				);
				lastResult = {
					columns: columnsOf(rows),
					rows,
					rowCount: rows.length
				};
			} else if (step.kind === "write") {
				const write = await prepareWrite(cx, step.write, session);
				const plan = await fkPlan(cx, write);
				lastResult =
					plan === undefined
						? await executeWriteInSession(cx, write, session)
						: await writeEnforcingFK(cx, write, plan, session);
			} else {
				// Savepoint via compensation logique in-session.
				lastResult = await executeSavepoint(cx, step, session);
			}
		}
		await session.commitTransaction();
		return lastResult;
	} catch (cause) {
		try {
			await session.abortTransaction();
		} catch (abortErr) {
			// abortTransaction() erreurs enrichies. On avale les codes attendus
			// (tx déjà avortée par le serveur : WriteConflict, TransactionNotFound,
			// NoSuchTransaction, TransientTransactionError). Pour tout autre
			// code (network, timeout) : log + enrichit l'erreur finale avec
			// {abort_error} — tx orpheline invisible côté serveur est le pire
			// failure mode (verrous conservés jusqu'à
			// transactionLifetimeLimitSeconds).
			const expected = isExpectedAbortError(abortErr);
			if (!expected) {
				throw new EngineExecutionError(
					`Transaction MongoDB échouée AND abort de nettoyage échoué — ${describeMongoExecutionError(cause)} — abort_error: ${describeMongoExecutionError(abortErr)}`,
					{ cause }
				);
			}
		}
		throw new EngineExecutionError(
			`Transaction MongoDB échouée — ${describeMongoExecutionError(cause)}`,
			{ cause }
		);
	} finally {
		await session.endSession();
	}
}

/**
 * Savepoint Mongo via compensation logique in-session. Pour chaque write
 * du body : capture snapshot pre-write (find touched via session), exec le
 * write, retient la compensation. Sur erreur dans un write du body : apply
 * toutes les compensations retenues en REVERSE order dans la MÊME session
 * tx, puis absorbe l'erreur (savepoint rollback partiel). La whole-tx
 * continue au step suivant, sémantique parité PG.
 *
 * Sur erreur transient (WriteConflict, TransactionAborted, NoSuchTransaction),
 * la session est déjà marquée aborted par le driver ; les compensations
 * échoueraient — on rethrow pour laisser executeTransaction abort proprement.
 *
 * Compensations par op :
 *  - insert → deleteMany({_id: {$in: insertedIds}})
 *  - update → pour chaque snapshot row : updateOne({_id}, {$set: old_values})
 *  - delete → insertMany(snapshot_full_docs)
 *
 * Retourne le dernier ResultSet du body (parité executeTransaction).
 */
async function executeSavepoint(
	cx: MongoContext,
	step: Extract<
		import("@sqlnest/snql").MongoTransactionStep,
		{ kind: "savepoint" }
	>,
	session: ClientSession
): Promise<ResultSet> {
	const db = cx.db();
	const compensations: (() => Promise<void>)[] = [];
	let lastResult: ResultSet = { columns: [], rows: [], rowCount: 0 };
	try {
		for (const bodyStep of step.body) {
			if (bodyStep.kind === "query") {
				const pipeline = await readPipeline(
					cx,
					bodyStep.query.collection,
					bodyStep.query.pipeline
				);
				const docs = await db
					.collection(bodyStep.query.collection)
					.aggregate(pipeline, { session })
					.toArray();
				const rows = renameRowKeys(
					docs.map((doc) => normalizeBson(doc) as Row),
					bodyStep.query.renameKeys
				);
				lastResult = {
					columns: columnsOf(rows),
					rows,
					rowCount: rows.length
				};
			} else if (bodyStep.kind === "write") {
				const write = await prepareWrite(cx, bodyStep.write, session);
				const plan =
					write.op === "insert" ||
					write.op === "update" ||
					write.op === "delete"
						? await fkPlan(cx, write)
						: undefined;
				if (plan === undefined) {
					const outcome = await execWriteWithCompensation(cx, write, session);
					lastResult = outcome.result;
					compensations.push(outcome.compensate);
				} else {
					// Journal posé avant le write : un refus FK après coup compense
					// aussi ce que le write et ses cascades ont déjà écrit.
					const journal: Journal = [];
					compensations.push(async () => {
						for (let i = journal.length - 1; i >= 0; i -= 1) {
							await journal[i]?.();
						}
					});
					lastResult = await writeEnforcingFK(
						cx,
						write,
						plan,
						session,
						journal
					);
				}
			}
		}
		return lastResult;
	} catch (bodyErr) {
		if (isExpectedAbortError(bodyErr)) {
			throw bodyErr;
		}
		for (let i = compensations.length - 1; i >= 0; i -= 1) {
			const comp = compensations[i];
			if (comp === undefined) continue;
			try {
				await comp();
			} catch (compErr) {
				throw new EngineExecutionError(
					`Savepoint '${step.name}' rollback partiel a échoué (compensation) — ${describeMongoExecutionError(compErr)} — cause d'origine : ${describeMongoExecutionError(bodyErr)}`,
					{ cause: bodyErr }
				);
			}
		}
		return { columns: [], rows: [], rowCount: 0 };
	}
}

/**
 * Mapping IsolationLevel SNQL → options de transaction Mongo (`readConcern` +
 * `writeConcern`). Absence d'isolation → défauts Mongo (snapshot read + local
 * write) — l'user n'a rien demandé, on ne surspécifie pas. IsolationLevel SNQL
 * a 3 valeurs (parser-enum fermé) : pas de default case, la switch est
 * exhaustive.
 */
function mongoTransactionOptions(
	iso: import("@sqlnest/snql").IsolationLevel | undefined
): {
	readConcern?: { level: "snapshot" | "majority" };
	writeConcern?: { w: "majority" };
} {
	if (iso === undefined) return {};
	if (iso === "serializable" || iso === "repeatable_read") {
		return {
			readConcern: { level: "snapshot" },
			writeConcern: { w: "majority" }
		};
	}
	return {
		readConcern: { level: "majority" },
		writeConcern: { w: "majority" }
	};
}
