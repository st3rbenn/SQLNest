import type {
	Collection,
	EnumTypeDef,
	Field,
	RefDef,
	Relation,
	SchemaModel,
	SnqlType
} from "@sqlnest/snql";
import type { Db } from "mongodb";
import { EngineIntrospectionError } from "../errors";

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

/** Suffixes après lesquels le pluriel anglais est en `-es` (address → addresses). */
const ES_ENDINGS = ["s", "x", "z", "ch", "sh"];

/**
 * Cible d'un champ `<x>_id` : la première collection existante parmi les formes
 * plausibles du pluriel/singulier de `<x>` — pluriels réguliers ET irréguliers
 * (`category` → `categories`, `address` → `addresses`). Ne matche que si la
 * collection existe réellement → aucun faux positif ajouté.
 */
function resolveTargetCollection(
	prefix: string,
	names: ReadonlySet<string>
): string | undefined {
	const candidates = [`${prefix}s`, prefix];
	if (prefix.endsWith("y")) {
		candidates.push(`${prefix.slice(0, -1)}ies`); // category → categories
	}
	if (ES_ENDINGS.some((ending) => prefix.endsWith(ending))) {
		candidates.push(`${prefix}es`); // address → addresses, box → boxes
	}
	return candidates.find((candidate) => names.has(candidate));
}

/**
 * Relations inférées par **heuristique de nommage** : un champ `<x>_id` pointe
 * vers la collection `<x>` (ou `<x>s`) si elle existe. `origin: naming-heuristic`,
 * confiance moyenne — l'utilisateur pourra confirmer.
 */
export function inferRelations(collections: readonly Collection[]): Relation[] {
	const names = new Set(collections.map((c) => c.name));
	const relations: Relation[] = [];

	for (const collection of collections) {
		for (const field of collection.fields) {
			if (field.name === "_id" || !field.name.endsWith("_id")) {
				continue;
			}
			const prefix = field.name.slice(0, -"_id".length);
			const target = resolveTargetCollection(prefix, names);
			if (target !== undefined && target !== collection.name) {
				relations.push({
					from: { collection: collection.name, fields: [field.name] },
					to: { collection: target, fields: ["_id"] },
					kind: "many-to-one",
					origin: "naming-heuristic",
					confidence: 0.6
				});
			}
		}
	}

	return relations;
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
			// `system.*` = Mongo internal ; `_snql_enums` / `_snql_refs` = metadata
			// SQLNest (introspectés séparément, jamais comme collection user).
			if (
				name.startsWith("system.") ||
				name === "_snql_enums" ||
				name === "_snql_refs"
			) {
				continue;
			}
			names.push(name);
			const validator = (
				info as { options?: { validator?: Record<string, unknown> } }
			).options?.validator;
			if (validator !== undefined) validatorByName.set(name, validator);
		}

		const collections = await Promise.all(
			names.map(async (name) => {
				const docs = await db
					.collection(name)
					.aggregate([{ $sample: { size: sampleSize } }])
					.toArray();
				const inferred = inferCollection(name, docs as SampledDoc[]);
				return mergeValidatorFields(inferred, validatorByName.get(name));
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

		return {
			engine: "mongodb",
			collections,
			relations: inferRelations(collections),
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
	for (const [propName, propRaw] of Object.entries(properties)) {
		if (known.has(propName)) continue;
		const bsonType = (propRaw as { bsonType?: unknown }).bsonType;
		const type =
			typeof bsonType === "string"
				? (BSON_TYPE_TO_SNQL[bsonType] ?? "unknown")
				: "unknown";
		declared.push({
			name: propName,
			type,
			nullable: !required.has(propName),
			source: "declared"
		});
	}
	if (declared.length === 0) return inferred;
	return { ...inferred, fields: [...inferred.fields, ...declared] };
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
