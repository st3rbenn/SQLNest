import type {
	NativeQuery,
	ResultColumn,
	ResultSet,
	Row,
	SchemaModel
} from "@sqlnest/snql";
import { isSqlDecimal, MONGODB_CAPABILITIES } from "@sqlnest/snql";
import type { Db, Document } from "mongodb";
import { Decimal128, Long, MongoClient, ObjectId } from "mongodb";
import type {
	Connection,
	EngineAdapter,
	PingResult,
	ResolvedEngineConfig
} from "../adapter";
import {
	ConnectionClosedError,
	EngineConfigError,
	EngineConnectionError,
	EngineExecutionError
} from "../errors";
import { describeMongoConfig } from "./config";
import { introspectMongo } from "./introspect";

const SERVER_SELECTION_TIMEOUT_MS = 10_000;

/**
 * Normalise une valeur BSON en scalaire portable, pour respecter le contrat de
 * ResultSet « normalisé » : là où Postgres renvoie des scalaires, le driver Mongo
 * renvoie des objets BSON (ObjectId, Decimal128, Long, Timestamp…). On les ramène
 * à string/number/bigint (cohérent cross-moteur) ; Date reste un Date (comme pg).
 */
export function normalizeBson(value: unknown): unknown {
	if (value === null || typeof value !== "object") {
		return value;
	}
	const bsontype = (value as { readonly _bsontype?: string })._bsontype;
	if (bsontype !== undefined) {
		if (bsontype === "Long") {
			const text = String(value);
			const asNumber = Number(text);
			return Number.isSafeInteger(asNumber) ? asNumber : BigInt(text);
		}
		if (bsontype === "Int32" || bsontype === "Double") {
			return Number(String(value));
		}
		// ObjectId, Decimal128, UUID, Binary, Timestamp… → texte (comme pg pour
		// numeric/uuid/etc.). Decimal128 devient une chaîne décimale exacte.
		return String(value);
	}
	if (value instanceof Date) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(normalizeBson);
	}
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		out[key] = normalizeBson((value as Record<string, unknown>)[key]);
	}
	return out;
}

const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;

/**
 * Hydrate les valeurs produites par le codegen (pur, sans dépendance BSON) avant
 * de les passer au driver — l'inverse de {@link normalizeBson} :
 *  - marqueur SqlDecimal → **Decimal128** (décimal exact ; un `Number()` serait lossy) ;
 *  - `bigint` → **Long** (int64 ; le codegen refuse déjà les valeurs hors plage) ;
 *  - dans un FILTRE, une chaîne 24-hex comparée au champ `_id` → **ObjectId**. La
 *    lecture normalise ObjectId→chaîne ; sans cet inverse, `where _id = "…"` ne
 *    matcherait jamais, et `where _id != "…"` matcherait TOUT (→ collection vidée).
 *
 * `inId` suit la position sous une clé `_id` : hérité par les opérateurs
 * (`$eq`/`$in`/`$nin`…), réinitialisé par tout autre champ. `filter` active la
 * coercion `_id` — passé `true` pour les filtres ET les documents insérés (round-trip
 * cohérent : ce qu'on stocke sous `_id` est ce qu'un filtre `_id` retrouvera).
 */
export function hydrateBson(
	value: unknown,
	filter: boolean,
	inId = false
): unknown {
	if (isSqlDecimal(value)) {
		return Decimal128.fromString(value.raw);
	}
	if (typeof value === "bigint") {
		return Long.fromBigInt(value);
	}
	if (typeof value === "string") {
		return filter && inId && OBJECT_ID_HEX.test(value)
			? new ObjectId(value)
			: value;
	}
	if (value === null || typeof value !== "object" || value instanceof Date) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((item) => hydrateBson(item, filter, inId));
	}
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		const childInId =
			key === "_id" ? filter : key.startsWith("$") ? inId : false;
		out[key] = hydrateBson(child, filter, childInId);
	}
	return out;
}

/**
 * Message d'erreur d'écriture. Pour un `insert`, `insertMany` est **ordonné**
 * (comme il n'y a pas de transaction sur un Mongo standalone) : un échec en cours
 * de lot laisse les documents précédents insérés — contrairement à Postgres,
 * atomique. On expose donc le compteur partiel pour que l'utilisateur sache
 * combien de documents ont atterri (et ne re-lance pas à l'aveugle en dupliquant).
 */
function writeErrorMessage(op: string, cause: unknown): string {
	const detail = describeMongoExecutionError(cause);
	if (op === "insert") {
		const inserted = (cause as { result?: { insertedCount?: number } }).result
			?.insertedCount;
		if (typeof inserted === "number" && inserted > 0) {
			return `Écriture MongoDB échouée après ${inserted} document(s) inséré(s) (insert non atomique) — ${detail}`;
		}
	}
	return `Écriture MongoDB échouée — ${detail}`;
}

/**
 * Compose un message utilisable côté UI à partir d'une erreur du driver Mongo.
 * On garde le message natif (ex. `no such collection`, `unknown top-level operator`)
 * et on annote le `codeName` / `code` du driver s'ils sont là.
 */
function describeMongoExecutionError(cause: unknown): string {
	if (!(cause instanceof Error)) {
		return "cause inconnue";
	}
	const props = cause as {
		message: string;
		code?: number | string;
		codeName?: string;
	};
	const parts: string[] = [props.message];
	if (typeof props.codeName === "string" && props.codeName.length > 0) {
		parts.push(props.codeName);
	} else if (props.code !== undefined) {
		parts.push(`code ${props.code}`);
	}
	return parts.join(" — ");
}

/**
 * Colonnes déduites des lignes (union ordonnée des clés) — Mongo n'a pas de
 * schéma fixe. Types + nullable en fallback safe ; l'enrichissement via
 * `inferResultColumns` se fait dans `run.ts` quand un SchemaModel est
 * disponible côté caller.
 */
function columnsOf(rows: readonly Row[]): ResultColumn[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		for (const key of Object.keys(row)) {
			if (!seen.has(key)) {
				seen.add(key);
				names.push(key);
			}
		}
	}
	return names.map((name) => ({
		name,
		type: "unknown" as const,
		nullable: true
	}));
}

/** Connexion MongoDB : enveloppe un `MongoClient`. */
class MongoConnection implements Connection {
	readonly engine = "mongodb";
	#client: MongoClient | undefined;
	readonly #dbName: string;
	readonly #sampleSize: number;

	constructor(client: MongoClient, dbName: string, sampleSize: number) {
		this.#client = client;
		this.#dbName = dbName;
		this.#sampleSize = sampleSize;
	}

	async ping(): Promise<PingResult> {
		const db = this.#requireDb();
		const start = performance.now();
		try {
			const info = await db.admin().buildInfo();
			const latencyMs = performance.now() - start;
			const version = (info as { version?: unknown }).version;
			return typeof version === "string"
				? { latencyMs, serverVersion: version }
				: { latencyMs };
		} catch (cause) {
			throw new EngineConnectionError("Ping MongoDB : requête échouée", {
				cause
			});
		}
	}

	async introspect(): Promise<SchemaModel> {
		return introspectMongo(this.#requireDb(), this.#sampleSize);
	}

	async execute(query: NativeQuery): Promise<ResultSet> {
		if (query.kind === "mongo-write") {
			return this.#executeWrite(query);
		}
		if (query.kind !== "mongo") {
			throw new EngineExecutionError(
				`Adapter MongoDB : requête native '${query.kind}' non supportée (pipeline attendu)`
			);
		}
		const db = this.#requireDb();
		try {
			// `filter: true` → une chaîne 24-hex comparée à `_id` dans un `$match`
			// redevient un ObjectId (cf. hydrateBson), pour que `where _id = "…"` matche.
			const pipeline = hydrateBson([...query.pipeline], true) as Document[];
			const docs = await db
				.collection(query.collection)
				.aggregate(pipeline)
				.toArray();
			const rows = docs.map((doc) => normalizeBson(doc) as Row);
			return { columns: columnsOf(rows), rows, rowCount: rows.length };
		} catch (cause) {
			throw new EngineExecutionError(
				`Exécution MongoDB échouée — ${describeMongoExecutionError(cause)}`,
				{ cause }
			);
		}
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
	async #executeWrite(
		query: Extract<NativeQuery, { kind: "mongo-write" }>
	): Promise<ResultSet> {
		const collection = this.#requireDb().collection(query.collection);
		try {
			if (query.op === "insert") {
				// `filter: true` → un `_id` fourni en chaîne 24-hex est coercé en
				// ObjectId, de façon COHÉRENTE avec les filtres : sinon `add {_id:"…"}`
				// stockerait une chaîne qu'un `where _id = "…"` (qui, lui, coerce) ne
				// retrouverait jamais. (Renoncer à un _id string 24-hex est un compromis
				// assumé — cas extrême — au profit d'un round-trip cohérent.)
				const documents = query.documents.map(
					(doc) => hydrateBson(doc, true) as Document
				);
				const result = await collection.insertMany(documents);
				// Les documents insérés portent maintenant leur `_id` (le driver le
				// pose sur l'objet) → on peut les rendre, comme un RETURNING *.
				const rows = documents.map((doc) => normalizeBson(doc) as Row);
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
			const filter = hydrateBson(query.filter, true) as Document;
			const result = await collection.deleteMany(filter);
			return { columns: [], rows: [], rowCount: result.deletedCount };
		} catch (cause) {
			throw new EngineExecutionError(writeErrorMessage(query.op, cause), {
				cause
			});
		}
	}

	async close(): Promise<void> {
		const client = this.#client;
		if (client === undefined) {
			return; // idempotent
		}
		this.#client = undefined;
		await client.close();
	}

	#requireDb(): Db {
		if (this.#client === undefined) {
			throw new ConnectionClosedError(this.engine);
		}
		return this.#client.db(this.#dbName);
	}
}

/** Adapter MongoDB (couche connexion). Voir [[Engine Adapter Interface]]. */
export const mongoAdapter: EngineAdapter = {
	id: "mongodb",
	capabilities: MONGODB_CAPABILITIES,

	async connect(config: ResolvedEngineConfig): Promise<Connection> {
		if (config.engine !== "mongodb") {
			throw new EngineConfigError(
				`Adapter MongoDB invoqué avec une config '${config.engine}'`
			);
		}

		// Le constructeur du driver PARSE l'URI (validation autoritaire) et peut
		// lever un MongoParseError → on le garde DANS le try pour l'envelopper en
		// erreur typée + redigée (pas de fuite de l'URI brute).
		let client: MongoClient | undefined;
		try {
			client = new MongoClient(config.url, {
				serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS
			});
			const connection = new MongoConnection(
				client,
				config.database,
				config.sampleSize
			);
			// Fail-fast : établit et vérifie tout de suite.
			await client.connect();
			await connection.ping();
			return connection;
		} catch (error) {
			if (client !== undefined) {
				await client.close().catch(() => {});
			}
			const cause =
				error instanceof EngineConnectionError ? error.cause : error;
			throw new EngineConnectionError(
				`Connexion MongoDB échouée (${describeMongoConfig(config)})`,
				{ cause }
			);
		}
	}
};
