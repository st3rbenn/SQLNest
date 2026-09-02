import { describe, expect, it } from "vitest";
import { EngineExecutionError, EngineIntrospectionError } from "../errors";
import { mssqlAdapter } from "./adapter";
import { resolveMssqlConfig } from "./config";

/**
 * Tests d'intégration MSSQL (M/1) — gatés par
 * `SNQL_TEST_MSSQL_URL=mssql://sa:SqlNest!Dev2022@localhost:1433/Chinook?trustServerCertificate=true`
 * (docker `sqlnest-mssql` + `pnpm db:seed:chinook:mssql`).
 */
const MSSQL_URL = process.env.SNQL_TEST_MSSQL_URL ?? "";
const hasMssql = MSSQL_URL !== "";

describe.skipIf(!hasMssql)("mssql adapter (intégration M/1)", () => {
	it("connect + ping renvoie latence et version", async () => {
		const conn = await mssqlAdapter.connect(
			resolveMssqlConfig({ url: MSSQL_URL })
		);
		try {
			const ping = await conn.ping();
			expect(ping.latencyMs).toBeGreaterThan(0);
			expect(ping.serverVersion).toMatch(/Microsoft SQL Server/);
		} finally {
			await conn.close();
		}
	});

	it("fingerprint stable `mssql:<guid>` (2 connexions → même valeur)", async () => {
		const a = await mssqlAdapter.connect(resolveMssqlConfig({ url: MSSQL_URL }));
		const b = await mssqlAdapter.connect(resolveMssqlConfig({ url: MSSQL_URL }));
		try {
			const [fa, fb] = [await a.fingerprint(), await b.fingerprint()];
			expect(fa).toMatch(/^mssql:/);
			expect(fa).toBe(fb);
		} finally {
			await a.close();
			await b.close();
		}
	});

	it("execute SqlQuery paramétrée (@p1) contre chinook", async () => {
		const conn = await mssqlAdapter.connect(
			resolveMssqlConfig({ url: MSSQL_URL })
		);
		try {
			const rs = await conn.execute({
				engine: "mssql",
				kind: "sql",
				text: "SELECT TOP 3 Name FROM Artist WHERE ArtistId > @p1 ORDER BY ArtistId",
				params: [0],
				paramSpans: []
			});
			expect(rs.rowCount).toBe(3);
			expect(rs.rows[0]).toHaveProperty("Name");
		} finally {
			await conn.close();
		}
	});

	it("requêtes concurrentes sérialisées (tedious = 1 request à la fois)", async () => {
		const conn = await mssqlAdapter.connect(
			resolveMssqlConfig({ url: MSSQL_URL })
		);
		try {
			const results = await Promise.all(
				[1, 2, 3].map((n) =>
					conn.execute({
						engine: "mssql",
						kind: "sql",
						text: `SELECT ${n} AS n`,
						params: [],
						paramSpans: []
					})
				)
			);
			expect(results.map((r) => r.rows[0]?.["n"])).toEqual([1, 2, 3]);
		} finally {
			await conn.close();
		}
	});

	it("une erreur SQL n'empoisonne pas la queue (la requête suivante passe)", async () => {
		const conn = await mssqlAdapter.connect(
			resolveMssqlConfig({ url: MSSQL_URL })
		);
		try {
			await expect(
				conn.execute({
					engine: "mssql",
					kind: "sql",
					text: "SELECT * FROM table_inexistante_m1",
					params: [],
					paramSpans: []
				})
			).rejects.toThrow(EngineExecutionError);
			const rs = await conn.execute({
				engine: "mssql",
				kind: "sql",
				text: "SELECT 1 AS ok",
				params: [],
				paramSpans: []
			});
			expect(rs.rows[0]?.["ok"]).toBe(1);
		} finally {
			await conn.close();
		}
	});

	it("introspect → refus typé M/2 (jamais un modèle vide silencieux)", async () => {
		const conn = await mssqlAdapter.connect(
			resolveMssqlConfig({ url: MSSQL_URL })
		);
		try {
			await expect(conn.introspect()).rejects.toThrow(
				EngineIntrospectionError
			);
		} finally {
			await conn.close();
		}
	});
});
