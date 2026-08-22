import type {
	Collection,
	Field,
	Relation,
	SchemaModel,
	SnqlType
} from "@sqlnest/snql";
import type { Db } from "mongodb";
import { EngineIntrospectionError } from "../errors";

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
		const infos = await db.listCollections({}, { nameOnly: true }).toArray();
		const names = infos
			.map((info) => info.name)
			.filter((name) => !name.startsWith("system."));

		const collections = await Promise.all(
			names.map(async (name) => {
				const docs = await db
					.collection(name)
					.aggregate([{ $sample: { size: sampleSize } }])
					.toArray();
				return inferCollection(name, docs as SampledDoc[]);
			})
		);

		return {
			engine: "mongodb",
			collections,
			relations: inferRelations(collections)
		};
	} catch (cause) {
		throw new EngineIntrospectionError("Introspection MongoDB échouée", {
			cause
		});
	}
}
