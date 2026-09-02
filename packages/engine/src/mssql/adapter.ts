import type { NativeQuery, ResultSet, SchemaModel } from "@sqlnest/snql";
import type { ConnectionConfiguration } from "tedious";
import { Connection as TediousConnection, Request, TYPES } from "tedious";
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
	EngineExecutionError,
	EngineIntrospectionError
} from "../errors";
import { describeMssqlConfig, type MssqlConnectionConfig } from "./config";

/**
 * Adapter MSSQL (chantier M/1) — driver **tedious nu** (choix user : contrôle
 * TLS maximal, indispensable pour la passe 2014). Cible dev = MSSQL 2022
 * (docker `sqlnest-mssql`), la vraie 2014 valide en M/7.
 *
 * Périmètre M/1 : connect / ping / fingerprint / execute(SqlQuery) / close.
 * L'introspection (SchemaModel) arrive en M/2, le codegen T-SQL en M/3 —
 * les deux lèvent des erreurs TYPÉES en attendant (jamais de silence).
 *
 * tedious n'exécute qu'UNE Request à la fois par connexion : les appels sont
 * sérialisés via une chaîne de promesses (`#queue`) — même garantie d'ordre
 * que le serve loop CLI, zéro pool en V1 (le CLI sérialise déjà ses ops).
 */

interface MssqlRow {
	readonly [column: string]: unknown;
}

function describeTediousError(cause: unknown): string {
	if (cause instanceof Error) {
		return cause.message;
	}
	return String(cause);
}

/** Mappe une valeur JS de paramètre vers un type tedious. Couverture M/1
 * (execute SqlQuery direct + tests) — le codegen M/3 affinera si besoin. */
function tediousTypeFor(value: unknown) {
	if (value === null || value === undefined) return TYPES.NVarChar;
	switch (typeof value) {
		case "string":
			return TYPES.NVarChar;
		case "number":
			return Number.isInteger(value) ? TYPES.Int : TYPES.Float;
		case "bigint":
			return TYPES.BigInt;
		case "boolean":
			return TYPES.Bit;
		case "object":
			if (value instanceof Date) return TYPES.DateTime2;
			if (value instanceof Buffer) return TYPES.VarBinary;
			return TYPES.NVarChar;
		default:
			return TYPES.NVarChar;
	}
}

/** Normalise une valeur de paramètre pour tedious (bigint → string : le
 * driver bind BigInt en texte exact, pas de perte de précision). */
function tediousValueFor(value: unknown): unknown {
	if (value === undefined) return null;
	if (typeof value === "bigint") return value.toString();
	if (
		typeof value === "object" &&
		value !== null &&
		!(value instanceof Date) &&
		!(value instanceof Buffer)
	) {
		return JSON.stringify(value);
	}
	return value;
}

class MssqlConnection implements Connection {
	readonly engine = "mssql";
	readonly namespace: string;
	#conn: TediousConnection | null;
	/** Sérialisation des Requests — tedious n'en supporte qu'une à la fois. */
	#queue: Promise<unknown> = Promise.resolve();
	readonly #config: MssqlConnectionConfig;

	constructor(conn: TediousConnection, config: MssqlConnectionConfig) {
		this.#conn = conn;
		this.#config = config;
		this.namespace = config.schema;
	}

	#requireConn(): TediousConnection {
		if (this.#conn === null) {
			throw new ConnectionClosedError("Connexion MSSQL fermée");
		}
		return this.#conn;
	}

	/** Exécute un batch T-SQL paramétré, sérialisé derrière les requêtes en
	 * cours. Les erreurs serveur sont enveloppées en EngineExecutionError. */
	#run(text: string, params: readonly unknown[] = []): Promise<ResultSet> {
		const task = this.#queue.then(
			() =>
				new Promise<ResultSet>((resolve, reject) => {
					const conn = (() => {
						try {
							return this.#requireConn();
						} catch (e) {
							reject(e);
							return null;
						}
					})();
					if (conn === null) return;

					const rows: MssqlRow[] = [];
					let columns: ResultSet["columns"] = [];

					const request = new Request(text, (err, rowCount) => {
						if (err) {
							reject(
								new EngineExecutionError(
									`Requête MSSQL échouée — ${describeTediousError(err)}`,
									{ cause: err }
								)
							);
							return;
						}
						resolve({
							columns,
							rows: rows as ResultSet["rows"],
							rowCount: rows.length > 0 ? rows.length : (rowCount ?? 0)
						});
					});

					request.on("columnMetadata", (meta) => {
						// tedious livre un array OU un record selon `useColumnNames`.
						const list = Array.isArray(meta) ? meta : Object.values(meta);
						columns = list.map((m) => ({
							name: m.colName,
							// Mapping de type fin en M/2 (introspection) — M/1 reporte
							// un type neutre, suffisant pour l'affichage des rows.
							type: "string",
							nullable: true
						}));
					});

					request.on("row", (cols) => {
						const row: Record<string, unknown> = {};
						for (const col of cols) {
							row[col.metadata.colName] = col.value;
						}
						rows.push(row);
					});

					for (const [i, value] of params.entries()) {
						request.addParameter(
							`p${i + 1}`,
							tediousTypeFor(value),
							tediousValueFor(value)
						);
					}

					conn.execSql(request);
				})
		);
		// La queue avale l'erreur (sinon toute la chaîne resterait rejetée) —
		// l'appelant, lui, la reçoit via `task`.
		this.#queue = task.catch(() => undefined);
		return task;
	}

	async ping(): Promise<PingResult> {
		const start = performance.now();
		const result = await this.#run("SELECT @@VERSION AS v");
		const latencyMs = performance.now() - start;
		const raw = result.rows[0]?.["v"];
		// @@VERSION est un pavé multi-lignes — on garde la 1re ligne.
		const serverVersion =
			typeof raw === "string" ? raw.split("\n")[0]?.trim() : undefined;
		return serverVersion !== undefined
			? { latencyMs, serverVersion }
			: { latencyMs };
	}

	async introspect(): Promise<SchemaModel> {
		// M/2 — SchemaModel via INFORMATION_SCHEMA + sys.foreign_keys.
		// Refus TYPÉ transitoire (jamais un modèle vide silencieux : un canvas
		// « 0 table » masquerait l'état réel du chantier).
		throw new EngineIntrospectionError(
			"Introspection MSSQL pas encore câblée (slice M/2) — connect/ping/execute SQL disponibles"
		);
	}

	async fingerprint(): Promise<string> {
		// `service_broker_guid` : GUID par database, généré à la création,
		// stable pour la vie de la DB et indépendant du device qui se
		// connecte — même contrat que PG system_identifier / Mongo.
		const result = await this.#run(
			"SELECT CONVERT(varchar(64), service_broker_guid) AS guid FROM sys.databases WHERE database_id = DB_ID()"
		);
		const guid = result.rows[0]?.["guid"];
		if (typeof guid !== "string" || guid === "") {
			// Fallback stable : serveur + database (moins fort mais jamais vide).
			const fallback = await this.#run(
				"SELECT CONVERT(varchar(256), SERVERPROPERTY('ServerName')) AS s, DB_NAME() AS d"
			);
			const s = String(fallback.rows[0]?.["s"] ?? "unknown");
			const d = String(fallback.rows[0]?.["d"] ?? this.#config.database);
			return `mssql:${s.toLowerCase()}/${d.toLowerCase()}`;
		}
		return `mssql:${guid.toLowerCase()}`;
	}

	async execute(query: NativeQuery): Promise<ResultSet> {
		if (query.kind !== "sql") {
			throw new EngineExecutionError(
				`L'adapter MSSQL M/1 n'exécute que des SqlQuery — reçu '${query.kind}' (codegen T-SQL : slice M/3)`
			);
		}
		if (query.engine !== "mssql") {
			throw new EngineExecutionError(
				`Requête pour l'engine '${query.engine}' envoyée à l'adapter MSSQL`
			);
		}
		return this.#run(query.text, query.params ?? []);
	}

	async close(): Promise<void> {
		const conn = this.#conn;
		if (conn === null) return;
		this.#conn = null;
		await new Promise<void>((resolve) => {
			conn.once("end", () => resolve());
			conn.close();
		});
	}
}

function buildTediousConfig(
	config: MssqlConnectionConfig
): ConnectionConfiguration {
	return {
		server: config.host,
		authentication: {
			type: "default",
			options: {
				userName: config.user,
				password: config.password
			}
		},
		options: {
			port: config.port,
			database: config.database,
			encrypt: config.encrypt,
			trustServerCertificate: config.trustServerCertificate,
			connectTimeout: config.connectionTimeoutMillis,
			// Dates en UTC — cohérent avec le comportement des drivers PG/Mongo.
			useUTC: true,
			// Les rows arrivent via l'event `row` — pas de double collecte.
			rowCollectionOnRequestCompletion: false
		}
	};
}

export const mssqlAdapter: EngineAdapter = {
	id: "mssql",
	// M/1 : rien n'est poussé (le codegen T-SQL arrive en M/3 avec
	// MSSQL_CAPABILITIES). Des sets vides = le planner refuse proprement tout
	// pushdown au lieu d'émettre du SQL inexistant.
	capabilities: {
		engine: "mssql",
		supports: new Set(),
		functions: new Set(),
		castTargets: new Set()
	},
	async connect(config: ResolvedEngineConfig): Promise<Connection> {
		if (config.engine !== "mssql") {
			throw new EngineConfigError(
				`L'adapter MSSQL a reçu une config '${config.engine}'`
			);
		}
		const tedious = new TediousConnection(buildTediousConfig(config));
		await new Promise<void>((resolve, reject) => {
			tedious.connect((err) => {
				if (err) {
					reject(
						new EngineConnectionError(
							`Connexion MSSQL impossible (${describeMssqlConfig(config)}) — ${describeTediousError(err)}`,
							{ cause: err }
						)
					);
					return;
				}
				resolve();
			});
		});
		const connection = new MssqlConnection(tedious, config);
		// Fail-fast : un connect TDS accepté ne garantit pas l'accès à la
		// database cible — le ping le vérifie (même politique que PG).
		try {
			await connection.ping();
		} catch (cause) {
			await connection.close();
			throw cause;
		}
		return connection;
	}
};
