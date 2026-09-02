import { describe, expect, it } from "vitest";
import { EngineExecutionError } from "../errors";
import { mssqlAdapter } from "./adapter";
import { resolveMssqlConfig } from "./config";

/**
 * Tests d'intégration MSSQL (M/1 connect + M/2 introspection) — gatés par
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

	it("introspect chinook → SchemaModel complet (M/2)", async () => {
		const conn = await mssqlAdapter.connect(
			resolveMssqlConfig({ url: MSSQL_URL })
		);
		try {
			const schema = await conn.introspect();
			expect(schema.engine).toBe("mssql");

			// 11 tables Chinook, triées — miroir exact des seeds PG/Mongo.
			expect(schema.collections.map((c) => c.name)).toEqual([
				"Album",
				"Artist",
				"Customer",
				"Employee",
				"Genre",
				"Invoice",
				"InvoiceLine",
				"MediaType",
				"Playlist",
				"PlaylistTrack",
				"Track"
			]);

			// Types mappés : INT → int, NVARCHAR → string, NUMERIC → decimal,
			// DATETIME → date ; nullabilité lue du catalogue.
			const track = schema.collections.find((c) => c.name === "Track")!;
			expect(track.primaryKey).toEqual(["TrackId"]);
			const fieldsByName = new Map(track.fields.map((f) => [f.name, f]));
			expect(fieldsByName.get("TrackId")).toMatchObject({
				type: "int",
				nullable: false
			});
			expect(fieldsByName.get("Name")).toMatchObject({
				type: "string",
				nullable: false
			});
			expect(fieldsByName.get("UnitPrice")).toMatchObject({
				type: "decimal"
			});
			expect(fieldsByName.get("Composer")).toMatchObject({ nullable: true });
			const invoice = schema.collections.find((c) => c.name === "Invoice")!;
			expect(
				invoice.fields.find((f) => f.name === "InvoiceDate")
			).toMatchObject({ type: "date", nullable: false });

			// PK composite : ordre ordinal (PlaylistId puis TrackId).
			const playlistTrack = schema.collections.find(
				(c) => c.name === "PlaylistTrack"
			)!;
			expect(playlistTrack.primaryKey).toEqual(["PlaylistId", "TrackId"]);

			// Les 11 FK Chinook → 11 relations many-to-one + 11 refs
			// (toutes single-column), self-ref Employee.ReportsTo incluse.
			expect(schema.relations).toHaveLength(11);
			expect(
				schema.relations.every(
					(r) => r.kind === "many-to-one" && r.origin === "foreign-key"
				)
			).toBe(true);
			const refPairs = (schema.refs ?? []).map(
				(r) => `${r.fromCollection}.${r.fromColumn}->${r.toCollection}.${r.toColumn}`
			);
			expect(refPairs.sort()).toEqual([
				"Album.ArtistId->Artist.ArtistId",
				"Customer.SupportRepId->Employee.EmployeeId",
				"Employee.ReportsTo->Employee.EmployeeId",
				"Invoice.CustomerId->Customer.CustomerId",
				"InvoiceLine.InvoiceId->Invoice.InvoiceId",
				"InvoiceLine.TrackId->Track.TrackId",
				"PlaylistTrack.PlaylistId->Playlist.PlaylistId",
				"PlaylistTrack.TrackId->Track.TrackId",
				"Track.AlbumId->Album.AlbumId",
				"Track.GenreId->Genre.GenreId",
				"Track.MediaTypeId->MediaType.MediaTypeId"
			]);
		} finally {
			await conn.close();
		}
	});
});
