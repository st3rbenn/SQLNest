import type {
	NativeQuery,
	ResultColumn,
	ResultSet,
	Row,
	SchemaModel
} from "@sqlnest/snql";
import { MONGODB_CAPABILITIES } from "@sqlnest/snql";
import type { Db, Document } from "mongodb";
import { MongoClient } from "mongodb";
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

/** Colonnes déduites des lignes (union ordonnée des clés) — Mongo n'a pas de schéma fixe. */
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
	return names.map((name) => ({ name }));
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
		if (query.kind !== "mongo") {
			throw new EngineExecutionError(
				`Adapter MongoDB : requête native '${query.kind}' non supportée (pipeline attendu)`
			);
		}
		const db = this.#requireDb();
		try {
			const docs = await db
				.collection(query.collection)
				.aggregate([...query.pipeline] as Document[])
				.toArray();
			const rows = docs.map((doc) => normalizeBson(doc) as Row);
			return { columns: columnsOf(rows), rows, rowCount: rows.length };
		} catch (cause) {
			throw new EngineExecutionError("Exécution MongoDB échouée", { cause });
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
