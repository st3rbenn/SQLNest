import type { NativeQuery, ResultSet, Row, SchemaModel } from "@sqlnest/snql";
import { POSTGRES_CAPABILITIES } from "@sqlnest/snql";
import type { Pool as PgPool, PoolClient, PoolConfig } from "pg";
import pg from "pg";
import type {
	Connection,
	EngineAdapter,
	PingResult,
	ResolvedEngineConfig
} from "../adapter";
import type { PostgresConnectionConfig } from "../config";
import { describePostgresConfig } from "../config";
import {
	ConnectionClosedError,
	EngineConfigError,
	EngineConnectionError,
	EngineExecutionError
} from "../errors";
import { introspectPostgres } from "./introspect";

const { Pool } = pg;

function createPool(config: PostgresConnectionConfig): PgPool {
	const options: PoolConfig = {
		host: config.host,
		port: config.port,
		database: config.database,
		user: config.user,
		password: config.password,
		max: config.poolMax,
		connectionTimeoutMillis: config.connectionTimeoutMillis,
		ssl: config.ssl
	};
	const pool = new Pool(options);
	// Une connexion *idle* qui tombe émet 'error' sur le pool ; sans handler,
	// Node fait planter le process. Le pool retire lui-même le client fautif —
	// on absorbe donc l'événement pour rester résilient.
	pool.on("error", () => {});
	return pool;
}

/** Connexion Postgres : enveloppe un pool `pg`. */
class PostgresConnection implements Connection {
	readonly engine = "postgres";
	#pool: PgPool | undefined;

	constructor(pool: PgPool) {
		this.#pool = pool;
	}

	async ping(): Promise<PingResult> {
		const pool = this.#requirePool();
		const start = performance.now();

		let client: PoolClient;
		try {
			client = await pool.connect();
		} catch (cause) {
			throw new EngineConnectionError(
				"Ping Postgres : acquisition d'une connexion échouée",
				{ cause }
			);
		}

		try {
			const result = await client.query<{ version: string }>(
				"SELECT version() AS version"
			);
			const latencyMs = performance.now() - start;
			const version = result.rows[0]?.version;
			return typeof version === "string"
				? { latencyMs, serverVersion: version }
				: { latencyMs };
		} catch (cause) {
			throw new EngineConnectionError("Ping Postgres : requête échouée", {
				cause
			});
		} finally {
			client.release();
		}
	}

	async introspect(): Promise<SchemaModel> {
		// `async` pour que `#requirePool()` (connexion fermée) rejette la promesse
		// au lieu de lever de façon synchrone — contrat uniforme avec ping/execute.
		return introspectPostgres(this.#requirePool());
	}

	async execute(query: NativeQuery): Promise<ResultSet> {
		if (query.kind !== "sql") {
			throw new EngineExecutionError(
				`Adapter Postgres : requête native '${query.kind}' non supportée (SQL attendu)`
			);
		}
		const pool = this.#requirePool();

		let client: PoolClient;
		try {
			client = await pool.connect();
		} catch (cause) {
			throw new EngineConnectionError(
				"Exécution Postgres : acquisition d'une connexion échouée",
				{ cause }
			);
		}

		try {
			const result = await client.query(query.text, Array.from(query.params));
			return {
				columns: result.fields.map((field) => ({ name: field.name })),
				rows: result.rows as Row[],
				rowCount: result.rowCount ?? result.rows.length
			};
		} catch (cause) {
			throw new EngineExecutionError("Exécution Postgres échouée", { cause });
		} finally {
			client.release();
		}
	}

	async close(): Promise<void> {
		const pool = this.#pool;
		if (pool === undefined) {
			return; // idempotent : fermer deux fois est sans effet
		}
		this.#pool = undefined;
		await pool.end();
	}

	#requirePool(): PgPool {
		if (this.#pool === undefined) {
			throw new ConnectionClosedError(this.engine);
		}
		return this.#pool;
	}
}

/** Adapter Postgres (couche connexion). Voir [[Engine Adapter Interface]]. */
export const postgresAdapter: EngineAdapter = {
	id: "postgres",
	capabilities: POSTGRES_CAPABILITIES,

	async connect(config: ResolvedEngineConfig): Promise<Connection> {
		if (config.engine !== "postgres") {
			throw new EngineConfigError(
				`Adapter Postgres invoqué avec une config '${config.engine}'`
			);
		}

		const pool = createPool(config);
		const connection = new PostgresConnection(pool);

		// Fail-fast : on vérifie tout de suite (mauvais host/credentials → throw
		// ici, pas à la première requête). En cas d'échec, on ferme le pool.
		try {
			await connection.ping();
		} catch (error) {
			await pool.end().catch(() => {});
			const cause =
				error instanceof EngineConnectionError ? error.cause : error;
			throw new EngineConnectionError(
				`Connexion Postgres échouée (${describePostgresConfig(config)})`,
				{ cause }
			);
		}

		return connection;
	}
};
