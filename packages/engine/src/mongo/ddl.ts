import type { NativeQuery, ResultSet } from "@sqlnest/snql";
import { EngineExecutionError } from "../errors";
import type { MongoContext } from "./context";
import {
	executeDDLAddColumn,
	executeDDLAlterColumn,
	executeDDLDropColumn,
	executeDDLRenameColumn
} from "./ddl-columns";
import {
	executeDDLAddEnumMember,
	executeDDLCreateEnum,
	executeDDLDropEnum
} from "./ddl-enums";
import { executeDDLAddRef, executeDDLDropRef, storeRefs } from "./ddl-refs";
import { storeDefault } from "./defaults";
import { describeMongoExecutionError } from "./execution-errors";
import { SNQL_PK } from "./introspect";
import { metadataCollection } from "./metadata";

/**
 * DDL émulé : MongoDB n'a ni colonnes ni contraintes, le validateur de la
 * collection en tient lieu. Aiguillage, collections et index.
 */

/**
 * DDL Tier-2 sur Mongo (ADR-029). Dispatch par `operation` :
 *  - `create-collection` : createCollection + validator + createIndex.
 *  - `add-column` : preflight D2 + collMod validator étendu + backfill D10 batched.
 * Renvoie un ResultSet vide + written=true (pas de RETURNING sur un DDL).
 */
export async function executeDDL(
	cx: MongoContext,
	query: Extract<NativeQuery, { kind: "mongo-ddl" }>
): Promise<ResultSet> {
	if (query.operation === "create-collection") {
		return executeDDLCreateCollection(cx, query);
	}
	if (query.operation === "add-column") {
		return executeDDLAddColumn(cx, query);
	}
	if (query.operation === "add-index") {
		return executeDDLAddIndex(cx, query);
	}
	if (query.operation === "drop-index") {
		return executeDDLDropIndex(cx, query);
	}
	if (query.operation === "drop-collection") {
		return executeDDLDropCollection(cx, query);
	}
	if (query.operation === "drop-column") {
		return executeDDLDropColumn(cx, query);
	}
	if (query.operation === "create-enum") {
		return executeDDLCreateEnum(cx, query);
	}
	if (query.operation === "add-enum-member") {
		return executeDDLAddEnumMember(cx, query);
	}
	if (query.operation === "drop-enum") {
		return executeDDLDropEnum(cx, query);
	}
	if (query.operation === "add-ref") {
		return executeDDLAddRef(cx, query);
	}
	if (query.operation === "rename-column") {
		return executeDDLRenameColumn(cx, query);
	}
	if (query.operation === "alter-column") {
		return executeDDLAlterColumn(cx, query);
	}
	return executeDDLDropRef(cx, query);
}

/**
 * DDL/4 drop table Mongo. `db.<collection>.drop()` natif. D3 `ifExists=true` :
 * catch `NamespaceNotFound` (code 26) traité comme succès silencieux.
 */
async function executeDDLDropCollection(
	cx: MongoContext,
	query: Extract<
		NativeQuery,
		{ kind: "mongo-ddl"; operation: "drop-collection" }
	>
): Promise<ResultSet> {
	const db = cx.db();
	try {
		await db.collection(query.collection).drop();
		// Purge les FK impliquant cette collection (ADR-031 FK/1b) — sortantes
		// (from) ET entrantes (to) : la table disparue, ses contraintes n'ont
		// plus de sens. Best-effort (pas de `drop ref` natif encore = FK/3).
		try {
			await db.collection("_snql_refs").deleteMany({
				$or: [
					{ fromCollection: query.collection },
					{ toCollection: query.collection }
				]
			});
			await db.collection("_snql_defaults").deleteMany({
				collection: query.collection
			});
			await metadataCollection(db, SNQL_PK).deleteOne({
				_id: query.collection
			});
		} catch {
			// silence — métadonnées absentes
		}
		return { columns: [], rows: [], rowCount: 0 };
	} catch (cause) {
		const code = (cause as { code?: unknown } | null)?.code;
		if (query.ifExists && code === 26) {
			return { columns: [], rows: [], rowCount: 0 };
		}
		throw new EngineExecutionError(
			`drop table MongoDB échouée sur '${query.collection}' — ${describeMongoExecutionError(cause)}`,
			{ cause }
		);
	}
}

/**
 * DDL/3 add index Mongo. `db.<collection>.createIndex(keys, options)` natif —
 * idempotent : Mongo renvoie le nom sans erreur si un index identique
 * existe. D3 : catch `IndexOptionsConflict` (85) ou `IndexKeySpecsConflict`
 * (86) si `ifNotExists=true` — collision avec un index existant sous le
 * même nom mais options différentes, traité comme succès silencieux.
 */
async function executeDDLAddIndex(
	cx: MongoContext,
	query: Extract<NativeQuery, { kind: "mongo-ddl"; operation: "add-index" }>
): Promise<ResultSet> {
	const db = cx.db();
	const col = db.collection(query.collection);
	try {
		const options: Record<string, unknown> = {
			name: query.index.options.name
		};
		if (query.index.options.unique === true) options["unique"] = true;
		await col.createIndex(query.index.keys, options);
		return { columns: [], rows: [], rowCount: 0 };
	} catch (cause) {
		const code = (cause as { code?: unknown } | null)?.code;
		if (query.ifNotExists && (code === 85 || code === 86)) {
			return { columns: [], rows: [], rowCount: 0 };
		}
		throw new EngineExecutionError(
			`add index MongoDB échouée sur '${query.collection}.${query.index.options.name ?? "?"}' — ${describeMongoExecutionError(cause)}`,
			{ cause }
		);
	}
}

/**
 * DDL/3 drop index Mongo. `db.<collection>.dropIndex(name)` natif. D3 :
 * catch `IndexNotFound` (code 27) si `ifExists=true`.
 */
async function executeDDLDropIndex(
	cx: MongoContext,
	query: Extract<NativeQuery, { kind: "mongo-ddl"; operation: "drop-index" }>
): Promise<ResultSet> {
	const db = cx.db();
	const col = db.collection(query.collection);
	try {
		await col.dropIndex(query.name);
		return { columns: [], rows: [], rowCount: 0 };
	} catch (cause) {
		const code = (cause as { code?: unknown } | null)?.code;
		if (query.ifExists && code === 27) {
			return { columns: [], rows: [], rowCount: 0 };
		}
		throw new EngineExecutionError(
			`drop index MongoDB échouée sur '${query.collection}.${query.name}' — ${describeMongoExecutionError(cause)}`,
			{ cause }
		);
	}
}

async function executeDDLCreateCollection(
	cx: MongoContext,
	query: Extract<
		NativeQuery,
		{ kind: "mongo-ddl"; operation: "create-collection" }
	>
): Promise<ResultSet> {
	const db = cx.db();
	try {
		const createOptions: Record<string, unknown> = {};
		if (query.validator !== undefined) {
			createOptions["validator"] = query.validator;
		}
		let created = true;
		try {
			await db.createCollection(query.collection, createOptions);
		} catch (cause) {
			const isNamespaceExists =
				query.ifNotExists &&
				typeof cause === "object" &&
				cause !== null &&
				(cause as { code?: unknown }).code === 48;
			if (!isNamespaceExists) throw cause;
			created = false;
		}
		// Alias `id` ↔ `_id` (ADR-036 E/1f), seulement à la création : une
		// collection existante garde ses documents tels qu'ils sont.
		if (created && query.primaryKeyAlias !== undefined) {
			await metadataCollection(db, SNQL_PK).replaceOne(
				{ _id: query.collection },
				{
					column: query.primaryKeyAlias,
					...(query.primaryKeyType !== undefined
						? { type: query.primaryKeyType }
						: {}),
					...(query.primaryKeyStoredAs !== undefined
						? { storedAs: query.primaryKeyStoredAs }
						: {})
				},
				{ upsert: true }
			);
		}
		const indexes = query.indexes ?? [];
		for (const spec of indexes) {
			const options: Record<string, unknown> = {};
			if (spec.options.unique === true) options["unique"] = true;
			if (spec.options.name !== undefined) options["name"] = spec.options.name;
			await db.collection(query.collection).createIndex(spec.keys, options);
		}
		// FK déclarées (ADR-031 FK/1a) → stockage `_snql_refs`. Déclaration
		// seulement — l'enforcement (write-precheck + cascade) = FK/1b.
		if (query.refs !== undefined && query.refs.length > 0) {
			await storeRefs(cx, query.refs);
		}
		for (const spec of query.defaults ?? []) {
			await storeDefault(cx, query.collection, spec);
		}
		return { columns: [], rows: [], rowCount: 0 };
	} catch (cause) {
		throw new EngineExecutionError(
			`DDL MongoDB échouée sur '${query.collection}' — ${describeMongoExecutionError(cause)}`,
			{ cause }
		);
	}
}
