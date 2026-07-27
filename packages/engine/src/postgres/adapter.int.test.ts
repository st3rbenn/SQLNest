import type { NativeQuery } from "@sqlnest/snql";
import { describe, expect, it } from "vitest";
import { resolvePostgresConfig } from "../config";
import { ConnectionClosedError, EngineConnectionError } from "../errors";
import { runQuery } from "../run";
import { postgresAdapter } from "./adapter";

/**
 * Tests d'intégration : nécessitent un vrai Postgres.
 * Lancer `pnpm db:up`, puis exporter
 * `SNQL_TEST_PG_URL=postgres://sqlnest:sqlnest@localhost:5433/sqlnest_demo`.
 * Sans cette variable, tout le bloc est **sauté** (les tests unitaires suffisent en CI).
 */
const PG_URL = process.env.SNQL_TEST_PG_URL ?? "";
const hasPg = PG_URL !== "";

// Résolue paresseusement : le corps du `describe` s'exécute à la collecte même
// quand il est sauté, donc on ne parse pas une URL vide au niveau module.
const loadConfig = () => resolvePostgresConfig({ url: PG_URL });

describe.skipIf(!hasPg)("postgres adapter (intégration)", () => {
	it("connect → ping → close", async () => {
		const conn = await postgresAdapter.connect(loadConfig());
		try {
			const ping = await conn.ping();
			expect(ping.latencyMs).toBeGreaterThanOrEqual(0);
			expect(ping.serverVersion).toMatch(/PostgreSQL/i);
		} finally {
			await conn.close();
		}
	}, 20_000);

	it("close est idempotent", async () => {
		const conn = await postgresAdapter.connect(loadConfig());
		await conn.close();
		await expect(conn.close()).resolves.toBeUndefined();
	}, 20_000);

	it("ping après close lève ConnectionClosedError", async () => {
		const conn = await postgresAdapter.connect(loadConfig());
		await conn.close();
		await expect(conn.ping()).rejects.toBeInstanceOf(ConnectionClosedError);
	}, 20_000);

	it("une connexion refusée lève EngineConnectionError", async () => {
		const unreachable = {
			...loadConfig(),
			port: 1,
			connectionTimeoutMillis: 1500
		};
		await expect(postgresAdapter.connect(unreachable)).rejects.toBeInstanceOf(
			EngineConnectionError
		);
	}, 20_000);

	it("execute renvoie un ResultSet normalisé", async () => {
		const conn = await postgresAdapter.connect(loadConfig());
		try {
			const query = {
				engine: "postgres",
				kind: "sql",
				text: "SELECT email FROM users ORDER BY id",
				params: []
			} satisfies NativeQuery;
			const rs = await conn.execute(query);
			expect(rs.rowCount).toBe(3);
			expect(rs.columns).toEqual([{ name: "email" }]);
			expect(rs.rows.map((row) => row.email)).toEqual([
				"ada@example.com",
				"alan@example.com",
				"grace@example.com"
			]);
		} finally {
			await conn.close();
		}
	}, 20_000);

	it("runQuery : du SNQL à de vraies lignes Postgres", async () => {
		const conn = await postgresAdapter.connect(loadConfig());
		try {
			const rs = await runQuery(
				conn,
				"get users | where is_active = true | pick email"
			);
			const emails = rs.rows.map((row) => row.email).sort();
			expect(emails).toEqual(["ada@example.com", "alan@example.com"]);
		} finally {
			await conn.close();
		}
	}, 20_000);

	it("update : mutation réelle réversible (rowCount + RETURNING)", async () => {
		const conn = await postgresAdapter.connect(loadConfig());
		try {
			const activated = await runQuery(
				conn,
				'update users | where email = "grace@example.com" | set is_active = true'
			);
			expect(activated.rowCount).toBe(1);
			expect(activated.rows[0]?.is_active).toBe(true);
		} finally {
			// Restaure l'état initial (grace inactive) → runs idempotents.
			await runQuery(
				conn,
				'update users | where email = "grace@example.com" | set is_active = false'
			);
			await conn.close();
		}
	}, 20_000);

	it("delete : chemin d'exécution sans détruire le seed (0 ligne)", async () => {
		const conn = await postgresAdapter.connect(loadConfig());
		try {
			const removed = await runQuery(
				conn,
				'remove from users | where email = "nobody@example.invalid"'
			);
			expect(removed.rowCount).toBe(0);
		} finally {
			await conn.close();
		}
	}, 20_000);

	it("insert : ligne réelle (RETURNING) puis nettoyage", async () => {
		const conn = await postgresAdapter.connect(loadConfig());
		const cleanup = 'remove from users | where email = "temp@example.invalid"';
		try {
			// Nettoie une éventuelle ligne laissée par un run précédent.
			await runQuery(conn, cleanup);
			const inserted = await runQuery(
				conn,
				'add {email: "temp@example.invalid", display_name: "Temp", is_active: true} into users'
			);
			expect(inserted.rowCount).toBe(1);
			expect(inserted.rows[0]?.email).toBe("temp@example.invalid");
			expect(inserted.rows[0]?.id).toBeDefined();
		} finally {
			await runQuery(conn, cleanup);
			await conn.close();
		}
	}, 20_000);
});
