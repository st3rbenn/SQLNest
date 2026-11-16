import type { NativeQuery, ResultSet, SnqlType } from "@sqlnest/snql";
import { type Collection, type Document, UUID } from "mongodb";
import { EngineExecutionError } from "../errors";
import { hydrateBson, normalizeBson } from "./bson";
import type { MongoContext } from "./context";
import { storeRefs } from "./ddl-refs";
import {
	BOOL_FALSE,
	BOOL_TRUE,
	convertValue,
	declaredTypeOf,
	toDeclaredType
} from "./declared-types";
import { storeDefault } from "./defaults";
import { describeMongoExecutionError } from "./execution-errors";
import { loadPkAliases } from "./introspect";
import { metadataCollection } from "./metadata";

/**
 * DDL émulé — colonnes : ajouter, renommer, modifier, supprimer.
 */

/**
 * `updateMany` par lots de 10 000 `_id` (ADR-029 D10) : chaque update reste
 * court, 50 ms entre deux lots, plafond de 10 M documents. `update` doit faire
 * sortir le document de `filter`, sinon la boucle repasse dessus.
 */
async function updateInBatches(
	col: Collection,
	filter: Document,
	update: Document | Document[],
	capMessage: (max: number) => string
): Promise<void> {
	const BATCH_SIZE = 10_000;
	const MAX_ROWS = 10_000_000;
	const THROTTLE_MS = 50;
	let total = 0;
	for (;;) {
		const batch = await col
			.find(filter, { projection: { _id: 1 } })
			.limit(BATCH_SIZE)
			.toArray();
		if (batch.length === 0) return;
		const ids = batch.map((d) => d._id);
		await col.updateMany({ _id: { $in: ids } }, update);
		total += batch.length;
		if (total >= MAX_ROWS) {
			throw new EngineExecutionError(capMessage(MAX_ROWS));
		}
		await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS));
	}
}

/** Type `bsonType` d'une property, `null` retiré d'une union `[t, "null"]`. */
function withoutNull(bsonType: unknown): string | null | undefined {
	if (typeof bsonType === "string") return bsonType;
	if (!Array.isArray(bsonType)) return undefined;
	const rest = bsonType.filter((t) => t !== "null");
	return typeof rest[0] === "string" ? rest[0] : undefined;
}

/** Sentinelle d'une valeur non convertible dans les expressions de conversion. */
const UNCONVERTIBLE = "__snql_unconvertible__";

/** Cible `$convert` et alias `$type` par type SNQL convertible côté serveur. */
const MONGO_CONVERT: Partial<Record<SnqlType, string>> = {
	string: "string",
	int: "int",
	bigint: "long",
	float: "double",
	decimal: "decimal",
	bool: "bool",
	date: "date",
	enum: "string"
};

/** Valeur convertie, ou `UNCONVERTIBLE`. `null` reste `null`. */
function convertExpr(field: string, type: SnqlType, to: string): Document {
	const input = `$${field}`;
	const convert = {
		$convert: { input, to, onError: UNCONVERTIBLE, onNull: null }
	};
	if (type !== "bool") return convert;
	const word = { $toLower: { $trim: { input } } };
	return {
		$cond: [
			{ $eq: [{ $type: input }, "string"] },
			{
				$switch: {
					branches: [
						// biome-ignore lint/suspicious/noThenProperty: syntaxe de $switch
						{ case: { $in: [word, BOOL_TRUE] }, then: true },
						// biome-ignore lint/suspicious/noThenProperty: syntaxe de $switch
						{ case: { $in: [word, BOOL_FALSE] }, then: false }
					],
					default: UNCONVERTIBLE
				}
			},
			convert
		]
	};
}

/**
 * Convertit `field` vers le type cible d'un `set type`, après un préflight
 * qui refuse s'il reste des valeurs non convertibles (ADR-036 D3). uuid et
 * json passent côté adapter (`$convert` ne sait pas les produire en Mongo 7).
 */
async function convertFieldType(
	col: Collection,
	collection: string,
	field: string,
	action: {
		readonly type: SnqlType;
		readonly bsonType: string | null;
		readonly pattern?: string;
		readonly enumMembers?: readonly string[];
	}
): Promise<void> {
	const present = { [field]: { $exists: true, $ne: null } };
	const refuse = (count: number, sample: unknown): never => {
		throw new EngineExecutionError(
			`${count} docs de '${collection}' ont une valeur de '${field}' non convertible en ${action.type} (ex. ${JSON.stringify(normalizeBson(sample))}) — corrige-les d'abord, puis relance alter column ${collection}.${field} set type`
		);
	};
	const capMessage = (max: number): string =>
		`alter column ${field} sur '${collection}' : la conversion dépasse le cap ${max} docs — relance la commande, elle reprend où elle s'est arrêtée`;

	// Un uuid ou un decimal rangé en texte passe par l'adapter (forme canonique).
	const to =
		action.pattern === undefined ? MONGO_CONVERT[action.type] : undefined;
	if (to !== undefined) {
		const converted = convertExpr(field, action.type, to);
		const invalid: Document[] = [{ $eq: [converted, UNCONVERTIBLE] }];
		if (action.enumMembers !== undefined) {
			invalid.push({ $not: [{ $in: [converted, [...action.enumMembers]] }] });
		}
		const bad = { ...present, $expr: { $or: invalid } };
		const count = await col.countDocuments(bad);
		if (count > 0) {
			const sample = await col.findOne(bad, { projection: { [field]: 1 } });
			refuse(count, (sample as Document | null)?.[field]);
		}
		await updateInBatches(
			col,
			{
				...present,
				[field]: { $exists: true, $ne: null, $not: { $type: to } }
			},
			[{ $set: { [field]: converted } }],
			capMessage
		);
		return;
	}

	// uuid / json / array : conversion côté adapter, un document à la fois.
	const declared = declaredTypeOf(action.bsonType, action.pattern) ?? "";
	const parse = (value: unknown) => convertValue(value, declared);
	let count = 0;
	let sample: unknown;
	for await (const doc of col.find(present, { projection: { [field]: 1 } })) {
		if (!parse((doc as Document)[field]).ok) {
			count += 1;
			sample ??= (doc as Document)[field];
		}
	}
	if (count > 0) refuse(count, sample);
	for await (const doc of col.find(present, { projection: { [field]: 1 } })) {
		const current = (doc as Document)[field];
		const next = parse(current).value;
		if (next !== current) {
			await col.updateOne(
				{ _id: (doc as Document)._id },
				{ $set: { [field]: next } }
			);
		}
	}
}

/** `required` d'un `$jsonSchema` : Mongo refuse une liste vide, la clé saute. */
function withRequired(schema: Document, required: readonly string[]): Document {
	const { required: _previous, ...rest } = schema;
	return required.length > 0
		? { ...rest, required: [...new Set(required)] }
		: rest;
}

function renameInList(list: unknown, from: string, to: string): string[] {
	if (!Array.isArray(list)) return [];
	return list.map((name) => (name === from ? to : String(name)));
}

/** Renomme récursivement les clés égales à `from` (clés d'index, filtre partiel). */
function renameKeysDeep(value: unknown, from: string, to: string): unknown {
	if (Array.isArray(value))
		return value.map((v) => renameKeysDeep(v, from, to));
	if (value === null || typeof value !== "object" || value instanceof Date)
		return value;
	if ((value as { _bsontype?: unknown })._bsontype !== undefined) return value;
	return Object.fromEntries(
		Object.entries(value).map(([k, v]) => [
			k === from ? to : k,
			renameKeysDeep(v, from, to)
		])
	);
}

/**
 * Recrée sur `to` chaque index qui porte `from` (clé ou filtre partiel), avec
 * les mêmes options. Le nom suit le champ quand il le contient (`phone_1`,
 * `unique_phone`, `idx_agency_phone`) : le nouvel index existe avant que
 * l'ancien disparaisse. Un nom sans le champ est gardé : l'ancien est alors
 * supprimé juste avant. Les index texte (créés hors SNQL) ne sont pas recréés.
 * `names` : noms imposés par un profil ORM (ADR-036 D6), prioritaires.
 */
async function renameFieldInIndexes(
	col: Collection,
	from: string,
	to: string,
	names: ReadonlyMap<string, string>
): Promise<void> {
	for (const index of await col.listIndexes().toArray()) {
		const { v: _v, key, name, ns: _ns, ...options } = index as Document;
		const keys = key as Document;
		if (Object.hasOwn(keys, "_fts")) continue;
		const inFilter =
			options.partialFilterExpression !== undefined &&
			JSON.stringify(
				renameKeysDeep(options.partialFilterExpression, from, to)
			) !== JSON.stringify(options.partialFilterExpression);
		if (!Object.hasOwn(keys, from) && !inFilter) continue;
		const newKeys = renameKeysDeep(keys, from, to) as Document;
		if (options.partialFilterExpression !== undefined) {
			options.partialFilterExpression = renameKeysDeep(
				options.partialFilterExpression,
				from,
				to
			);
		}
		const newName =
			names.get(String(name)) ??
			String(name).replace(new RegExp(`(^|_)${from}(?=_|$)`, "g"), `$1${to}`);
		if (newName !== name) {
			await col.createIndex(newKeys, { ...options, name: newName });
			await col.dropIndex(name);
		} else {
			await col.dropIndex(name);
			await col.createIndex(newKeys, { ...options, name });
		}
	}
}

/**
 * `rename column` Mongo (ADR-036 E/1b). Copier puis retirer plutôt que
 * `$rename` : un index unique sur l'ancien champ verrait sinon les
 * documents déjà renommés comme des doublons `null`. Chaque temps ne
 * touche que ce qui reste à faire : une interruption se reprend en
 * relançant la commande.
 *  1. Le validateur décrit les deux noms, `required` passe au nouveau.
 *  2. Copie de l'ancien champ vers le nouveau, par lots.
 *  3. Index recréés sur le nouveau champ, puis anciens supprimés.
 *  4. Ancien champ retiré, par lots.
 *  5. Validateur final sans l'ancien nom, `_snql_refs` réécrit (et les FK
 *     renommées par un profil ORM).
 * Un document dont les deux champs ont des valeurs différentes est refusé :
 * la copie écraserait la valeur du nouveau.
 */
export async function executeDDLRenameColumn(
	cx: MongoContext,
	query: Extract<NativeQuery, { kind: "mongo-ddl"; operation: "rename-column" }>
): Promise<ResultSet> {
	const db = cx.db();
	const col = db.collection(query.collection);
	const { column: from, newName: to } = query;
	try {
		const info = (
			await db.listCollections({ name: query.collection }).toArray()
		)[0] as
			| { readonly options?: { readonly validator?: Document } }
			| undefined;
		if (info === undefined) {
			throw new EngineExecutionError(
				`rename column échouée : collection '${query.collection}' inexistante`
			);
		}
		const clash = await col.countDocuments({
			[from]: { $exists: true },
			[to]: { $exists: true },
			$expr: { $ne: [`$${from}`, `$${to}`] }
		});
		if (clash > 0) {
			throw new EngineExecutionError(
				`${clash} docs de '${query.collection}' ont déjà '${to}' en plus de '${from}' — le renommage écraserait leur '${to}' ; vide l'un des deux d'abord, par exemple : update ${query.collection} where ${to} != null set ${to} = null, puis relance rename column`
			);
		}

		const validator = info.options?.validator;
		const jsonSchema = validator?.$jsonSchema as Document | undefined;
		// `primary key (id)` n'écrit pas `id` au validateur : c'est l'alias de
		// `_id` (ADR-029 D13), dont le nom est fixe. Renommer l'alias
		// réécrirait les FK qui le visent et casserait leur résolution vers `_id`.
		const declared = jsonSchema?.properties as Document | undefined;
		const aliased =
			(await loadPkAliases(db)).get(query.collection)?.column === from;
		if (
			aliased ||
			(from === "id" &&
				jsonSchema !== undefined &&
				!Object.hasOwn(declared ?? {}, "id") &&
				(await col.countDocuments({ id: { $exists: true } }, { limit: 1 })) ===
					0)
		) {
			throw new EngineExecutionError(
				`rename column échouée : '${query.collection}.id' est l'alias de '_id', la clé primaire native de Mongo — son nom est fixe`
			);
		}
		const setSchema = async (schema: Document): Promise<void> => {
			await db.command({
				collMod: query.collection,
				validator: { ...validator, $jsonSchema: schema }
			});
		};
		if (jsonSchema !== undefined) {
			const properties = { ...(jsonSchema.properties as Document | undefined) };
			if (Object.hasOwn(properties, from) && !Object.hasOwn(properties, to)) {
				properties[to] = properties[from];
			}
			await setSchema(
				withRequired(
					{ ...jsonSchema, properties },
					renameInList(jsonSchema.required, from, to)
				)
			);
		}

		const capMessage = (max: number): string =>
			`rename column ${from} sur '${query.collection}' : le renommage dépasse le cap ${max} docs — relance la commande, elle reprend où elle s'est arrêtée`;
		await updateInBatches(
			col,
			{ [from]: { $exists: true }, [to]: { $exists: false } },
			[{ $set: { [to]: `$${from}` } }],
			capMessage
		);
		const renames = query.renames ?? [];
		await renameFieldInIndexes(
			col,
			from,
			to,
			new Map(
				renames.filter((r) => r.kind === "index").map((r) => [r.from, r.to])
			)
		);
		await updateInBatches(
			col,
			{ [from]: { $exists: true } },
			{ $unset: { [from]: "" } },
			capMessage
		);

		if (jsonSchema !== undefined) {
			const properties = { ...(jsonSchema.properties as Document | undefined) };
			if (Object.hasOwn(properties, from)) {
				properties[to] = properties[from];
				delete properties[from];
			}
			await setSchema(
				withRequired(
					{ ...jsonSchema, properties },
					renameInList(jsonSchema.required, from, to)
				)
			);
		}

		const defaults = metadataCollection(db, "_snql_defaults");
		const fromId = `${query.collection}.${from}`;
		const entry = await defaults.findOne({ _id: fromId });
		if (entry !== null) {
			const { _id: _old, ...rest } = entry;
			await defaults.replaceOne(
				{ _id: `${query.collection}.${to}` },
				{ ...rest, column: to },
				{ upsert: true }
			);
			await defaults.deleteOne({ _id: fromId });
		}
		const refs = metadataCollection(db, "_snql_refs");
		await refs.updateMany(
			{ fromCollection: query.collection, fromColumn: from },
			{ $set: { fromColumn: to } }
		);
		await refs.updateMany(
			{ toCollection: query.collection, toColumn: from },
			{ $set: { toColumn: to } }
		);
		// FK nommées par le profil ORM : `_id` = nom, réinséré sous le nouveau.
		for (const r of renames) {
			if (r.kind !== "foreign-key") continue;
			const ref = await refs.findOne({ _id: r.from });
			if (ref === null) continue;
			await refs.replaceOne(
				{ _id: r.to },
				{ ...ref, _id: r.to },
				{ upsert: true }
			);
			await refs.deleteOne({ _id: r.from });
		}
		return { columns: [], rows: [], rowCount: 0 };
	} catch (cause) {
		if (cause instanceof EngineExecutionError) throw cause;
		throw new EngineExecutionError(
			`rename column MongoDB échouée sur '${query.collection}.${from}' — ${describeMongoExecutionError(cause)}`,
			{ cause }
		);
	}
}

/**
 * `alter column` Mongo (ADR-036 E/1c).
 *  - `set nullable` : le validateur accepte `null`, le champ quitte `required`.
 *  - `set not null` : préflight des documents nuls ou sans le champ (refus
 *    avec commande copiable, ADR-029 D2), puis validateur.
 *  - `set type` : préflight des valeurs non convertibles (refus avec leur
 *    nombre et un exemple), conversion par lots, puis validateur. Les
 *    documents déjà convertis sont sautés : la commande se relance.
 */
export async function executeDDLAlterColumn(
	cx: MongoContext,
	query: Extract<NativeQuery, { kind: "mongo-ddl"; operation: "alter-column" }>
): Promise<ResultSet> {
	const db = cx.db();
	const col = db.collection(query.collection);
	const { column: field, action } = query;
	try {
		const info = (
			await db.listCollections({ name: query.collection }).toArray()
		)[0] as
			| { readonly options?: { readonly validator?: Document } }
			| undefined;
		if (info === undefined) {
			throw new EngineExecutionError(
				`alter column échouée : collection '${query.collection}' inexistante`
			);
		}
		const validator = info.options?.validator;
		const jsonSchema = (validator?.$jsonSchema as Document | undefined) ?? {
			bsonType: "object"
		};
		const properties = { ...(jsonSchema.properties as Document | undefined) };
		const property: Document = {
			...(properties[field] as Document | undefined)
		};
		if (action.kind === "set-default" || action.kind === "drop-default") {
			// Comme en SQL : le défaut vaut pour les insertions à venir, les
			// documents existants ne changent pas.
			if (action.kind === "set-default") {
				await storeDefault(cx, query.collection, {
					column: field,
					...(action.fn !== undefined
						? { fn: action.fn }
						: { value: action.value })
				});
			} else {
				await metadataCollection(db, "_snql_defaults").deleteOne({
					_id: `${query.collection}.${field}`
				});
			}
			return { columns: [], rows: [], rowCount: 0 };
		}
		let required = Array.isArray(jsonSchema.required)
			? jsonSchema.required.map(String)
			: [];
		const nullable = !required.includes(field);
		// Sans validateur, un champ Mongo accepte déjà `null` : rien à poser.
		if (action.kind === "set-nullable" && validator === undefined) {
			return { columns: [], rows: [], rowCount: 0 };
		}

		if (action.kind === "set-not-null") {
			const missing = await col.countDocuments({
				$or: [{ [field]: { $exists: false } }, { [field]: null }]
			});
			if (missing > 0) {
				throw new EngineExecutionError(
					`${missing} docs de '${query.collection}' ont '${field}' nul ou absent — exécute d'abord : update ${query.collection} where ${field} = null set ${field} = <val>, puis relance alter column ${query.collection}.${field} set not null`
				);
			}
		}
		if (action.kind === "set-type") {
			// Le validateur garde l'ancien type tant que la conversion tourne :
			// il le lâche d'abord, le nouveau est posé à la fin.
			if (validator !== undefined && properties[field] !== undefined) {
				const {
					bsonType: _type,
					enum: _enum,
					pattern: _pattern,
					...untyped
				} = property;
				await db.command({
					collMod: query.collection,
					validator: {
						...validator,
						$jsonSchema: {
							...jsonSchema,
							properties: { ...properties, [field]: untyped }
						}
					}
				});
			}
			await convertFieldType(col, query.collection, field, action);
		}

		const bsonType =
			action.kind === "set-type"
				? action.bsonType
				: withoutNull(property.bsonType);
		const enumMembers =
			action.kind === "set-type"
				? action.enumMembers
				: (property.enum as unknown[] | undefined)?.filter((m) => m !== null);
		const stayNullable =
			action.kind === "set-nullable"
				? true
				: action.kind === "set-not-null"
					? false
					: nullable;
		delete property.bsonType;
		delete property.enum;
		if (action.kind === "set-type") {
			delete property.pattern;
			if (action.pattern !== undefined) property.pattern = action.pattern;
		}
		if (bsonType !== null && bsonType !== undefined) {
			property.bsonType = stayNullable ? [bsonType, "null"] : bsonType;
		} else if (!stayNullable) {
			property.not = { bsonType: "null" };
		}
		if (stayNullable) delete property.not;
		if (enumMembers !== undefined) {
			property.enum = stayNullable ? [...enumMembers, null] : [...enumMembers];
		}
		properties[field] = property;
		required = required.filter((name) => name !== field);
		if (!stayNullable) required.push(field);
		await db.command({
			collMod: query.collection,
			validator: {
				...validator,
				$jsonSchema: withRequired({ ...jsonSchema, properties }, required)
			}
		});
		return { columns: [], rows: [], rowCount: 0 };
	} catch (cause) {
		if (cause instanceof EngineExecutionError) throw cause;
		throw new EngineExecutionError(
			`alter column MongoDB échouée sur '${query.collection}.${field}' — ${describeMongoExecutionError(cause)}`,
			{ cause }
		);
	}
}

/**
 * DDL/4 drop column Mongo (ADR-029). Compensation runtime miroir strict de
 * executeDDLAddColumn D10 backfill :
 *  1. Lit le validator existant via listCollections. Si `ifExists=true`
 *     et property absente : no-op silencieux (D3 name-only).
 *  2. collMod avec validator sans la property + retire de `required` si
 *     présent.
 *  3. `updateMany({[col]: {$exists:true}}, {$unset: {[col]: ""}})` batched
 *     pattern id-batch identique add-column D10 — cap MAX_ROWS 10M +
 *     throttle 50ms. Jamais refus (PA/1-8).
 */
export async function executeDDLDropColumn(
	cx: MongoContext,
	query: Extract<NativeQuery, { kind: "mongo-ddl"; operation: "drop-column" }>
): Promise<ResultSet> {
	const db = cx.db();
	const col = db.collection(query.collection);
	const fieldName = query.column;
	try {
		const collInfoCursor = db.listCollections({ name: query.collection });
		const collInfoArr = await collInfoCursor.toArray();
		const existingInfo = collInfoArr[0] as
			| { readonly options?: { readonly validator?: Record<string, unknown> } }
			| undefined;
		if (existingInfo === undefined) {
			if (query.ifExists) {
				return { columns: [], rows: [], rowCount: 0 };
			}
			throw new EngineExecutionError(
				`drop column échouée : collection '${query.collection}' inexistante`
			);
		}
		const existingValidator = existingInfo.options?.validator ?? {};
		const existingJsonSchema = (
			existingValidator as { $jsonSchema?: Record<string, unknown> }
		).$jsonSchema ?? { bsonType: "object", properties: {}, required: [] };
		const existingProperties =
			(existingJsonSchema as { properties?: Record<string, unknown> })
				.properties ?? {};
		const existingRequired = ((existingJsonSchema as { required?: string[] })
			.required ?? []) as string[];

		// D3 name-only : property absente = no-op silencieux si ifExists.
		if (!Object.hasOwn(existingProperties, fieldName)) {
			if (query.ifExists) {
				return { columns: [], rows: [], rowCount: 0 };
			}
		}

		// Comme PG : une FK d'une autre collection qui la référence fait
		// échouer ; ses index et les FK qu'elle porte partent avec elle.
		const refs = metadataCollection(db, "_snql_refs");
		const inbound = await refs
			.find({ toCollection: query.collection, toColumn: fieldName })
			.toArray();
		if (inbound.length > 0) {
			throw new EngineExecutionError(
				`drop column échouée : '${query.collection}.${fieldName}' est référencée par ${inbound.map((r) => r._id).join(", ")}`
			);
		}
		// Avant la purge : un index unique verrait des doublons de champ absent.
		for (const index of await col.listIndexes().toArray()) {
			const key = (index as { key?: Record<string, unknown> }).key ?? {};
			if (index.name !== "_id_" && Object.hasOwn(key, fieldName)) {
				await col.dropIndex(String(index.name));
			}
		}

		// collMod validator sans la property + retire required.
		const newProperties: Record<string, unknown> = { ...existingProperties };
		delete newProperties[fieldName];
		const newRequired = existingRequired.filter((r) => r !== fieldName);
		const newJsonSchema: Record<string, unknown> = {
			bsonType: "object",
			properties: newProperties
		};
		if (newRequired.length > 0) newJsonSchema["required"] = newRequired;
		await db.command({
			collMod: query.collection,
			validator: { $jsonSchema: newJsonSchema }
		});

		// D10-miroir $unset batched : purge la valeur dans chaque doc existant.
		await updateInBatches(
			col,
			{ [fieldName]: { $exists: true } },
			{ $unset: { [fieldName]: "" } },
			(max) =>
				`drop column ${fieldName} sur '${query.collection}' : purge dépasse le cap ${max} docs — augmente mongo.ddl.backfill_max_rows ou purge offline`
		);
		await metadataCollection(db, "_snql_defaults").deleteOne({
			_id: `${query.collection}.${fieldName}`
		});
		await refs.deleteMany({
			fromCollection: query.collection,
			fromColumn: fieldName
		});

		return { columns: [], rows: [], rowCount: 0 };
	} catch (cause) {
		if (cause instanceof EngineExecutionError) throw cause;
		throw new EngineExecutionError(
			`drop column MongoDB échouée sur '${query.collection}.${fieldName}' — ${describeMongoExecutionError(cause)}`,
			{ cause }
		);
	}
}

/**
 * DDL/2 add column Mongo (ADR-029 D2 + D10). Séquence :
 *  1. D2 preflight : si `preflightNotNull=true`, `countDocuments({[col]:
 *     {$exists:false}})` — refus runtime typé si > 0 avec message copiable
 *     actionnable pointant vers update-first (pattern PA/5).
 *  2. Lit le validator existant via `listCollections` + merge la nouvelle
 *     property (`bsonType` + `required` étendu) + `collMod` — écrire un
 *     validator ex nihilo écraserait les contraintes créées par
 *     `create-collection`, on merge.
 *  3. D10 backfill : si `backfill=true`, `updateMany` batched — pattern
 *     find({$exists:false}, {_id:1}).limit(batch) + updateMany({_id:{$in}}).
 *     50ms throttle inter-batches. Cap `MAX_ROWS` défaut 10M → diagnostic
 *     scale (non-bloquant, mais on stoppe et remonte pour ne pas bloquer
 *     la connection HTTP indéfiniment).
 *  4. Si `index` présent (add column ... unique), createIndex secondaire.
 * Idempotence D3 : `ifNotExists=true` skip si le field existe déjà dans le
 * validator (name-only).
 */
export async function executeDDLAddColumn(
	cx: MongoContext,
	query: Extract<NativeQuery, { kind: "mongo-ddl"; operation: "add-column" }>
): Promise<ResultSet> {
	const db = cx.db();
	const col = db.collection(query.collection);
	const fieldName = query.column.name;
	try {
		// Lit le validator existant pour merger la nouvelle property. Pattern
		// listCollections filter par nom + nameOnly:false.
		const collInfoCursor = db.listCollections({ name: query.collection });
		const collInfoArr = await collInfoCursor.toArray();
		const existingInfo = collInfoArr[0] as
			| { readonly options?: { readonly validator?: Record<string, unknown> } }
			| undefined;
		if (existingInfo === undefined) {
			throw new EngineExecutionError(
				`add column échouée : collection '${query.collection}' inexistante — utilise 'create table' avant`
			);
		}
		const existingValidator = existingInfo.options?.validator ?? {};
		const existingJsonSchema = (
			existingValidator as { $jsonSchema?: Record<string, unknown> }
		).$jsonSchema ?? { bsonType: "object", properties: {}, required: [] };
		const existingProperties =
			(existingJsonSchema as { properties?: Record<string, unknown> })
				.properties ?? {};
		const existingRequired = ((existingJsonSchema as { required?: string[] })
			.required ?? []) as string[];

		// D3 : idempotence name-only. Field présent = no-op silencieux.
		if (query.ifNotExists && Object.hasOwn(existingProperties, fieldName)) {
			return { columns: [], rows: [], rowCount: 0 };
		}

		// D2 preflight : NOT NULL sans default = compte les docs sans le field.
		// Message copiable actionnable (contrat ADR-029 D2).
		if (query.preflightNotNull) {
			const orphanCount = await col.countDocuments({
				[fieldName]: { $exists: false }
			});
			if (orphanCount > 0) {
				throw new EngineExecutionError(
					`${orphanCount} docs sans '${fieldName}' — exécute d'abord : update ${query.collection} where ${fieldName} = null set ${fieldName} = <val>, puis relance add column not null`
				);
			}
		}

		// Le remplissage écrit au type de la colonne (ADR-029 D15), contrôlé
		// avant que le validateur change.
		const declared = declaredTypeOf(
			query.column.bsonType,
			query.column.pattern
		);
		const typed = (value: unknown): unknown =>
			declared === undefined
				? value
				: toDeclaredType(
						value,
						declared,
						fieldName,
						`add column dans '${query.collection}'`
					);
		const backfillValue =
			query.backfill && query.column.defaultFn === undefined
				? typed(query.column.defaultValue)
				: undefined;

		// collMod avec validator mergé : ajoute la nouvelle property + étend
		// `required` si NOT NULL. Préserve les autres contraintes existantes.
		const newProperty: Record<string, unknown> = {};
		if (query.column.bsonType !== null) {
			// Nullable (= non required) → autorise `null` dans le validator,
			// sinon `add {col: null}` + `on delete set null` FK échouent
			// « Document failed validation » (ADR-031, miroir buildMongoFieldProperty).
			newProperty["bsonType"] = query.column.required
				? query.column.bsonType
				: [query.column.bsonType, "null"];
		}
		if (query.column.pattern !== undefined) {
			newProperty.pattern = query.column.pattern;
		}
		if (query.column.enum !== undefined) {
			newProperty.enum = query.column.required
				? [...query.column.enum]
				: [...query.column.enum, null];
		}
		const newProperties = {
			...existingProperties,
			[fieldName]: newProperty
		};
		const requiredSet = new Set(existingRequired);
		if (query.column.required) requiredSet.add(fieldName);
		const newRequired = [...requiredSet];
		const newJsonSchema: Record<string, unknown> = {
			bsonType: "object",
			properties: newProperties
		};
		if (newRequired.length > 0) newJsonSchema["required"] = newRequired;
		await db.command({
			collMod: query.collection,
			validator: { $jsonSchema: newJsonSchema }
		});

		// D10 backfill : updateMany batched avec throttle. Pattern id-batch
		// évite le lock long — on ne cible que N docs sans le field à la
		// fois, chaque update est court. Cap MAX_ROWS pour ne pas bloquer
		// la connection indéfiniment sur une collection énorme.
		if (query.backfill) {
			const missing = { [fieldName]: { $exists: false } };
			const capMessage = (max: number): string =>
				`add column ${fieldName} sur '${query.collection}' : backfill dépasse le cap ${max} docs — augmente mongo.ddl.backfill_max_rows ou pré-init les rows via update batché offline`;
			if (query.column.defaultFn === "uuid") {
				// Un uuid distinct par document : pas d'expression serveur.
				for await (const doc of col.find(missing, { projection: { _id: 1 } })) {
					await col.updateOne(
						{ _id: (doc as Document)._id },
						{ $set: { [fieldName]: typed(new UUID()) } }
					);
				}
			} else {
				await updateInBatches(
					col,
					missing,
					query.column.defaultFn === "now"
						? [{ $set: { [fieldName]: "$$NOW" } }]
						: { $set: { [fieldName]: hydrateBson(backfillValue, false) } },
					capMessage
				);
			}
			await storeDefault(cx, query.collection, {
				column: fieldName,
				...(query.column.defaultFn !== undefined
					? { fn: query.column.defaultFn }
					: { value: query.column.defaultValue })
			});
		}

		// Index unique secondaire optionnel (add column ... unique).
		if (query.index !== undefined) {
			const options: Record<string, unknown> = {};
			if (query.index.options.unique === true) options["unique"] = true;
			if (query.index.options.name !== undefined)
				options["name"] = query.index.options.name;
			await col.createIndex(query.index.keys, options);
		}

		// FK déclarée sur la colonne (ADR-031 FK/1a) → `_snql_refs`.
		if (query.column.ref !== undefined) {
			await storeRefs(cx, [query.column.ref]);
		}

		return { columns: [], rows: [], rowCount: 0 };
	} catch (cause) {
		// EngineExecutionError propres (preflight / cap) déjà typées — re-throw sans wrap.
		if (cause instanceof EngineExecutionError) throw cause;
		throw new EngineExecutionError(
			`add column MongoDB échouée sur '${query.collection}.${fieldName}' — ${describeMongoExecutionError(cause)}`,
			{ cause }
		);
	}
}
