import type {
	Collection,
	CollectionIndex,
	EnumTypeDef,
	Field,
	RefDef,
	Relation,
	SchemaModel,
	SnqlType
} from "@sqlnest/snql";
import type { Db, Document } from "mongodb";
import { EngineIntrospectionError } from "../errors";
import { inferNamingRelations } from "../naming-relations";

/**
 * bsonType du validator `$jsonSchema` → `SnqlType`. Inverse de `MONGO_BSON_TYPE`
 * du codegen. Permet de lire les colonnes **déclarées** d'une collection (via
 * son validator) même quand elle est vide — le sampling seul ne verrait rien.
 */
const BSON_TYPE_TO_SNQL: Readonly<Record<string, SnqlType>> = {
	string: "string",
	int: "int",
	long: "bigint",
	double: "float",
	decimal: "decimal",
	bool: "bool",
	date: "date",
	object: "json",
	array: "array",
	binData: "uuid"
};

/** Un document échantillonné, réduit à ses paires clé/valeur. */
export type SampledDoc = Record<string, unknown>;

/**
 * Type d'une valeur BSON/JS → `SnqlType`. Les types BSON du driver portent un
 * `_bsontype` ; on les reconnaît sans importer les classes.
 */
export function snqlTypeOf(value: unknown): SnqlType {
	if (typeof value === "string") {
		return "string";
	}
	if (typeof value === "boolean") {
		return "bool";
	}
	if (typeof value === "bigint") {
		return "bigint";
	}
	if (typeof value === "number") {
		return Number.isInteger(value) ? "int" : "float";
	}
	if (value instanceof Date) {
		return "date";
	}
	if (Array.isArray(value)) {
		return "array";
	}
	if (value !== null && typeof value === "object") {
		const bsontype = (value as { readonly _bsontype?: string })._bsontype;
		switch (bsontype) {
			case "ObjectId":
				return "string";
			case "UUID":
				return "uuid";
			case "Decimal128":
				return "decimal";
			case "Long":
				return "bigint";
			case "Int32":
				return "int";
			case "Double":
				return "float";
			case "Timestamp":
				return "date";
			case undefined:
				return "json"; // document imbriqué
			default:
				return "unknown";
		}
	}
	return "unknown";
}

interface FieldStat {
	present: number;
	nullable: boolean;
	readonly types: Map<SnqlType, number>;
}

function mostCommonType(types: Map<SnqlType, number>): SnqlType {
	let best: SnqlType = "unknown";
	let bestCount = 0;
	for (const [type, count] of types) {
		if (count > bestCount) {
			best = type;
			bestCount = count;
		}
	}
	return best;
}

/**
 * Infère une {@link Collection} depuis des documents échantillonnés. `confidence`
 * = fréquence d'apparition du champ ; un champ absent de certains docs ou parfois
 * null est `nullable`. `_id` (toujours présent) fait office de clé primaire.
 */
export function inferCollection(
	name: string,
	docs: readonly SampledDoc[]
): Collection {
	const sampleSize = docs.length;
	const stats = new Map<string, FieldStat>();

	for (const doc of docs) {
		for (const key of Object.keys(doc)) {
			const stat = stats.get(key) ?? {
				present: 0,
				nullable: false,
				types: new Map<SnqlType, number>()
			};
			stat.present += 1;
			const value = doc[key];
			if (value === null || value === undefined) {
				stat.nullable = true;
			} else {
				const type = snqlTypeOf(value);
				stat.types.set(type, (stat.types.get(type) ?? 0) + 1);
			}
			stats.set(key, stat);
		}
	}

	const fields: Field[] = [...stats.entries()].map(([fieldName, stat]) => ({
		name: fieldName,
		type: mostCommonType(stat.types),
		nullable: stat.nullable || stat.present < sampleSize,
		source: "inferred" as const,
		confidence: sampleSize > 0 ? stat.present / sampleSize : 0
	}));

	const hasId = fields.some((field) => field.name === "_id");
	return hasId
		? { name, fields, primaryKey: ["_id"], source: "inferred" }
		: { name, fields, source: "inferred" };
}

/**
 * Relations inférées par **heuristique de nommage** : un champ `<x>_id` pointe
 * vers la collection `<x>` (ou `<x>s`) si elle existe. `origin: naming-heuristic`,
 * confiance moyenne — l'utilisateur pourra confirmer. Mécanique partagée
 * cross-engine dans `naming-relations` (2e consommateur : MSSQL sans FK
 * déclarées) — la clé cible Mongo est toujours `_id`.
 */
export function inferRelations(collections: readonly Collection[]): Relation[] {
	return inferNamingRelations(collections, {
		// `_id`, ou son alias SNQL (ADR-036 E/1f).
		targetKeyFor: (target) =>
			target.fields.find((f) => f.nativeName === "_id")?.name ?? "_id"
	});
}

/** Alias de clé primaire (ADR-036 E/1f) : `_id` = la collection. */
export const SNQL_PK = "_snql_pk";

export interface PkAlias {
	readonly column: string;
	readonly type: SnqlType;
}

/**
 * Collections créées avec `primary key (id)` : `id` y est l'alias de `_id`.
 * Best-effort : métadonnée absente ou illisible → aucune.
 */
export async function loadPkAliases(db: Db): Promise<Map<string, PkAlias>> {
	const aliases = new Map<string, PkAlias>();
	try {
		for (const doc of await db.collection(SNQL_PK).find({}).toArray()) {
			const d = doc as Record<string, unknown>;
			if (typeof d._id !== "string" || typeof d.column !== "string") continue;
			const type =
				typeof d.type === "string" && d.type in SNQL_TYPES
					? (d.type as SnqlType)
					: "unknown";
			aliases.set(d._id, { column: d.column, type });
		}
	} catch {
		// silence — pas d'alias lisible
	}
	return aliases;
}

const SNQL_TYPES: Readonly<Record<SnqlType, true>> = {
	string: true,
	int: true,
	bigint: true,
	float: true,
	decimal: true,
	bool: true,
	date: true,
	json: true,
	array: true,
	uuid: true,
	enum: true,
	unknown: true
};

/**
 * `_id` présenté sous son alias : champ SNQL `id`, nom natif `_id`, clé
 * primaire. Un champ `id` stocké à côté (documents d'avant l'alias) est
 * masqué : `id` désigne `_id`.
 */
export function applyPkAlias(
	collection: Collection,
	alias: PkAlias | undefined
): Collection {
	if (alias === undefined) return collection;
	const key: Field = {
		name: alias.column,
		type: alias.type,
		nullable: false,
		source: "declared",
		nativeName: "_id"
	};
	return {
		...collection,
		fields: [
			key,
			...collection.fields.filter(
				(f) => f.name !== "_id" && f.name !== alias.column
			)
		],
		primaryKey: [alias.column]
	};
}

/**
 * Introspecte une base MongoDB par échantillonnage (`$sample`) et produit le
 * SchemaModel. Le schéma étant inféré, `source: "inferred"` + `confidence`.
 */
export async function introspectMongo(
	db: Db,
	sampleSize: number
): Promise<SchemaModel> {
	try {
		// nameOnly:false → on récupère aussi `options.validator` pour lire les
		// colonnes DÉCLARÉES (une collection créée via `create table` mais vide
		// n'a rien à échantillonner ; ses colonnes vivent dans le $jsonSchema).
		const infos = await db.listCollections({}, { nameOnly: false }).toArray();
		const validatorByName = new Map<string, Record<string, unknown>>();
		const names: string[] = [];
		for (const info of infos) {
			const name = (info as { name?: unknown }).name;
			if (typeof name !== "string") continue;
			// `system.*` = Mongo internal ; `_snql_*` = metadata SQLNest
			// (introspectés séparément, jamais comme collection user).
			if (name.startsWith("system.") || name.startsWith("_snql_")) continue;
			names.push(name);
			const validator = (
				info as { options?: { validator?: Record<string, unknown> } }
			).options?.validator;
			if (validator !== undefined) validatorByName.set(name, validator);
		}

		const pkAliases = await loadPkAliases(db);
		const collections = await Promise.all(
			names.map(async (name) => {
				const docs = await db
					.collection(name)
					.aggregate([{ $sample: { size: sampleSize } }])
					.toArray();
				const inferred = inferCollection(name, docs as SampledDoc[]);
				const merged = applyPkAlias(
					mergeValidatorFields(inferred, validatorByName.get(name)),
					pkAliases.get(name)
				);
				const indexes = await readIndexes(db, name);
				return indexes.length > 0 ? { ...merged, indexes } : merged;
			})
		);

		// Enums stockés dans metadata `_snql_enums` (ADR-030 Enum/1). Best-effort :
		// collection absente = enums vide ; permission denied = enums vide (le user
		// n'a peut-être pas les droits sur _snql_enums mais tout le reste marche).
		const enumsList: EnumTypeDef[] = [];
		try {
			const docs = await db
				.collection<{ _id: string; members: readonly string[] }>(
					"_snql_enums"
				)
				.find({})
				.toArray();
			for (const doc of docs) {
				if (typeof doc._id === "string" && Array.isArray(doc.members)) {
					enumsList.push({
						name: doc._id,
						members: doc.members,
						source: "declared"
					});
				}
			}
		} catch {
			// silence — enums restent vide
		}

		// FK déclarées stockées dans `_snql_refs` (ADR-031 FK/1a). Best-effort
		// comme les enums (collection absente / permission = refs vide).
		const refsList: RefDef[] = [];
		try {
			const docs = await db.collection("_snql_refs").find({}).toArray();
			for (const doc of docs) {
				const d = doc as Record<string, unknown>;
				if (
					typeof d._id === "string" &&
					typeof d.fromCollection === "string" &&
					typeof d.fromColumn === "string" &&
					typeof d.toCollection === "string" &&
					typeof d.toColumn === "string"
				) {
					refsList.push({
						name: d._id,
						fromCollection: d.fromCollection,
						fromColumn: d.fromColumn,
						toCollection: d.toCollection,
						toColumn: d.toColumn,
						onDelete: normalizeRefRule(d.onDelete, "restrict"),
						onUpdate: normalizeRefRule(d.onUpdate, "restrict"),
						source: "declared"
					});
				}
			}
		} catch {
			// silence — refs restent vide
		}

		// Défauts posés par SQLNest (ADR-036 D4) : `hasDefault` + leur texte.
		let withDefaults = collections;
		try {
			const docs = await db.collection("_snql_defaults").find({}).toArray();
			const byColumn = new Map<string, string>();
			for (const doc of docs) {
				const d = doc as Record<string, unknown>;
				if (typeof d.collection !== "string" || typeof d.column !== "string") continue;
				byColumn.set(`${d.collection}.${d.column}`, mongoDefaultText(d));
			}
			withDefaults = collections.map((c) => ({
				...c,
				fields: c.fields.map((f) => {
					const text = byColumn.get(`${c.name}.${f.nativeName ?? f.name}`);
					return text === undefined ? f : { ...f, hasDefault: true, defaultExpr: text };
				})
			}));
		} catch {
			// silence — pas de défauts lisibles
		}

		const withEnums = linkEnumColumns(withDefaults, enumsList);
		return {
			engine: "mongodb",
			collections: withEnums,
			relations: inferRelations(withEnums),
			...(enumsList.length > 0 ? { enums: enumsList } : {}),
			...(refsList.length > 0 ? { refs: refsList } : {})
		};
	} catch (cause) {
		throw new EngineIntrospectionError("Introspection MongoDB échouée", {
			cause
		});
	}
}

/**
 * Colonne d'enum : son validateur porte les valeurs de l'enum, pas son nom.
 * Elle est rattachée à l'enum aux mêmes valeurs — la règle qu'`add enum
 * member` suit pour mettre ces validateurs à jour.
 */
export function linkEnumColumns(
	collections: readonly Collection[],
	enums: readonly EnumTypeDef[]
): Collection[] {
	if (enums.length === 0) return [...collections];
	return collections.map((c) => ({
		...c,
		fields: c.fields.map((f) => {
			const values = f.enumValues;
			const enumDef =
				values !== undefined
					? enums.find(
							(e) =>
								e.members.length === values.length &&
								e.members.every((m, i) => m === values[i])
						)
					: undefined;
			return enumDef !== undefined
				? { ...f, type: "enum" as const, enumTypeName: enumDef.name }
				: f;
		})
	}));
}

/**
 * Index d'une collection hors `_id_` (ADR-036 D6). Un index texte n'a pas de
 * colonnes nommables : écarté. Best-effort : droits manquants → aucun.
 */
async function readIndexes(db: Db, name: string): Promise<CollectionIndex[]> {
	try {
		const indexes: CollectionIndex[] = [];
		for (const index of await db.collection(name).listIndexes().toArray()) {
			const keys = Object.keys((index as { key?: Document }).key ?? {});
			if (index.name === "_id_" || keys.includes("_fts")) continue;
			indexes.push({
				name: String(index.name),
				columns: keys,
				unique: (index as { unique?: unknown }).unique === true
			});
		}
		return indexes;
	} catch {
		return [];
	}
}

/** Texte d'un défaut de `_snql_defaults` : `now()`, `uuid()` ou la valeur en JSON. */
export function mongoDefaultText(entry: Record<string, unknown>): string {
	if (entry.fn === "now") return "now()";
	if (entry.fn === "uuid") return "uuid()";
	return JSON.stringify(entry.value);
}

/**
 * Fusionne les colonnes DÉCLARÉES du validator `$jsonSchema` dans une
 * collection inférée par sampling (ADR-031, fix flow DDL Mongo). Une colonne
 * présente dans le validator mais absente du sampling (collection vide ou
 * valeur toujours absente) est ajoutée `source: "declared"`. Une colonne déjà
 * inférée garde ses stats de sampling (confidence). Nécessaire pour que
 * `create table` → `describe`/FK-target voie les colonnes avant tout insert.
 */
export function mergeValidatorFields(
	inferred: Collection,
	validator: Record<string, unknown> | undefined
): Collection {
	if (validator === undefined) return inferred;
	const jsonSchema = (validator as { $jsonSchema?: Record<string, unknown> })
		.$jsonSchema;
	const properties = (
		jsonSchema as { properties?: Record<string, unknown> } | undefined
	)?.properties;
	if (properties === undefined) return inferred;
	const required = new Set(
		((jsonSchema as { required?: unknown }).required as string[] | undefined) ??
			[]
	);
	const known = new Set(inferred.fields.map((f) => f.name));
	const declared: Field[] = [];
	const fromValidator = new Map<string, Field>();
	for (const [propName, propRaw] of Object.entries(properties)) {
		const bsonType = (propRaw as { bsonType?: unknown }).bsonType;
		// Une colonne nullable est déclarée `[type, "null"]` : le type reste lisible.
		const single = Array.isArray(bsonType)
			? bsonType.find((t) => t !== "null")
			: bsonType;
		const type =
			typeof single === "string"
				? (BSON_TYPE_TO_SNQL[single] ?? "unknown")
				: "unknown";
		const members = (propRaw as { enum?: unknown }).enum;
		const enumValues = Array.isArray(members)
			? members.filter((m): m is string => typeof m === "string")
			: undefined;
		const field: Field = {
			name: propName,
			type,
			nullable: !required.has(propName),
			source: "declared",
			...(enumValues !== undefined ? { enumValues } : {})
		};
		if (known.has(propName)) fromValidator.set(propName, field);
		else declared.push(field);
	}
	// Une colonne échantillonnée garde ses stats ; le validateur, contrat
	// déclaré, en fixe le type, la nullabilité et les valeurs d'enum.
	const fields = inferred.fields.map((f) => {
		const d = fromValidator.get(f.name);
		if (d === undefined) return f;
		return {
			...f,
			type: d.type === "unknown" ? f.type : d.type,
			nullable: d.nullable,
			...(d.enumValues !== undefined ? { enumValues: d.enumValues } : {})
		};
	});
	return { ...inferred, fields: [...fields, ...declared] };
}

/** Normalise une règle de cascade lue du metadata (`set null` alias). */
function normalizeRefRule(
	raw: unknown,
	fallback: "restrict" | "cascade" | "set-null"
): "restrict" | "cascade" | "set-null" {
	if (raw === "cascade" || raw === "restrict" || raw === "set-null") return raw;
	if (raw === "set null" || raw === "setnull") return "set-null";
	return fallback;
}
