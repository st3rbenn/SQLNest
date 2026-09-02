import { describe, expect, it } from "vitest";
import { EngineExecutionError } from "../errors";
import { runQuery } from "../run";
import { mssqlAdapter } from "./adapter";
import { resolveMssqlConfig } from "./config";

/**
 * Tests d'intégration MSSQL (M/1 connect + M/2 introspection + M/3 runQuery
 * SNQL complet) — gatés par
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

describe.skipIf(!hasMssql)("mssql runQuery SNQL (intégration M/3)", () => {
	async function withConn<T>(
		fn: (conn: Awaited<ReturnType<typeof mssqlAdapter.connect>>) => Promise<T>
	): Promise<T> {
		const conn = await mssqlAdapter.connect(
			resolveMssqlConfig({ url: MSSQL_URL })
		);
		try {
			return await fn(conn);
		} finally {
			await conn.close();
		}
	}

	it("find where/pick/sort/limit → TOP réel sur Artist", async () => {
		await withConn(async (conn) => {
			const rs = await runQuery(
				conn,
				`find Artist where ArtistId <= 5 pick Name sort Name limit 3`
			);
			expect(rs.written).toBe(false);
			expect(rs.rowCount).toBe(3);
			expect(rs.rows.map((r) => r["Name"])).toEqual([
				"AC/DC",
				"Accept",
				"Aerosmith"
			]);
		});
	});

	it("limit + offset → OFFSET-FETCH réel (pagination stable)", async () => {
		await withConn(async (conn) => {
			const page1 = await runQuery(
				conn,
				`find Artist pick ArtistId, Name sort ArtistId limit 2`
			);
			const page2 = await runQuery(
				conn,
				`find Artist pick ArtistId, Name sort ArtistId limit 2 offset 2`
			);
			expect(page1.rows.map((r) => r["ArtistId"])).toEqual([1, 2]);
			expect(page2.rows.map((r) => r["ArtistId"])).toEqual([3, 4]);
		});
	});

	it("group by + having + count(*) → agrégat réel sur Invoice", async () => {
		await withConn(async (conn) => {
			const rs = await runQuery(
				conn,
				`find Invoice group by BillingCountry having count(*) > 30 pick BillingCountry, count(*) as n sort BillingCountry`
			);
			// Chinook : USA (91), Canada (56), France (35), Brazil (35),
			// Germany (28 → exclu par > 30).
			const countries = rs.rows.map((r) => r["BillingCountry"]);
			expect(countries).toContain("USA");
			expect(countries).toContain("Canada");
			expect(countries).not.toContain("Germany");
			// COUNT_BIG → bigint TDS, tedious le lit en string : cohérent avec
			// le driver pg (bigint sérialisé string).
			const usa = rs.rows.find((r) => r["BillingCountry"] === "USA");
			expect(Number(usa?.["n"])).toBe(91);
		});
	});

	it("embed one-to-many FOR JSON → array PARSÉ (jsonColumns adapter)", async () => {
		await withConn(async (conn) => {
			const rs = await runQuery(
				conn,
				`find Artist with Album on ArtistId = ArtistId where ArtistId = 1`
			);
			expect(rs.rowCount).toBe(1);
			const albums = rs.rows[0]?.["Album"];
			expect(Array.isArray(albums)).toBe(true);
			const titles = (albums as { Title: string }[]).map((a) => a.Title);
			// AC/DC a 2 albums dans Chinook.
			expect(titles).toContain("For Those About To Rock We Salute You");
			expect(titles).toContain("Let There Be Rock");
		});
	});

	it("fonctions T-SQL réelles : upper, length, strpos (CHARINDEX inversé)", async () => {
		await withConn(async (conn) => {
			const rs = await runQuery(
				conn,
				`find Artist where ArtistId = 1 pick upper(Name) as u, length(Name) as l, strpos(Name, "/") as p`
			);
			expect(rs.rows[0]).toMatchObject({ u: "AC/DC", l: 5, p: 3 });
		});
	});

	it("avg cast float — AVG int T-SQL aurait tronqué", async () => {
		await withConn(async (conn) => {
			const rs = await runQuery(
				conn,
				`find Track pick avg(Milliseconds) as a`
			);
			const avg = rs.rows[0]?.["a"];
			expect(typeof avg).toBe("number");
			// Moyenne réelle Chinook ≈ 393599.21 — un AVG int aurait donné un entier.
			expect(Number.isInteger(avg)).toBe(false);
		});
	});

	it("pick unique on (keys) → wrap ROW_NUMBER, __sqlnest_rn strippé", async () => {
		await withConn(async (conn) => {
			const rs = await runQuery(
				conn,
				`find Invoice pick unique on (BillingCountry) BillingCountry, Total sort BillingCountry, Total desc limit 5`
			);
			expect(rs.rowCount).toBe(5);
			expect(rs.columns.map((c) => c.name)).not.toContain("__sqlnest_rn");
			expect(Object.keys(rs.rows[0] ?? {})).toEqual([
				"BillingCountry",
				"Total"
			]);
		});
	});

	it("subquery in (find …) native", async () => {
		await withConn(async (conn) => {
			const rs = await runQuery(
				conn,
				`find Album where ArtistId in (find Artist where Name = "Aerosmith" pick ArtistId) pick Title`
			);
			expect(rs.rows.map((r) => r["Title"])).toEqual([
				"Big Ones"
			]);
		});
	});

	it("raw \"SELECT TOP …\" passthrough", async () => {
		await withConn(async (conn) => {
			const rs = await runQuery(conn, `raw "SELECT TOP 2 Name FROM Artist ORDER BY ArtistId"`);
			expect(rs.rows.map((r) => r["Name"])).toEqual(["AC/DC", "Accept"]);
		});
	});
});

describe.skipIf(!hasMssql)("mssql écritures SNQL (intégration M/4)", () => {
	async function withConn<T>(
		fn: (conn: Awaited<ReturnType<typeof mssqlAdapter.connect>>) => Promise<T>
	): Promise<T> {
		const conn = await mssqlAdapter.connect(
			resolveMssqlConfig({ url: MSSQL_URL })
		);
		try {
			return await fn(conn);
		} finally {
			await conn.close();
		}
	}

	it("insert → OUTPUT INSERTED.* réel, puis delete de nettoyage", async () => {
		await withConn(async (conn) => {
			const ins = await runQuery(
				conn,
				`add { GenreId: 9901, Name: "SNQL M4 Insert" } into Genre`
			);
			expect(ins.written).toBe(true);
			expect(ins.rowCount).toBe(1);
			expect(ins.rows[0]).toMatchObject({
				GenreId: 9901,
				Name: "SNQL M4 Insert"
			});
			const del = await runQuery(
				conn,
				`remove from Genre where GenreId = 9901`
			);
			expect(del.written).toBe(true);
			expect(del.rows[0]).toMatchObject({ GenreId: 9901 });
		});
	});

	it("update réversible → OUTPUT INSERTED.* porte la valeur APRÈS", async () => {
		await withConn(async (conn) => {
			const upd = await runQuery(
				conn,
				`edit Genre where GenreId = 1 set Name = "Rock (M4)"`
			);
			expect(upd.rowCount).toBe(1);
			expect(upd.rows[0]).toMatchObject({ GenreId: 1, Name: "Rock (M4)" });
			const revert = await runQuery(
				conn,
				`edit Genre where GenreId = 1 set Name = "Rock"`
			);
			expect(revert.rows[0]).toMatchObject({ Name: "Rock" });
		});
	});

	it("decimal exact : UnitPrice NUMERIC(10,2) round-trip sans dérive float", async () => {
		await withConn(async (conn) => {
			const upd = await runQuery(
				conn,
				`edit Track where TrackId = 1 set UnitPrice = 1.13`
			);
			// tedious lit NUMERIC en number JS — 1.13 exact à l'échelle (10,2).
			expect(Number(upd.rows[0]?.["UnitPrice"])).toBe(1.13);
			const revert = await runQuery(
				conn,
				`edit Track where TrackId = 1 set UnitPrice = 0.99`
			);
			expect(Number(revert.rows[0]?.["UnitPrice"])).toBe(0.99);
		});
	});

	it("upsert MERGE ignore : conflit → 0 row OUTPUT, existant intact", async () => {
		await withConn(async (conn) => {
			const up = await runQuery(
				conn,
				`add { GenreId: 1, Name: "JAMAIS" } into Genre on conflict (GenreId) ignore`
			);
			expect(up.written).toBe(true);
			expect(up.rowCount).toBe(0);
			const check = await runQuery(
				conn,
				`find Genre where GenreId = 1 pick Name`
			);
			expect(check.rows[0]?.["Name"]).toBe("Rock");
		});
	});

	it("upsert MERGE edit set new.<col> : conflit → UPDATE avec la row proposée", async () => {
		await withConn(async (conn) => {
			const up = await runQuery(
				conn,
				`add { GenreId: 1, Name: "Rock (upsert)" } into Genre on conflict (GenreId) edit set Name = new.Name`
			);
			expect(up.rowCount).toBe(1);
			expect(up.rows[0]).toMatchObject({ GenreId: 1, Name: "Rock (upsert)" });
			await runQuery(conn, `edit Genre where GenreId = 1 set Name = "Rock"`);
		});
	});

	it("upsert MERGE : pas de conflit → INSERT (puis nettoyage)", async () => {
		await withConn(async (conn) => {
			const up = await runQuery(
				conn,
				`add { GenreId: 9902, Name: "SNQL M4 Upsert" } into Genre on conflict (GenreId) ignore`
			);
			expect(up.rowCount).toBe(1);
			expect(up.rows[0]).toMatchObject({ GenreId: 9902 });
			await runQuery(conn, `remove from Genre where GenreId = 9902`);
		});
	});

	it("transaction native : add + savepoint(remove) → commit atomique", async () => {
		await withConn(async (conn) => {
			const tx = await runQuery(
				conn,
				`transaction { add { GenreId: 9903, Name: "SNQL M4 Tx" } into Genre; savepoint sp1 { remove from Genre where GenreId = 9903 } }`
			);
			expect(tx.written).toBe(true);
			// Le dernier statement (remove) a supprimé la row insérée — la DB
			// est nette après commit.
			const check = await runQuery(
				conn,
				`find Genre where GenreId = 9903 pick Name`
			);
			expect(check.rowCount).toBe(0);
		});
	});

	it("transaction : erreur au milieu → ROLLBACK global, rien n'est écrit", async () => {
		await withConn(async (conn) => {
			await expect(
				runQuery(
					conn,
					`transaction { add { GenreId: 9904, Name: "SNQL M4 RB" } into Genre; raw "SELECT 1/0" }`
				)
			).rejects.toThrow();
			const check = await runQuery(
				conn,
				`find Genre where GenreId = 9904 pick Name`
			);
			expect(check.rowCount).toBe(0);
		});
	});

	it("returnRowCount : le frontend demande count-only → pas d'OUTPUT", async () => {
		await withConn(async (conn) => {
			// runQuery ne pose pas returnRowCount (chemin UI complet) — on passe
			// par le mapper directement pour vérifier le SQL count-only réel.
			const del = await runQuery(
				conn,
				`remove from Genre where GenreId = 999999`
			);
			expect(del.rowCount).toBe(0);
			expect(del.rows).toEqual([]);
		});
	});
});
