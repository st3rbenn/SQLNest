import type {
	NativeQuery,
	ResultColumn,
	ResultSet,
	Row,
	SchemaModel
} from "@sqlnest/snql";
import { createHash } from "node:crypto";
import { isSqlDecimal, MONGODB_CAPABILITIES } from "@sqlnest/snql";
import type { ClientSession, Db, Document } from "mongodb";
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
import {
	probeMongoFeatures,
	type MongoEngineFeatures,
	type MongoFeatures
} from "./capability-probe";
import { describeMongoConfig } from "./config";
import { inferCollection, introspectMongo, type SampledDoc } from "./introspect";

const SERVER_SELECTION_TIMEOUT_MS = 10_000;

/**
 * Sprint T3/2 : shape stable rendu par `describe <table>`. Identique côté PG
 * (le SQL produit ces mêmes colonnes) → l'UI n'a pas à brancher sur l'engine.
 */
const DESCRIBE_COLUMNS: readonly ResultColumn[] = [
	{ name: "name", type: "string", nullable: false },
	{ name: "type", type: "string", nullable: false },
	{ name: "nullable", type: "bool", nullable: false },
	{ name: "default", type: "string", nullable: true },
	{ name: "is_primary_key", type: "bool", nullable: false },
	{ name: "foreign_key", type: "string", nullable: true }
];

/**
 * Sprint T3/3 : shape stable de `list indexes`. Identique côté PG (le SQL
 * pg_index produit ces mêmes colonnes) → l'UI n'a pas à brancher sur l'engine.
 */
const INDEXES_COLUMNS: readonly ResultColumn[] = [
	{ name: "name", type: "string", nullable: false },
	{ name: "table", type: "string", nullable: false },
	{ name: "unique", type: "bool", nullable: false },
	{ name: "columns", type: "string", nullable: false }
];

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
/**
 * ADR-024 PM/7 D6 — abort de nettoyage tx : codes attendus (à avaler
 * silencieusement) vs codes réseau/timeout (à logger + enrichir l'erreur
 * finale). Les codes attendus signalent que le serveur a déjà avorté la tx :
 *  - `NoSuchTransaction` (251) : session sans tx active (déjà avortée).
 *  - `TransactionNotFound` : idem, variante d'autres versions driver.
 *  - `WriteConflict` (112) : auto-abort après conflit optimistic locking.
 *  - Label `TransientTransactionError` : label driver générique tx retryable.
 */
function isExpectedAbortError(cause: unknown): boolean {
	if (!(cause instanceof Error)) return false;
	const props = cause as {
		code?: number | string;
		codeName?: string;
		errorLabels?: readonly string[];
	};
	if (
		props.codeName === "NoSuchTransaction" ||
		props.codeName === "TransactionNotFound" ||
		props.codeName === "WriteConflict"
	) {
		return true;
	}
	if (props.code === 251 || props.code === 112) {
		return true;
	}
	if (Array.isArray(props.errorLabels) && props.errorLabels.includes("TransientTransactionError")) {
		return true;
	}
	return false;
}

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
/**
 * Sprint T3/4 : normalise le résultat d'un db.runCommand() en Row[]. Les
 * commands Mongo retournent des shapes hétérogènes — on inspecte les champs
 * courants qui portent un batch de docs (`cursor.firstBatch` pour aggregate/
 * find, `values` pour distinct, `results` pour explain). Sinon on renvoie
 * le document entier comme une seule row (le user écrit sa command, il sait).
 */
/**
 * Sprint T3/4 : Mongo exige `cursor` sur les commandes streamées. Sans lui,
 * `db.command({aggregate: ..., pipeline: [...]})` échoue avec « The 'cursor'
 * option is required, except for aggregate with the explain argument ».
 * Whitelist des commandes concernées — pour les autres (drop, insert, count
 * simple, buildInfo, isMaster…), on n'injecte rien.
 */
function needsCursor(command: Record<string, unknown>): boolean {
	return (
		"aggregate" in command || "find" in command || "listCollections" in command || "listIndexes" in command
	);
}

function extractRowsFromRawResponse(raw: Record<string, unknown>): Row[] {
	const cursor = raw["cursor"];
	if (
		cursor !== null &&
		typeof cursor === "object" &&
		Array.isArray((cursor as { firstBatch?: unknown }).firstBatch)
	) {
		return (cursor as { firstBatch: Row[] }).firstBatch;
	}
	if (Array.isArray(raw["values"])) return (raw["values"] as unknown[]).map((v) => ({ value: v }));
	if (Array.isArray(raw["results"])) return raw["results"] as Row[];
	return [raw as Row];
}

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
	readonly #mongoFeatures: MongoFeatures;

	constructor(
		client: MongoClient,
		dbName: string,
		sampleSize: number,
		mongoFeatures: MongoFeatures
	) {
		this.#client = client;
		this.#dbName = dbName;
		this.#sampleSize = sampleSize;
		this.#mongoFeatures = mongoFeatures;
	}

	/**
	 * ADR-024 D3 — features driver détectées au bootstrap, exposées via le
	 * bag typé `engineFeatures` (discriminé par `kind`). Consommé par run.ts /
	 * codegen sprint pour émettre `planner_mongo_version_capability_missing`
	 * avant d'appeler une op qui exige la feature.
	 */
	get engineFeatures(): MongoEngineFeatures {
		return { kind: "mongodb", features: this.#mongoFeatures };
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

	/**
	 * Sprint T4/1 : fingerprint MongoDB. Mongo n'a pas de `system_identifier`
	 * comme PG — le mieux qu'on ait de stable :
	 *  1. `replSetGetStatus.set` (nom du replica set) — dispo si l'user est
	 *     dans un cluster répliqué (RS) ou sharded. Stable, unique par cluster.
	 *  2. Fallback : SHA256(host:port/dbname) — instable si l'user connecte via
	 *     différents hostnames (LAN vs VPN), mais mieux qu'un throw qui casse
	 *     le pairing complet. Standalone Mongo = pas de RS name → fallback.
	 * Format : `mongo:<rs_name>/<db>` OU `mongo-fallback:<hash>/<db>`.
	 */
	async fingerprint(): Promise<string> {
		const client = this.#requireClient();
		const db = this.#requireDb();
		try {
			const status = (await client
				.db("admin")
				.command({ replSetGetStatus: 1 })) as { set?: unknown };
			if (typeof status.set === "string" && status.set.length > 0) {
				return `mongo:${status.set}/${db.databaseName}`;
			}
		} catch {
			// Standalone Mongo → replSetGetStatus lève NotYetInitialized (94) ou
			// NoReplicationEnabled (76). Auth insuffisante → 13. Dans tous les
			// cas on tombe en fallback SHA256, silencieux.
		}
		// Fallback : hash des hosts + dbname. `topology.s.description.setName`
		// (souvent utilisé), sinon on prend le premier host connu.
		const opts = client.options as unknown as {
			hosts?: readonly { host: string; port: number }[];
		};
		const hostStr = opts.hosts && opts.hosts.length > 0
			? opts.hosts
				.map((h) => `${h.host}:${h.port}`)
				.sort()
				.join(",")
			: "unknown";
		const material = `${hostStr}/${db.databaseName}`;
		const hash = createHash("sha256").update(material).digest("hex");
		return `mongo-fallback:${hash.slice(0, 32)}/${db.databaseName}`;
	}

	async execute(query: NativeQuery): Promise<ResultSet> {
		if (query.kind === "mongo-write") {
			return this.#executeWrite(query);
		}
		if (query.kind === "mongo-introspect") {
			return this.#executeIntrospect(query);
		}
		if (query.kind === "mongo-raw") {
			return this.#executeRaw(query);
		}
		if (query.kind === "mongo-transaction") {
			return this.#executeTransaction(query);
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
			if (query.op === "update-agg-merge") {
				// ADR-024 PM/4 Q4a — write-join via aggregate + $merge natif.
				// Le $merge est un stage terminal qui écrit comme side-effect ;
				// le cursor result est vide. rowCount = 0 (limitation documentée
				// dans MongoWriteQuery type — 2-pass count optionnel prévu PM/10).
				const pipeline = hydrateBson(
					[...query.pipeline],
					false
				) as Document[];
				await collection.aggregate(pipeline).toArray();
				return { columns: [], rows: [], rowCount: 0 };
			}
			if (query.op === "insert-select-agg-merge") {
				// ADR-024 PM/5 Q5a — insert-select via aggregate + $merge dans
				// collection cible. D19-revised (validation E2E chinook-mongo
				// 2026-08-21) : $merge NE PEUT PAS être utilisé DANS une session tx
				// Mongo (contrainte driver, toutes versions Mongo 4.2+). D19
				// original ("tx obligatoire") est inversé : hors session OK,
				// dans session refus au codegen (#executeWriteInSession). Le
				// $merge whenMatched='fail' gère les duplicate keys ; non-atomique
				// sur batch mid-failure — divergence documentée dans registre D7.
				const sourceColl = this.#requireDb().collection(query.sourceCollection);
				const pipeline = hydrateBson(
					[...query.pipeline],
					false
				) as Document[];
				await sourceColl.aggregate(pipeline).toArray();
				return { columns: [], rows: [], rowCount: 0 };
			}
			if (query.op === "upsert") {
				// Sprint v3 Mongo : bulkWrite d'updateOne+upsert (atomicité côté
				// serveur par bulk, pas par transaction). `rowCount` = docs matched
				// (edit) + docs upserted (insert), analogue au RETURNING PG mais
				// sans les docs (l'user avait un upsert, pas un fetch).
				const bulkOps = query.operations.map((op) => {
					const filter = hydrateBson(op.filter, true) as Document;
					const update: Document = {};
					if (op.set !== undefined) {
						update["$set"] = hydrateBson(op.set, false) as Document;
					}
					update["$setOnInsert"] = hydrateBson(
						op.setOnInsert,
						true
					) as Document;
					return { updateOne: { filter, update, upsert: true } };
				});
				const result = await collection.bulkWrite(bulkOps);
				return {
					columns: [],
					rows: [],
					rowCount: result.matchedCount + result.upsertedCount
				};
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

	/**
	 * Sprint T3/1 : dispatch introspection Mongo. `list-tables` → listCollections
	 * sur la DB courante, filtre sur les collections user (`type: "collection"`)
	 * pour exclure les views/system.
	 */
	async #executeIntrospect(
		query: Extract<NativeQuery, { kind: "mongo-introspect" }>
	): Promise<ResultSet> {
		const db = this.#requireDb();
		try {
			if (query.plan.kind === "list-tables") {
				const infos = await db
					.listCollections({ type: "collection" }, { nameOnly: true })
					.toArray();
				const rows: Row[] = infos.map((info) => ({ name: info.name }));
				return {
					columns: [{ name: "name", type: "string", nullable: false }],
					rows,
					rowCount: rows.length
				};
			}
			if (query.plan.kind === "describe-table") {
				const target = query.plan.target;
				if (target === undefined) {
					throw new EngineExecutionError(
						"'describe' sans collection cible (bug parser)"
					);
				}
				// Sample-based : Mongo n'a pas de schéma déclaratif. On réutilise
				// inferCollection (même heuristique que #executeIntrospect global)
				// pour rester cohérent — un `describe` doit reporter la même vue
				// des fields que la SchemaModel remontée au CLI.
				const docs = await db
					.collection(target)
					.aggregate([{ $sample: { size: this.#sampleSize } }])
					.toArray();
				const inferred = inferCollection(target, docs as SampledDoc[]);
				const rows: Row[] = inferred.fields.map((field) => ({
					name: field.name,
					type: field.type,
					nullable: field.nullable,
					default: null,
					is_primary_key: field.name === "_id",
					foreign_key: null
				}));
				return { columns: DESCRIBE_COLUMNS, rows, rowCount: rows.length };
			}
			if (query.plan.kind === "list-schemas") {
				// Mongo n'a pas de "schema" au sens PG — le concept équivalent
				// est la database. admin.listDatabases() nécessite le rôle
				// admin ; certaines connexions n'y ont pas accès. On rebalance
				// avec la DB courante seulement si la commande échoue.
				try {
					const admin = this.#requireClient().db().admin();
					const result = await admin.listDatabases({ nameOnly: true });
					const rows: Row[] = result.databases.map((d) => ({ name: d.name }));
					return {
						columns: [{ name: "name", type: "string", nullable: false }],
						rows,
						rowCount: rows.length
					};
				} catch {
					// Fallback : au moins la DB courante (visible = accessible).
					const rows: Row[] = [{ name: db.databaseName }];
					return {
						columns: [{ name: "name", type: "string", nullable: false }],
						rows,
						rowCount: rows.length
					};
				}
			}
			if (query.plan.kind === "list-indexes") {
				const collectionNames = query.plan.target !== undefined
					? [query.plan.target]
					: (await db.listCollections({ type: "collection" }, { nameOnly: true }).toArray())
						.map((c) => c.name);
				const rows: Row[] = [];
				for (const name of collectionNames) {
					const idx = await db.collection(name).indexes();
					for (const info of idx) {
						const key = (info as { key: Record<string, unknown> }).key;
						rows.push({
							name: info.name ?? "",
							table: name,
							unique: (info as { unique?: boolean }).unique === true,
							columns: Object.keys(key).join(", ")
						});
					}
				}
				return { columns: INDEXES_COLUMNS, rows, rowCount: rows.length };
			}
			throw new EngineExecutionError(
				`Introspect kind '${query.plan.kind}' non supporté par l'adapter Mongo v1`
			);
		} catch (cause) {
			if (cause instanceof EngineExecutionError) throw cause;
			throw new EngineExecutionError(
				`Introspection MongoDB échouée — ${describeMongoExecutionError(cause)}`,
				{ cause }
			);
		}
	}

	/**
	 * Sprint T3/4 : escape hatch `raw {...}` Mongo → db.runCommand(document).
	 * Le résultat est aplati en Row[] : on inspecte les champs classiques d'une
	 * réponse Mongo (`cursor.firstBatch`, `results`, `values`) pour extraire
	 * des rows ; sinon on renvoie le document brut comme une seule row. Aucun
	 * shape stable — c'est l'user qui écrit la command et lit le résultat.
	 */
	async #executeRaw(
		query: Extract<NativeQuery, { kind: "mongo-raw" }>
	): Promise<ResultSet> {
		const db = this.#requireDb();
		try {
			// Mongo exige `cursor: {}` pour toute commande qui streame des
			// résultats (aggregate, find, listCollections, listIndexes…). L'user
			// qui écrit `raw {aggregate: "u", pipeline: [...]}` s'attend à ce
			// que ça marche direct — on inject un cursor vide si absent (safe,
			// override user si présent).
			const command = { ...(query.command as Document) };
			if (needsCursor(command) && !("cursor" in command)) {
				command["cursor"] = {};
			}
			const raw = (await db.command(command)) as Record<string, unknown>;
			const rows = extractRowsFromRawResponse(raw);
			const normalized = rows.map((doc) => normalizeBson(doc) as Row);
			return {
				columns: columnsOf(normalized),
				rows: normalized,
				rowCount: normalized.length
			};
		} catch (cause) {
			throw new EngineExecutionError(
				`raw MongoDB échouée — ${describeMongoExecutionError(cause)}`,
				{ cause }
			);
		}
	}

	/**
	 * Sprint TxMongo : bloc `transaction { … }` sur Mongo (requiert un replica
	 * set côté serveur). Une session unique porte startTransaction → commit ou
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
	async #executeTransaction(
		query: Extract<NativeQuery, { kind: "mongo-transaction" }>
	): Promise<ResultSet> {
		const client = this.#requireClient();
		const db = this.#requireDb();
		const session = client.startSession();
		let lastResult: ResultSet = { columns: [], rows: [], rowCount: 0 };
		const txOptions = mongoTransactionOptions(query.isolation);
		try {
			session.startTransaction(txOptions);
			for (const step of query.steps) {
				if (step.kind === "query") {
					const pipeline = hydrateBson(
						[...step.query.pipeline],
						true
					) as Document[];
					const docs = await db
						.collection(step.query.collection)
						.aggregate(pipeline, { session })
						.toArray();
					const rows = docs.map((doc) => normalizeBson(doc) as Row);
					lastResult = {
						columns: columnsOf(rows),
						rows,
						rowCount: rows.length
					};
				} else {
					lastResult = await this.#executeWriteInSession(step.write, session);
				}
			}
			await session.commitTransaction();
			return lastResult;
		} catch (cause) {
			try {
				await session.abortTransaction();
			} catch (abortErr) {
				// ADR-024 PM/7 D6 — abortTransaction() erreurs enrichies. On avale
				// les codes attendus (tx déjà avortée par le serveur : WriteConflict,
				// TransactionNotFound, NoSuchTransaction, TransientTransactionError).
				// Pour tout autre code (network, timeout) : log + enrichit l'erreur
				// finale avec {abort_error} — tx orpheline invisible côté serveur
				// est le pire failure mode (verrous conservés jusqu'à
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
	 * Sprint TxMongo : variante scopée session de #executeWrite. Duplique
	 * volontairement la logique de dispatch (insert/update/delete) pour passer
	 * `{ session }` au driver — impossible à factoriser proprement sans
	 * complexifier la signature publique. L'atomicité de la transaction rend
	 * `writeErrorMessage` moins pertinent (partial insert impossible dans une
	 * tx qui rollback), mais on garde le format pour homogénéité.
	 */
	async #executeWriteInSession(
		query: Extract<NativeQuery, { kind: "mongo-write" }>,
		session: ClientSession
	): Promise<ResultSet> {
		const collection = this.#requireDb().collection(query.collection);
		try {
			if (query.op === "insert") {
				const documents = query.documents.map(
					(doc) => hydrateBson(doc, true) as Document
				);
				const result = await collection.insertMany(documents, { session });
				const rows = documents.map((doc) => normalizeBson(doc) as Row);
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
				// ADR-024 PM/4 Q4a — write-join dans une transaction Mongo.
				// Fonctionne sur RS 4.2+ (aggregation avec $merge en tx supportée
				// depuis MongoDB 4.2 replica set). rowCount = 0 (limitation $merge).
				const pipeline = hydrateBson(
					[...query.pipeline],
					false
				) as Document[];
				await collection.aggregate(pipeline, { session }).toArray();
				return { columns: [], rows: [], rowCount: 0 };
			}
			if (query.op === "insert-select-agg-merge") {
				// ADR-024-A PA/3 — insert-select DANS session tx via matérialisation
				// client + insertMany (le $merge natif est interdit en session tx, cf
				// D19-revised). Le pipeline est split : (a) source-fetch = toutes les
				// stages avant $merge (retourne des docs), (b) $merge terminal droppé.
				// insertMany écrit atomiquement dans la même session tx. Whole-tx
				// rollback protège en cas d'erreur. Non-atomique par-doc sur duplicate
				// key (insertMany ordonné throw à la première collision) — même
				// sémantique que $merge whenMatched='fail' hors tx.
				const sourceColl = this.#requireDb().collection(query.sourceCollection);
				const stagesBeforeMerge = query.pipeline.filter(
					(s) => !("$merge" in s)
				);
				const fetchPipeline = hydrateBson(
					[...stagesBeforeMerge],
					false
				) as Document[];
				const docsRaw = await sourceColl
					.aggregate(fetchPipeline, { session })
					.toArray();
				if (docsRaw.length === 0) {
					return { columns: [], rows: [], rowCount: 0 };
				}
				const docsToInsert = docsRaw.map(
					(d) => hydrateBson(d, true) as Document
				);
				const targetColl = this.#requireDb().collection(query.collection);
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
				const bulkOps = query.operations.map((op) => {
					const filter = hydrateBson(op.filter, true) as Document;
					const update: Document = {};
					if (op.set !== undefined) {
						update["$set"] = hydrateBson(op.set, false) as Document;
					}
					update["$setOnInsert"] = hydrateBson(
						op.setOnInsert,
						true
					) as Document;
					return { updateOne: { filter, update, upsert: true } };
				});
				const result = await collection.bulkWrite(bulkOps, { session });
				return {
					columns: [],
					rows: [],
					rowCount: result.matchedCount + result.upsertedCount
				};
			}
			const filter = hydrateBson(query.filter, true) as Document;
			const result = await collection.deleteMany(filter, { session });
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

	#requireClient(): MongoClient {
		if (this.#client === undefined) {
			throw new ConnectionClosedError(this.engine);
		}
		return this.#client;
	}
}

/**
 * Sprint TxMongo : mapping IsolationLevel SNQL → options de transaction Mongo
 * (`readConcern` + `writeConcern`). Absence d'isolation → défauts Mongo
 * (snapshot read + local write) — l'user n'a rien demandé, on ne surspécifie
 * pas. IsolationLevel SNQL a 3 valeurs (parser-enum fermé) : pas de default
 * case, la switch est exhaustive.
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
	return { readConcern: { level: "majority" }, writeConcern: { w: "majority" } };
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
			// Fail-fast : établit et vérifie tout de suite. Ordre important :
			// (1) connect() ouvre le pool, (2) probe capabilities pour figer la
			// matrice version × feature (ADR-024 D3), (3) construit la Connection
			// avec les features cachées, (4) ping() sanity check final.
			await client.connect();
			const mongoFeatures = await probeMongoFeatures(client.db(config.database));
			const connection = new MongoConnection(
				client,
				config.database,
				config.sampleSize,
				mongoFeatures
			);
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
