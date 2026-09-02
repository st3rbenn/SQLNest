import {
	DISTINCT_ON_RN_COLUMN,
	type IsolationLevel,
	type NativeQuery,
	type ResultSet,
	type SchemaModel,
	type SqlTransaction
} from "@sqlnest/snql";
import type { ConnectionConfiguration } from "tedious";
import {
	Connection as TediousConnection,
	ISOLATION_LEVEL,
	Request,
	TYPES
} from "tedious";
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
import { describeMssqlConfig, type MssqlConnectionConfig } from "./config";
import { introspectMssql } from "./introspect";

/**
 * Adapter MSSQL (chantier M/1) — driver **tedious nu** (choix user : contrôle
 * TLS maximal, indispensable pour la passe 2014). Cible dev = MSSQL 2022
 * (docker `sqlnest-mssql`), la vraie 2014 valide en M/7.
 *
 * Périmètre : connect / ping / fingerprint / execute(SqlQuery) / close (M/1)
 * + introspection SchemaModel (M/2, voir ./introspect). Le codegen T-SQL
 * arrive en M/3 — il lève une erreur TYPÉE en attendant (jamais de silence).
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

	/**
	 * Exécution DIRECTE d'un batch T-SQL paramétré — sans passer par la
	 * queue. Réservé aux appels déjà sérialisés : le corps de `#run` et les
	 * steps de `#executeTransaction` (qui occupe la queue comme UNE unité —
	 * une requête concurrente qui s'intercalerait entre BEGIN et COMMIT
	 * rejoindrait silencieusement la transaction).
	 */
	#runDirect(
		text: string,
		params: readonly unknown[] = []
	): Promise<ResultSet> {
		return new Promise<ResultSet>((resolve, reject) => {
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
					// Fallback safe identique à PG : le type riche vient de
					// `inferResultColumns(schema)` dans run.ts, pas du driver.
					type: "unknown",
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
		});
	}

	/** Exécute un batch T-SQL paramétré, sérialisé derrière les requêtes en
	 * cours. Les erreurs serveur sont enveloppées en EngineExecutionError. */
	#run(text: string, params: readonly unknown[] = []): Promise<ResultSet> {
		const task = this.#queue.then(() => this.#runDirect(text, params));
		// La queue avale l'erreur (sinon toute la chaîne resterait rejetée) —
		// l'appelant, lui, la reçoit via `task`.
		this.#queue = task.catch(() => undefined);
		return task;
	}

	/**
	 * Exécute un SqlTransaction (M/4) — la transaction ENTIÈRE occupe la
	 * queue comme une seule tâche (l'entrelacement d'une autre requête entre
	 * BEGIN et COMMIT la ferait participer à la transaction).
	 *
	 * ⚠ API tedious NATIVE obligatoire (`beginTransaction`/`saveTransaction`/
	 * `commitTransaction`) : un `BEGIN TRANSACTION` en SQL texte ouvre bien la
	 * transaction côté serveur mais tedious ne met PAS à jour le descripteur
	 * de transaction TDS envoyé dans l'en-tête des requêtes suivantes — les
	 * `sp_executesql` paramétrés tournent alors hors transaction et le serveur
	 * refuse (« Transaction count after EXECUTE indicates a mismatching
	 * number of BEGIN and COMMIT statements »).
	 *
	 * Sémantique alignée PG : begin [isolation], steps linéaires, commit ;
	 * rollback global best-effort sur toute erreur. Savepoints :
	 * `saveTransaction` natif ; release = no-op (T-SQL n'a pas de RELEASE
	 * SAVEPOINT, le point expire au COMMIT). Renvoie le résultat du dernier
	 * statement (cohérence UI — l'user voit ce qu'il a écrit en dernier).
	 */
	#executeTransaction(query: SqlTransaction): Promise<ResultSet> {
		const task = this.#queue.then(async (): Promise<ResultSet> => {
			const conn = this.#requireConn();
			await new Promise<void>((resolve, reject) => {
				conn.beginTransaction(
					(err) => (err ? reject(wrapTxError("BEGIN", err)) : resolve()),
					"",
					mssqlIsolationLevel(query.isolation)
				);
			});
			let lastResult: ResultSet = { columns: [], rows: [], rowCount: 0 };
			try {
				for (const step of query.steps) {
					if (step.kind === "savepoint-begin") {
						await new Promise<void>((resolve, reject) => {
							conn.saveTransaction(
								(err) =>
									err ? reject(wrapTxError("SAVE", err)) : resolve(),
								assertSavepointName(step.name)
							);
						});
					} else if (step.kind === "savepoint-release") {
						// Pas de RELEASE SAVEPOINT en T-SQL — no-op délibéré.
					} else {
						lastResult = postProcessResult(
							await this.#runDirect(
								step.query.text,
								step.query.params
							),
							step.query.jsonColumns
						);
					}
				}
				await new Promise<void>((resolve, reject) => {
					conn.commitTransaction((err) =>
						err ? reject(wrapTxError("COMMIT", err)) : resolve()
					);
				});
				return lastResult;
			} catch (cause) {
				// ROLLBACK best-effort — si le rollback échoue (connexion morte),
				// on surface l'erreur d'origine, plus utile pour l'user.
				await new Promise<void>((resolve) => {
					conn.rollbackTransaction(() => resolve());
				}).catch(() => undefined);
				throw cause;
			}
		});
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
		return introspectMssql(
			(text, params) => this.#run(text, params),
			this.#config.schema
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
		if (query.engine !== "mssql") {
			throw new EngineExecutionError(
				`Requête pour l'engine '${query.engine}' envoyée à l'adapter MSSQL`
			);
		}
		if (query.kind === "transaction") {
			return this.#executeTransaction(query);
		}
		if (query.kind !== "sql") {
			throw new EngineExecutionError(
				`L'adapter MSSQL n'exécute que des SqlQuery/SqlTransaction — reçu '${query.kind}'`
			);
		}
		const result = await this.#run(query.text, query.params ?? []);
		return postProcessResult(result, query.jsonColumns);
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

/**
 * Mapping IsolationLevel SNQL → enum tedious (l'API native beginTransaction
 * pilote le SET ISOLATION LEVEL via le protocole). `undefined` = niveau par
 * défaut de la connexion (READ COMMITTED).
 */
function mssqlIsolationLevel(
	level: IsolationLevel | undefined
): number | undefined {
	if (level === undefined) return undefined;
	switch (level) {
		case "read_committed":
			return ISOLATION_LEVEL.READ_COMMITTED;
		case "repeatable_read":
			return ISOLATION_LEVEL.REPEATABLE_READ;
		case "serializable":
			return ISOLATION_LEVEL.SERIALIZABLE;
	}
}

const SAVEPOINT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Nom de savepoint validé — l'API tedious saveTransaction prend le nom NU
 *  (defense-in-depth avant de le laisser partir dans le protocole). */
function assertSavepointName(name: string): string {
	if (!SAVEPOINT_NAME_RE.test(name)) {
		throw new EngineExecutionError(`Nom de savepoint invalide '${name}'`);
	}
	return name;
}

function wrapTxError(phase: string, cause: Error): EngineExecutionError {
	return new EngineExecutionError(
		`Transaction MSSQL (${phase}) échouée — ${describeTediousError(cause)}`,
		{ cause }
	);
}

/**
 * Post-traitement du ResultSet MSSQL (M/3) :
 *  - `jsonColumns` (colonnes embed/objet de row jointe émises en
 *    `FOR JSON …`) : T-SQL n'a pas de type json, les valeurs arrivent en
 *    STRING nvarchar — on les parse pour la parité de shape avec PG (le
 *    driver pg parse json/jsonb nativement). Une valeur non-parsable reste
 *    telle quelle (defensif — ne jamais perdre la donnée).
 *  - `__sqlnest_rn` : colonne technique du wrap DISTINCT ON (stratégie
 *    ROW_NUMBER du codegen) — retirée des rows ET des columns.
 */
function postProcessResult(
	result: ResultSet,
	jsonColumns: readonly string[] | undefined
): ResultSet {
	const hasRn = result.columns.some((c) => c.name === DISTINCT_ON_RN_COLUMN);
	const hasJson = jsonColumns !== undefined && jsonColumns.length > 0;
	if (!hasRn && !hasJson) return result;

	const jsonSet = new Set(jsonColumns ?? []);
	const rows = result.rows.map((row) => {
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(row)) {
			if (key === DISTINCT_ON_RN_COLUMN) continue;
			if (jsonSet.has(key) && typeof value === "string") {
				try {
					out[key] = JSON.parse(value);
				} catch {
					out[key] = value;
				}
			} else {
				out[key] = value;
			}
		}
		return out;
	});
	return {
		columns: result.columns.filter((c) => c.name !== DISTINCT_ON_RN_COLUMN),
		rows: rows as ResultSet["rows"],
		rowCount: result.rowCount
	};
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
