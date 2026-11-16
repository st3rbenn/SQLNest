import { createHash } from "node:crypto";
import {
	MONGODB_CAPABILITIES,
	type NativeQuery,
	type ResultSet,
	type Row,
	type SchemaModel
} from "@sqlnest/snql";
import { type Db, MongoClient } from "mongodb";
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
import { normalizeBson } from "./bson";
import {
	type MongoEngineFeatures,
	type MongoFeatures,
	probeMongoFeatures
} from "./capability-probe";
import { describeMongoConfig } from "./config";
import type { MongoContext } from "./context";
import { executeDDL } from "./ddl";
import { describeMongoExecutionError } from "./execution-errors";
import { introspectMongo } from "./introspect";
import { executeIntrospect } from "./introspect-exec";
import { columnsOf, executeRaw, readPipeline, renameRowKeys } from "./read";
import { executeTransaction } from "./transaction";
import { executeWrite } from "./write";

// Utilitaires exposés pour leurs tests.
export { bsonMatchKey, hydrateBson, normalizeBson } from "./bson";
export { extractSetFields, pipelineSetColumns, uniqueDefined } from "./fk";
export { pipelineWithStoredForms, withStoredForms } from "./stored-forms";
export {
	lookupCollections,
	withTextDecimalFilter,
	withTextDecimalStages
} from "./text-decimals";

const SERVER_SELECTION_TIMEOUT_MS = 10_000;

/** Connexion MongoDB : enveloppe un `MongoClient`. */
class MongoConnection implements Connection {
	readonly engine = "mongodb";
	#client: MongoClient | undefined;
	readonly #dbName: string;
	readonly #sampleSize: number;
	readonly #mongoFeatures: MongoFeatures;
	/** Ce que les opérations reçoivent de la connexion. */
	readonly #cx: MongoContext;

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
		this.#cx = {
			db: () => this.#requireDb(),
			client: () => this.#requireClient(),
			sampleSize
		};
	}

	/**
	 * Features driver détectées au bootstrap, exposées via le bag typé
	 * `engineFeatures` (discriminé par `kind`). Consommé par run.ts / codegen
	 * pour émettre `planner_mongo_version_capability_missing` avant d'appeler
	 * une op qui exige la feature.
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
	 * Fingerprint MongoDB. Mongo n'a pas de `system_identifier` comme PG —
	 * le mieux qu'on ait de stable :
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
		const hosts = client.options.hosts;
		const hostStr =
			hosts.length > 0
				? hosts
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
			return executeWrite(this.#cx, query);
		}
		if (query.kind === "mongo-introspect") {
			return executeIntrospect(this.#cx, query);
		}
		if (query.kind === "mongo-raw") {
			return executeRaw(this.#cx, query);
		}
		if (query.kind === "mongo-transaction") {
			return executeTransaction(this.#cx, query);
		}
		if (query.kind === "mongo-ddl") {
			return executeDDL(this.#cx, query);
		}
		if (query.kind !== "mongo") {
			throw new EngineExecutionError(
				`Adapter MongoDB : requête native '${query.kind}' non supportée (pipeline attendu)`
			);
		}
		const db = this.#requireDb();
		try {
			const pipeline = await readPipeline(
				this.#cx,
				query.collection,
				query.pipeline
			);
			const docs = await db
				.collection(query.collection)
				.aggregate(pipeline)
				.toArray();
			const rows = renameRowKeys(
				docs.map((doc) => normalizeBson(doc) as Row),
				query.renameKeys
			);
			return { columns: columnsOf(rows), rows, rowCount: rows.length };
		} catch (cause) {
			throw new EngineExecutionError(
				`Exécution MongoDB échouée — ${describeMongoExecutionError(cause)}`,
				{ cause }
			);
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
			// matrice version × feature, (3) construit la Connection avec les
			// features cachées, (4) ping() sanity check final.
			await client.connect();
			const mongoFeatures = await probeMongoFeatures(
				client.db(config.database)
			);
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
