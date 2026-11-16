import type { NativeQuery, ResultSet } from "@sqlnest/snql";
import { EngineExecutionError } from "../errors";
import type { MongoContext } from "./context";
import { describeMongoExecutionError } from "./execution-errors";

/**
 * DDL émulé — enums.
 */

/**
 * Enum/1w create enum Mongo. Compensation runtime — Mongo n'a pas d'enum
 * type natif : on stocke `{_id: name, members}` dans la collection
 * metadata `_snql_enums`. Idempotence D3 via catch DuplicateKey (11000) si
 * `ifNotExists=true`. Le validator `enum: [...]` sera propagé aux
 * $jsonSchema des tables utilisatrices via Enum/2 (résolution `type:
 * role_type` dans create-table body).
 */
export async function executeDDLCreateEnum(
	cx: MongoContext,
	query: Extract<NativeQuery, { kind: "mongo-ddl"; operation: "create-enum" }>
): Promise<ResultSet> {
	const db = cx.db();
	try {
		await db
			.collection<{ _id: string; members: readonly string[] }>("_snql_enums")
			.insertOne({ _id: query.name, members: query.members });
		return { columns: [], rows: [], rowCount: 0 };
	} catch (cause) {
		const code = (cause as { code?: unknown } | null)?.code;
		if (query.ifNotExists && code === 11000) {
			return { columns: [], rows: [], rowCount: 0 };
		}
		throw new EngineExecutionError(
			`create enum MongoDB échouée sur '${query.name}' — ${describeMongoExecutionError(cause)}`,
			{ cause }
		);
	}
}

/**
 * Enum/3 add enum member Mongo. Compensation runtime en 2 étapes :
 *  1. `_snql_enums.findOneAndUpdate({_id: name}, {$addToSet: {members: value}})`
 *     — dedup naturel Set (D3 idempotent silence si déjà présent). Renvoie
 *     l'ancien doc pour connaître le tableau `members` avant patch.
 *  2. Scan `listCollections` pour trouver les collections avec un validator
 *     `$jsonSchema.properties.<col>.enum = [oldMembers]` matchant l'enum,
 *     et applique `collMod` batché avec le tableau étendu.
 *
 * Si l'enum est absent : `ifNotExists=true` silence, sinon refus typé.
 */
export async function executeDDLAddEnumMember(
	cx: MongoContext,
	query: Extract<
		NativeQuery,
		{ kind: "mongo-ddl"; operation: "add-enum-member" }
	>
): Promise<ResultSet> {
	const db = cx.db();
	const enumsCol = db.collection<{
		_id: string;
		members: readonly string[];
	}>("_snql_enums");
	try {
		const before = await enumsCol.findOne({ _id: query.name });
		if (before === null) {
			if (query.ifNotExists) {
				return { columns: [], rows: [], rowCount: 0 };
			}
			throw new EngineExecutionError(
				`add enum member échouée : enum '${query.name}' inexistant`
			);
		}
		const oldMembers = (before.members ?? []) as readonly string[];
		if (oldMembers.includes(query.member)) {
			return { columns: [], rows: [], rowCount: 0 };
		}
		const newMembers = [...oldMembers, query.member];
		await enumsCol.updateOne(
			{ _id: query.name },
			{ $addToSet: { members: query.member } }
		);
		// Rollback des validators : patch $jsonSchema.properties.<col>.enum
		// pour chaque collection utilisatrice. Détection = validator dont une
		// property.enum matche oldMembers exactement (snapshot posé par Enum/2a).
		const collInfoCursor = db.listCollections({}, { nameOnly: false });
		const collInfoArr = await collInfoCursor.toArray();
		for (const info of collInfoArr) {
			const collName = (info as { name?: unknown }).name;
			if (typeof collName !== "string" || collName.startsWith("system.")) {
				continue;
			}
			const validator =
				(info as { options?: { validator?: Record<string, unknown> } }).options
					?.validator ?? {};
			const jsonSchema = (
				validator as { $jsonSchema?: Record<string, unknown> }
			).$jsonSchema;
			const properties = (
				jsonSchema as { properties?: Record<string, unknown> } | undefined
			)?.properties;
			if (jsonSchema === undefined || properties === undefined) continue;
			let touched = false;
			const newProperties: Record<string, unknown> = { ...properties };
			for (const [propName, propRaw] of Object.entries(properties)) {
				const prop = propRaw as { enum?: unknown };
				const snapshot = enumSnapshot(prop.enum);
				if (
					snapshot === undefined ||
					!sameValues(snapshot.values, oldMembers)
				) {
					continue;
				}
				newProperties[propName] = {
					...prop,
					enum: snapshot.nullable ? [...newMembers, null] : newMembers
				};
				touched = true;
			}
			if (touched) {
				const newJsonSchema = { ...jsonSchema, properties: newProperties };
				await db.command({
					collMod: collName,
					validator: { $jsonSchema: newJsonSchema }
				});
			}
		}
		return { columns: [], rows: [], rowCount: 0 };
	} catch (cause) {
		if (cause instanceof EngineExecutionError) throw cause;
		throw new EngineExecutionError(
			`add enum member MongoDB échouée sur '${query.name}' — ${describeMongoExecutionError(cause)}`,
			{ cause }
		);
	}
}

/**
 * Enum/3 drop enum Mongo. Compensation runtime en 3 étapes :
 *  1. Lit `_snql_enums:<name>` : si absent + `ifExists` → silence, sinon
 *     refus typé.
 *  2. Scan collections pour détecter celles qui utilisent l'enum (validator
 *     `$jsonSchema.properties.<col>.enum` matche members). Si ≥1 collection
 *     et `cascade=false` (RESTRICT) → refus (miroir PG 2BP01).
 *  3. Sinon (aucune usager OU cascade=true) : rollback des validators
 *     (retire `enum: [...]` de chaque property matchée, garde `bsonType`) +
 *     `deleteOne _snql_enums`.
 */
export async function executeDDLDropEnum(
	cx: MongoContext,
	query: Extract<NativeQuery, { kind: "mongo-ddl"; operation: "drop-enum" }>
): Promise<ResultSet> {
	const db = cx.db();
	const enumsCol = db.collection<{
		_id: string;
		members: readonly string[];
	}>("_snql_enums");
	try {
		const before = await enumsCol.findOne({ _id: query.name });
		if (before === null) {
			if (query.ifExists) {
				return { columns: [], rows: [], rowCount: 0 };
			}
			throw new EngineExecutionError(
				`drop enum échouée : enum '${query.name}' inexistant`
			);
		}
		const members = (before.members ?? []) as readonly string[];
		const collInfoCursor = db.listCollections({}, { nameOnly: false });
		const collInfoArr = await collInfoCursor.toArray();
		const usages: {
			collection: string;
			property: string;
			validator: Record<string, unknown>;
		}[] = [];
		for (const info of collInfoArr) {
			const collName = (info as { name?: unknown }).name;
			if (typeof collName !== "string" || collName.startsWith("system.")) {
				continue;
			}
			const validator =
				(info as { options?: { validator?: Record<string, unknown> } }).options
					?.validator ?? {};
			const jsonSchema = (
				validator as { $jsonSchema?: Record<string, unknown> }
			).$jsonSchema;
			const properties = (
				jsonSchema as { properties?: Record<string, unknown> } | undefined
			)?.properties;
			if (jsonSchema === undefined || properties === undefined) continue;
			for (const [propName, propRaw] of Object.entries(properties)) {
				const prop = propRaw as { enum?: unknown };
				const snapshot = enumSnapshot(prop.enum);
				if (snapshot === undefined || !sameValues(snapshot.values, members)) {
					continue;
				}
				usages.push({
					collection: collName,
					property: propName,
					validator
				});
			}
		}
		if (usages.length > 0 && !query.cascade) {
			const details = usages
				.map((u) => `${u.collection}.${u.property}`)
				.join(", ");
			throw new EngineExecutionError(
				`drop enum '${query.name}' RESTRICT : enum utilisé par ${usages.length} colonne(s) — ${details}. Réessaie avec 'cascade' pour retirer les validators.`
			);
		}
		// Rollback des validators (retire enum: [...] mais garde bsonType).
		// Groupe par collection pour minimiser les collMod.
		const byCollection = new Map<
			string,
			{ validator: Record<string, unknown>; properties: string[] }
		>();
		for (const u of usages) {
			const entry = byCollection.get(u.collection);
			if (entry === undefined) {
				byCollection.set(u.collection, {
					validator: u.validator,
					properties: [u.property]
				});
			} else {
				entry.properties.push(u.property);
			}
		}
		for (const [collName, entry] of byCollection) {
			const jsonSchema = (
				entry.validator as { $jsonSchema?: Record<string, unknown> }
			).$jsonSchema as Record<string, unknown>;
			const properties =
				(jsonSchema as { properties?: Record<string, unknown> }).properties ??
				{};
			const newProperties: Record<string, unknown> = { ...properties };
			for (const propName of entry.properties) {
				const prop = { ...(properties[propName] as Record<string, unknown>) };
				delete prop["enum"];
				newProperties[propName] = prop;
			}
			const newJsonSchema = { ...jsonSchema, properties: newProperties };
			await db.command({
				collMod: collName,
				validator: { $jsonSchema: newJsonSchema }
			});
		}
		await enumsCol.deleteOne({ _id: query.name });
		// Auto-cleanup : si `_snql_enums` ne contient plus aucun enum SNQL,
		// drop la collection entière pour ne laisser aucun artefact SQLNest
		// dans le dump Mongo. Meta présente ssi ≥1 enum existe.
		const remaining = await enumsCol.countDocuments({});
		if (remaining === 0) {
			try {
				await enumsCol.drop();
			} catch (cleanupCause) {
				const code = (cleanupCause as { code?: unknown } | null)?.code;
				// NamespaceNotFound = déjà purgée par un autre process — safe.
				if (code !== 26) throw cleanupCause;
			}
		}
		return { columns: [], rows: [], rowCount: 0 };
	} catch (cause) {
		if (cause instanceof EngineExecutionError) throw cause;
		throw new EngineExecutionError(
			`drop enum MongoDB échouée sur '${query.name}' — ${describeMongoExecutionError(cause)}`,
			{ cause }
		);
	}
}

/**
 * Valeurs d'un `enum` de validateur, `null` à part : une colonne d'enum
 * nullable déclare `[...valeurs, null]`.
 */
function enumSnapshot(
	raw: unknown
):
	| { readonly values: readonly string[]; readonly nullable: boolean }
	| undefined {
	if (!Array.isArray(raw)) return undefined;
	const values = raw.filter((v): v is string => typeof v === "string");
	const nullable = raw.includes(null);
	return values.length + (nullable ? 1 : 0) === raw.length
		? { values, nullable }
		: undefined;
}

function sameValues(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}
