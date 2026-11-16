import type { ResultSet } from "@sqlnest/snql";
import type { ClientSession, Collection, Document } from "mongodb";
import { EngineExecutionError } from "../errors";
import {
	bsonMatchKey,
	hydrateBson,
	idBothForms,
	normalizeBson,
	UUID_TEXT
} from "./bson";
import type { MongoContext, MongoWrite } from "./context";
import { toDeclaredType } from "./declared-types";
import { loadPkAliases } from "./introspect";
import { loadDeclaredTypes } from "./read";

/**
 * Clés étrangères émulées (ADR-031) : MongoDB n'en a pas, l'adaptateur les
 * fait respecter à l'écriture (existence, `on delete`, `on update`).
 */

/**
 * FK chargée depuis `_snql_refs` pour l'enforcement runtime (ADR-031 FK/1b).
 * `fromColumn` / `toColumn` sont les champs stockés (`_id` pour un alias `id`,
 * ADR-036 E/1f) ; `fromName` / `toName`, les noms SNQL des messages.
 */
interface RefMeta {
	readonly name: string;
	readonly fromCollection: string;
	readonly fromColumn: string;
	readonly fromName: string;
	readonly toCollection: string;
	readonly toColumn: string;
	readonly toName: string;
	readonly onDelete: string;
	readonly onUpdate: string;
}

interface RefColumns {
	readonly fromCollection: string;
	readonly fromColumn: string;
	readonly toCollection: string;
	readonly toColumn: string;
}

/** Champs stockés d'une FK : l'alias `id` d'une collection est `_id`. */
export function physicalRef<T extends RefColumns>(
	ref: T,
	aliases: ReadonlyMap<string, { readonly column: string }>
): T {
	const stored = (collection: string, column: string) =>
		aliases.get(collection)?.column === column ? "_id" : column;
	return {
		...ref,
		fromColumn: stored(ref.fromCollection, ref.fromColumn),
		toColumn: stored(ref.toCollection, ref.toColumn)
	};
}

/** Formes équivalentes d'une clé : ObjectId ↔ hex, UUID ↔ texte. */
function keyForms(value: unknown): unknown[] {
	if (typeof value === "string") return idBothForms(value) ?? [value];
	const text = normalizeBson(value);
	return typeof text === "string" && text !== value ? [value, text] : [value];
}

/** Clé de comparaison d'une valeur `_id`, quelle que soit sa forme stockée. */
function idMatchKey(value: unknown): string {
	const text = normalizeBson(value);
	return typeof text === "string"
		? `s:${UUID_TEXT.test(text) ? text.toLowerCase() : text}`
		: bsonMatchKey(value);
}

/** Clé référencée qui change de valeur sous un update (ADR-031 `on update`). */
interface KeyMove {
	readonly from: unknown;
	readonly to: unknown;
}

/** Compensations d'un write sous savepoint, rejouées à l'envers. */
export type Journal = (() => Promise<void>)[];

/**
 * Ce qu'un write doit faire respecter (ADR-031) : FK sortantes dont il peut
 * écrire la colonne, colonnes référencées qu'il peut réécrire (`on update`).
 * Un delete y figure dès que la collection est référencée (cascade).
 */
export interface FkPlan {
	readonly outgoing: readonly RefMeta[];
	readonly keyColumns: readonly string[];
}

/**
 * Colonnes qu'un pipeline d'update écrit : clés des stages `$set` /
 * `$addFields`, moins les champs retirés ensuite par `$unset` (alias de
 * jointure, slots synthétiques).
 */
export function pipelineSetColumns(pipeline: readonly Document[]): string[] {
	const cols = new Set<string>();
	for (const stage of pipeline) {
		for (const op of ["$set", "$addFields"]) {
			const fields = (stage as Record<string, unknown>)[op];
			if (fields !== null && typeof fields === "object") {
				for (const k of Object.keys(fields)) cols.add(k);
			}
		}
		const unset = (stage as { $unset?: unknown }).$unset;
		const removed =
			typeof unset === "string" ? [unset] : Array.isArray(unset) ? unset : [];
		for (const k of removed) cols.delete(String(k));
	}
	return [...cols];
}

/**
 * Colonnes qu'un write peut écrire (`written`, FK sortantes) et réécrire sur
 * des documents existants (`rewritten`, `on update`). Un upsert qui insère
 * écrit aussi les champs d'égalité de son filtre.
 */
function writeColumns(query: MongoWrite): {
	written: string[];
	rewritten: string[];
} {
	switch (query.op) {
		case "update": {
			const cols = Object.keys(extractSetFields(query.update));
			return { written: cols, rewritten: cols };
		}
		case "update-agg-merge": {
			const cols = pipelineSetColumns(query.pipeline);
			return { written: cols, rewritten: cols };
		}
		case "upsert": {
			const written = new Set<string>();
			const rewritten = new Set<string>();
			for (const op of query.operations) {
				for (const k of Object.keys(op.filter)) written.add(k);
				for (const k of Object.keys(op.setOnInsert)) written.add(k);
				for (const k of Object.keys(op.set ?? {})) {
					written.add(k);
					rewritten.add(k);
				}
			}
			return { written: [...written], rewritten: [...rewritten] };
		}
		default:
			return { written: [], rewritten: [] };
	}
}

/** Colonnes à photographier autour d'un write : clés référencées et FK `refs`. */
export function snapshotColumns(
	plan: FkPlan,
	refs: readonly RefMeta[]
): string[] {
	return [...new Set([...plan.keyColumns, ...refs.map((r) => r.fromColumn)])];
}

/** `_id` et `columns` des documents de `filter`, lus dans la session. */
export function readColumns(
	coll: Collection,
	filter: Document,
	columns: readonly string[],
	session: ClientSession
): Promise<Document[]> {
	const projection: Document = { _id: 1 };
	for (const c of columns) projection[c] = 1;
	return coll.find(filter, { session, projection }).toArray();
}

/**
 * `updateMany` qui pose `column = value` ; sous savepoint, la valeur d'avant
 * de chaque document entre dans `journal`.
 */
async function setField(
	coll: Collection,
	filter: Document,
	column: string,
	value: unknown,
	session: ClientSession,
	journal?: Journal
): Promise<void> {
	if (journal !== undefined) {
		const prior = await readColumns(coll, filter, [column], session);
		journal.push(async () => {
			if (prior.length === 0) return;
			await coll.bulkWrite(
				prior.map((doc) => ({
					updateOne: {
						filter: { _id: doc._id },
						update:
							doc[column] === undefined
								? { $unset: { [column]: "" } }
								: { $set: { [column]: doc[column] } }
					}
				})),
				{ session }
			);
		});
	}
	await coll.updateMany(filter, { $set: { [column]: value } }, { session });
}

/**
 * Extrait les champs settés par un update pour le write-precheck FK. Gère le
 * `$set` classique (`{$set: {...}}`) ET la forme pipeline (`[{$set: {...}}]`).
 * Un champ setté à une expression non-littérale (`"$autre"`) est ignoré du
 * precheck (on ne peut pas connaître sa valeur statiquement — best-effort).
 */
export function extractSetFields(
	update: Document | readonly Document[]
): Record<string, unknown> {
	const stages = Array.isArray(update) ? update : [update];
	const out: Record<string, unknown> = {};
	for (const stage of stages) {
		const set = (stage as { $set?: unknown }).$set;
		if (set !== null && typeof set === "object") {
			for (const [k, v] of Object.entries(set as Record<string, unknown>)) {
				out[k] = v;
			}
		}
	}
	return out;
}

/** Valeurs distinctes non-null/undefined (clés référencées pour la cascade). */
export function uniqueDefined(values: readonly unknown[]): unknown[] {
	const seen = new Set<string>();
	const out: unknown[] = [];
	for (const v of values) {
		if (v === null || v === undefined) continue;
		const key =
			typeof v === "object" ? JSON.stringify(v) : `${typeof v}:${String(v)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(v);
	}
	return out;
}

/**
 * Charge les FK depuis `_snql_refs` (ADR-031 FK/1b) filtrées par un champ
 * (`fromCollection` pour les FK sortantes = write-precheck, `toCollection`
 * pour les entrantes = cascade). Best-effort : `_snql_refs` absent → [].
 */
export async function loadRefs(
	cx: MongoContext,
	field: "fromCollection" | "toCollection",
	collection: string
): Promise<readonly RefMeta[]> {
	try {
		const docs = await cx
			.db()
			.collection("_snql_refs")
			.find({ [field]: collection })
			.toArray();
		const aliases = await loadPkAliases(cx.db());
		const out: RefMeta[] = [];
		for (const d of docs) {
			const r = d as Record<string, unknown>;
			if (
				typeof r._id === "string" &&
				typeof r.fromCollection === "string" &&
				typeof r.fromColumn === "string" &&
				typeof r.toCollection === "string" &&
				typeof r.toColumn === "string"
			) {
				out.push(
					physicalRef(
						{
							name: r._id,
							fromCollection: r.fromCollection,
							fromColumn: r.fromColumn,
							fromName: r.fromColumn,
							toCollection: r.toCollection,
							toColumn: r.toColumn,
							toName: r.toColumn,
							onDelete:
								typeof r.onDelete === "string" ? r.onDelete : "restrict",
							onUpdate: typeof r.onUpdate === "string" ? r.onUpdate : "restrict"
						},
						aliases
					)
				);
			}
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * FK qu'un write doit faire respecter, lues dans `_snql_refs`. `undefined`
 * si aucune : le write passe sans transaction. Insert et insert-select
 * contrôlent toutes leurs FK sortantes (un défaut peut remplir la colonne),
 * les updates celles dont ils écrivent la colonne. `_id` est immuable : une
 * FK vers `_id` n'a pas d'`on update`.
 */
export async function fkPlan(
	cx: MongoContext,
	query: MongoWrite
): Promise<FkPlan | undefined> {
	if (query.op === "delete") {
		const incoming = await loadRefs(cx, "toCollection", query.collection);
		return incoming.length > 0 ? { outgoing: [], keyColumns: [] } : undefined;
	}
	const inserting =
		query.op === "insert" || query.op === "insert-select-agg-merge";
	const { written, rewritten } = writeColumns(query);
	const touches = (cols: readonly string[], col: string) =>
		cols.some((c) => c === col || c.startsWith(`${col}.`));
	const outgoing = (
		await loadRefs(cx, "fromCollection", query.collection)
	).filter((r) => inserting || touches(written, r.fromColumn));
	const keyColumns =
		rewritten.length === 0
			? []
			: [
					...new Set(
						(await loadRefs(cx, "toCollection", query.collection))
							.filter(
								(r) => r.toColumn !== "_id" && touches(rewritten, r.toColumn)
							)
							.map((r) => r.toColumn)
					)
				];
	return outgoing.length > 0 || keyColumns.length > 0
		? { outgoing, keyColumns }
		: undefined;
}

/**
 * Contrôles après un write qui a pu réécrire des colonnes : relit par `_id`
 * les documents touchés (`before`, plus les `inserted`), vérifie les
 * nouvelles valeurs des FK sortantes `refs`, puis applique `on update` aux
 * clés référencées qui ont changé.
 */
export async function checkRewrite(
	cx: MongoContext,
	collection: string,
	op: "insert" | "update",
	plan: FkPlan,
	refs: readonly RefMeta[],
	before: readonly Document[],
	inserted: readonly unknown[],
	session: ClientSession,
	journal?: Journal
): Promise<void> {
	const ids = [...before.map((d) => d._id), ...inserted];
	if (ids.length === 0) return;
	const after = await readColumns(
		cx.db().collection(collection),
		{ _id: { $in: ids } },
		snapshotColumns(plan, refs),
		session
	);
	const prior = new Map(before.map((d) => [bsonMatchKey(d._id), d]));
	await assertRefsResolve(cx, collection, op, refs, after, prior, session);
	const changes = new Map<string, KeyMove[]>();
	for (const column of plan.keyColumns) {
		const moves: KeyMove[] = [];
		for (const doc of after) {
			const from = prior.get(bsonMatchKey(doc._id))?.[column];
			if (from === null || from === undefined) continue;
			const to = doc[column] ?? null;
			if (bsonMatchKey(from) !== bsonMatchKey(to)) moves.push({ from, to });
		}
		if (moves.length > 0) changes.set(column, moves);
	}
	await applyOnUpdate(cx, collection, changes, session, journal);
}

/**
 * Refus typé si une valeur de FK sortante écrite dans `docs` ne référence
 * aucune ligne (ADR-031 FK/1b). NULL passe (FK nullable). Avec `prior`
 * (documents avant le write, par `_id`), seules les valeurs nouvelles ou
 * changées sont contrôlées.
 */
export async function assertRefsResolve(
	cx: MongoContext,
	collection: string,
	op: "insert" | "update",
	refs: readonly RefMeta[],
	docs: readonly Document[],
	prior: ReadonlyMap<string, Document> | undefined,
	session: ClientSession
): Promise<void> {
	for (const ref of refs) {
		const values = new Map<string, unknown>();
		for (const doc of docs) {
			const value = doc[ref.fromColumn];
			if (value === null || value === undefined) continue;
			const old = prior?.get(bsonMatchKey(doc._id))?.[ref.fromColumn];
			if (old !== undefined && bsonMatchKey(old) === bsonMatchKey(value)) {
				continue;
			}
			values.set(bsonMatchKey(value), value);
		}
		const distinct = [...values.values()];
		for (let i = 0; i < distinct.length; i += 1000) {
			const [missing] = await missingRefTargets(
				cx,
				ref,
				distinct.slice(i, i + 1000),
				session
			);
			if (missing !== undefined) {
				throw new EngineExecutionError(
					`${op === "insert" ? "insert dans" : "update de"} '${collection}' viole la foreign key '${ref.name}' : '${ref.fromName}' = ${JSON.stringify(normalizeBson(missing))} ne référence aucune ligne de ${ref.toCollection}.${ref.toName}`
				);
			}
		}
	}
}

/**
 * Valeurs d'un paquet (BSON) qu'aucune ligne de la cible ne porte : un
 * `$in` sur `toColumn` (champ stocké), et sur `_id` pour un champ `id`
 * d'une collection créée avant l'alias (D13).
 */
export async function missingRefTargets(
	cx: MongoContext,
	ref: { readonly toCollection: string; readonly toColumn: string },
	values: readonly unknown[],
	session?: ClientSession
): Promise<unknown[]> {
	// Clé `_id` : la valeur peut être stockée sous une autre forme
	// (ObjectId / UUID d'un défaut, texte saisi).
	if (ref.toColumn === "_id") {
		const found = await cx
			.db()
			.collection(ref.toCollection)
			.find(
				{ _id: { $in: values.flatMap(keyForms) } } as Document,
				session !== undefined
					? { session, projection: { _id: 1 } }
					: { projection: { _id: 1 } }
			)
			.toArray();
		const keys = new Set(found.map((doc) => idMatchKey(doc._id)));
		return values.filter((v) => !keys.has(idMatchKey(v)));
	}
	const or: Document[] = [{ [ref.toColumn]: { $in: [...values] } }];
	if (ref.toColumn === "id") or.push({ _id: { $in: [...values] } });
	const projection = { _id: 1, [ref.toColumn]: 1 };
	const found = await cx
		.db()
		.collection(ref.toCollection)
		.find(
			{ $or: or },
			session !== undefined ? { session, projection } : { projection }
		)
		.toArray();
	const keys = new Set<string>();
	for (const doc of found) {
		const row = doc as Record<string, unknown>;
		keys.add(bsonMatchKey(row[ref.toColumn]));
		if (ref.toColumn === "id") keys.add(bsonMatchKey(row._id));
	}
	return values.filter((v) => !keys.has(bsonMatchKey(v)));
}

/**
 * Applique `on update` aux dépendants des clés de `collection` qui ont
 * changé : `restrict` refuse si un enfant référence une ancienne valeur,
 * `cascade` y écrit la nouvelle, `set-null` met NULL — puis récurse sur la
 * colonne enfant ainsi réécrite. Les enfants sont repérés par l'ancienne
 * valeur puis réécrits par `_id`, ce qui garde un échange de clés (a↔b)
 * correct. Termine sans garde de cycle : un niveau réécrit toutes les
 * lignes qui portaient ses anciennes valeurs, un retour n'en trouve plus.
 */
async function applyOnUpdate(
	cx: MongoContext,
	collection: string,
	changes: ReadonlyMap<string, readonly KeyMove[]>,
	session: ClientSession,
	journal?: Journal
): Promise<void> {
	if (changes.size === 0) return;
	const db = cx.db();
	for (const ref of await loadRefs(cx, "toCollection", collection)) {
		const moves = changes.get(ref.toColumn);
		if (moves === undefined) continue;
		const byOld = new Map<string, KeyMove>();
		for (const move of moves) {
			const key = bsonMatchKey(move.from);
			const seen = byOld.get(key);
			if (
				seen !== undefined &&
				ref.onUpdate === "cascade" &&
				bsonMatchKey(seen.to) !== bsonMatchKey(move.to)
			) {
				throw new EngineExecutionError(
					`update de '${collection}' : la foreign key '${ref.name}' (CASCADE) ne peut pas propager ${JSON.stringify(normalizeBson(move.from))} — plusieurs lignes portant cette valeur sur '${ref.toName}' reçoivent des valeurs différentes. Une colonne référencée doit être unique.`
				);
			}
			byOld.set(key, move);
		}
		const childColl = db.collection(ref.fromCollection);
		const childFilter = {
			[ref.fromColumn]: { $in: [...byOld.values()].map((m) => m.from) }
		} as Document;
		if (ref.onUpdate === "restrict") {
			const cnt = await childColl.countDocuments(childFilter, {
				session,
				limit: 1
			});
			if (cnt > 0) {
				throw new EngineExecutionError(
					`update de '${collection}' viole la foreign key '${ref.name}' (RESTRICT) : ${ref.fromCollection} référence encore les anciennes valeurs de '${ref.toName}' via '${ref.fromName}'. Mets d'abord à jour les dépendants ou déclare 'on update cascade'.`
				);
			}
			continue;
		}
		const children = await childColl
			.find(childFilter, { session, projection: { [ref.fromColumn]: 1 } })
			.toArray();
		const groups = new Map<string, { move: KeyMove; ids: unknown[] }>();
		for (const child of children) {
			const key = bsonMatchKey(
				(child as Record<string, unknown>)[ref.fromColumn]
			);
			const move = byOld.get(key);
			if (move === undefined) continue;
			const group = groups.get(key) ?? { move, ids: [] };
			group.ids.push(child._id);
			groups.set(key, group);
		}
		if (groups.size === 0) continue;
		// La nouvelle clé prend le type de la colonne enfant (int → bigint…).
		const childType = (await loadDeclaredTypes(cx, ref.fromCollection)).get(
			ref.fromColumn
		);
		const childMoves: KeyMove[] = [];
		for (const { move, ids } of groups.values()) {
			const to =
				ref.onUpdate === "set-null"
					? null
					: childType === undefined
						? move.to
						: toDeclaredType(
								move.to,
								childType,
								ref.fromName,
								`update de '${ref.fromCollection}'`
							);
			await setField(
				childColl,
				{ _id: { $in: ids } },
				ref.fromColumn,
				to,
				session,
				journal
			);
			childMoves.push({ from: move.from, to });
		}
		await applyOnUpdate(
			cx,
			ref.fromCollection,
			new Map([[ref.fromColumn, childMoves]]),
			session,
			journal
		);
	}
}

/**
 * Delete avec cascade FK (ADR-031 FK/1b). Trouve les lignes supprimées,
 * applique `on delete` (restrict/cascade/set-null) aux collections
 * dépendantes récursivement (multi-niveau + garde de cycle), puis supprime
 * les lignes cibles.
 */
export async function deleteCascading(
	cx: MongoContext,
	query: Extract<MongoWrite, { op: "delete" }>,
	session: ClientSession,
	journal?: Journal
): Promise<ResultSet> {
	const coll = cx.db().collection(query.collection);
	const docs = await coll
		.find(hydrateBson(query.filter, true) as Document, { session })
		.toArray();
	if (docs.length === 0) return { columns: [], rows: [], rowCount: 0 };
	await cascadeChildren(
		cx,
		query.collection,
		docs,
		session,
		new Set<string>(),
		journal
	);
	const res = await coll.deleteMany(
		{ _id: { $in: docs.map((d) => d._id) } },
		{ session }
	);
	journal?.push(async () => {
		await coll.insertMany(docs, { session });
	});
	return { columns: [], rows: [], rowCount: res.deletedCount };
}

/**
 * Applique les règles `on delete` aux enfants de `docs` (lignes en cours de
 * suppression dans `collection`), récursivement. `restrict` refuse si un
 * enfant existe ; `set-null` met la FK à NULL ; `cascade` supprime les
 * enfants (après avoir cascadé leurs propres enfants). Garde de cycle via
 * `visited` (paires `collection:_id`).
 */
async function cascadeChildren(
	cx: MongoContext,
	collection: string,
	docs: readonly Document[],
	session: ClientSession,
	visited: Set<string>,
	journal?: Journal
): Promise<void> {
	const db = cx.db();
	const incoming = await loadRefs(cx, "toCollection", collection);
	for (const ref of incoming) {
		// Valeurs de clé référencées par les enfants (côté `toColumn`).
		const keyVals = uniqueDefined(
			docs.map((d) => (d as Record<string, unknown>)[ref.toColumn])
		);
		if (keyVals.length === 0) continue;
		const childColl = db.collection(ref.fromCollection);
		const keys = ref.toColumn === "_id" ? keyVals.flatMap(keyForms) : keyVals;
		const childFilter = {
			[ref.fromColumn]: { $in: keys.map((v) => hydrateBson(v, false)) }
		} as Document;
		if (ref.onDelete === "restrict") {
			const cnt = await childColl.countDocuments(childFilter, {
				session,
				limit: 1
			});
			if (cnt > 0) {
				throw new EngineExecutionError(
					`delete de '${collection}' viole la foreign key '${ref.name}' (RESTRICT) : ${ref.fromCollection} référence encore ces lignes via '${ref.fromName}'. Supprime d'abord les dépendants ou déclare 'on delete cascade'.`
				);
			}
		} else if (ref.onDelete === "set-null") {
			await setField(
				childColl,
				childFilter,
				ref.fromColumn,
				null,
				session,
				journal
			);
		} else {
			// cascade : récurse puis supprime les enfants (bottom-up).
			const children = await childColl.find(childFilter, { session }).toArray();
			const fresh = children.filter((c) => {
				const key = `${ref.fromCollection}:${String((c as { _id: unknown })._id)}`;
				if (visited.has(key)) return false;
				visited.add(key);
				return true;
			});
			if (fresh.length === 0) continue;
			await cascadeChildren(
				cx,
				ref.fromCollection,
				fresh,
				session,
				visited,
				journal
			);
			await childColl.deleteMany(
				{ _id: { $in: fresh.map((c) => c._id) } },
				{ session }
			);
			journal?.push(async () => {
				await childColl.insertMany(fresh, { session });
			});
		}
	}
}
