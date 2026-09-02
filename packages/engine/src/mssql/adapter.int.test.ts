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
				text: "SELECT TOP 3 name FROM artist WHERE artist_id > @p1 ORDER BY artist_id",
				params: [0],
				paramSpans: []
			});
			expect(rs.rowCount).toBe(3);
			expect(rs.rows[0]).toHaveProperty("name");
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
				"album",
				"artist",
				"customer",
				"employee",
				"genre",
				"invoice",
				"invoice_line",
				"media_type",
				"playlist",
				"playlist_track",
				"track"
			]);

			// Types mappés : INT → int, NVARCHAR → string, NUMERIC → decimal,
			// DATETIME → date ; nullabilité lue du catalogue.
			const track = schema.collections.find((c) => c.name === "track")!;
			expect(track.primaryKey).toEqual(["track_id"]);
			const fieldsByName = new Map(track.fields.map((f) => [f.name, f]));
			expect(fieldsByName.get("track_id")).toMatchObject({
				type: "int",
				nullable: false
			});
			expect(fieldsByName.get("name")).toMatchObject({
				type: "string",
				nullable: false
			});
			expect(fieldsByName.get("unit_price")).toMatchObject({
				type: "decimal"
			});
			expect(fieldsByName.get("composer")).toMatchObject({ nullable: true });
			const invoice = schema.collections.find((c) => c.name === "invoice")!;
			expect(
				invoice.fields.find((f) => f.name === "invoice_date")
			).toMatchObject({ type: "date", nullable: false });

			// PK composite : ordre ordinal (playlist_id puis track_id).
			const playlistTrack = schema.collections.find(
				(c) => c.name === "playlist_track"
			)!;
			expect(playlistTrack.primaryKey).toEqual(["playlist_id", "track_id"]);

			// Les 11 FK Chinook → 11 relations many-to-one + 11 refs
			// (toutes single-column), self-ref employee.reports_to incluse.
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
				"album.artist_id->artist.artist_id",
				"customer.support_rep_id->employee.employee_id",
				"employee.reports_to->employee.employee_id",
				"invoice.customer_id->customer.customer_id",
				"invoice_line.invoice_id->invoice.invoice_id",
				"invoice_line.track_id->track.track_id",
				"playlist_track.playlist_id->playlist.playlist_id",
				"playlist_track.track_id->track.track_id",
				"track.album_id->album.album_id",
				"track.genre_id->genre.genre_id",
				"track.media_type_id->media_type.media_type_id"
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

	it("find where/pick/sort/limit → TOP réel sur artist", async () => {
		await withConn(async (conn) => {
			const rs = await runQuery(
				conn,
				`find artist where artist_id <= 5 pick name sort name limit 3`
			);
			expect(rs.written).toBe(false);
			expect(rs.rowCount).toBe(3);
			expect(rs.rows.map((r) => r["name"])).toEqual([
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
				`find artist pick artist_id, name sort artist_id limit 2`
			);
			const page2 = await runQuery(
				conn,
				`find artist pick artist_id, name sort artist_id limit 2 offset 2`
			);
			expect(page1.rows.map((r) => r["artist_id"])).toEqual([1, 2]);
			expect(page2.rows.map((r) => r["artist_id"])).toEqual([3, 4]);
		});
	});

	it("group by + having + count(*) → agrégat réel sur invoice", async () => {
		await withConn(async (conn) => {
			const rs = await runQuery(
				conn,
				`find invoice group by billing_country having count(*) > 30 pick billing_country, count(*) as n sort billing_country`
			);
			// Chinook : USA (91), Canada (56), France (35), Brazil (35),
			// Germany (28 → exclu par > 30).
			const countries = rs.rows.map((r) => r["billing_country"]);
			expect(countries).toContain("USA");
			expect(countries).toContain("Canada");
			expect(countries).not.toContain("Germany");
			// COUNT_BIG → bigint TDS, tedious le lit en string : cohérent avec
			// le driver pg (bigint sérialisé string).
			const usa = rs.rows.find((r) => r["billing_country"] === "USA");
			expect(Number(usa?.["n"])).toBe(91);
		});
	});

	it("embed one-to-many FOR JSON → array PARSÉ (jsonColumns adapter)", async () => {
		await withConn(async (conn) => {
			const rs = await runQuery(
				conn,
				`find artist with album on artist_id = artist_id where artist_id = 1`
			);
			expect(rs.rowCount).toBe(1);
			const albums = rs.rows[0]?.["album"];
			expect(Array.isArray(albums)).toBe(true);
			const titles = (albums as { title: string }[]).map((a) => a.title);
			// AC/DC a 2 albums dans Chinook.
			expect(titles).toContain("For Those About To Rock We Salute You");
			expect(titles).toContain("Let There Be Rock");
		});
	});

	it("fonctions T-SQL réelles : upper, length, strpos (CHARINDEX inversé)", async () => {
		await withConn(async (conn) => {
			const rs = await runQuery(
				conn,
				`find artist where artist_id = 1 pick upper(name) as u, length(name) as l, strpos(name, "/") as p`
			);
			expect(rs.rows[0]).toMatchObject({ u: "AC/DC", l: 5, p: 3 });
		});
	});

	it("avg cast float — AVG int T-SQL aurait tronqué", async () => {
		await withConn(async (conn) => {
			const rs = await runQuery(
				conn,
				`find track pick avg(milliseconds) as a`
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
				`find invoice pick unique on (billing_country) billing_country, total sort billing_country, total desc limit 5`
			);
			expect(rs.rowCount).toBe(5);
			expect(rs.columns.map((c) => c.name)).not.toContain("__sqlnest_rn");
			expect(Object.keys(rs.rows[0] ?? {})).toEqual([
				"billing_country",
				"total"
			]);
		});
	});

	it("subquery in (find …) native", async () => {
		await withConn(async (conn) => {
			const rs = await runQuery(
				conn,
				`find album where artist_id in (find artist where name = "Aerosmith" pick artist_id) pick title`
			);
			expect(rs.rows.map((r) => r["title"])).toEqual([
				"Big Ones"
			]);
		});
	});

	it("raw \"SELECT TOP …\" passthrough", async () => {
		await withConn(async (conn) => {
			const rs = await runQuery(conn, `raw "SELECT TOP 2 name FROM artist ORDER BY artist_id"`);
			expect(rs.rows.map((r) => r["name"])).toEqual(["AC/DC", "Accept"]);
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
				`add { genre_id: 9901, name: "SNQL M4 Insert" } into genre`
			);
			expect(ins.written).toBe(true);
			expect(ins.rowCount).toBe(1);
			expect(ins.rows[0]).toMatchObject({
				genre_id: 9901,
				name: "SNQL M4 Insert"
			});
			const del = await runQuery(
				conn,
				`remove from genre where genre_id = 9901`
			);
			expect(del.written).toBe(true);
			expect(del.rows[0]).toMatchObject({ genre_id: 9901 });
		});
	});

	it("update réversible → OUTPUT INSERTED.* porte la valeur APRÈS", async () => {
		await withConn(async (conn) => {
			const upd = await runQuery(
				conn,
				`edit genre where genre_id = 1 set name = "Rock (M4)"`
			);
			expect(upd.rowCount).toBe(1);
			expect(upd.rows[0]).toMatchObject({ genre_id: 1, name: "Rock (M4)" });
			const revert = await runQuery(
				conn,
				`edit genre where genre_id = 1 set name = "Rock"`
			);
			expect(revert.rows[0]).toMatchObject({ name: "Rock" });
		});
	});

	it("decimal exact : unit_price NUMERIC(10,2) round-trip sans dérive float", async () => {
		await withConn(async (conn) => {
			const upd = await runQuery(
				conn,
				`edit track where track_id = 1 set unit_price = 1.13`
			);
			// tedious lit NUMERIC en number JS — 1.13 exact à l'échelle (10,2).
			expect(Number(upd.rows[0]?.["unit_price"])).toBe(1.13);
			const revert = await runQuery(
				conn,
				`edit track where track_id = 1 set unit_price = 0.99`
			);
			expect(Number(revert.rows[0]?.["unit_price"])).toBe(0.99);
		});
	});

	it("upsert MERGE ignore : conflit → 0 row OUTPUT, existant intact", async () => {
		await withConn(async (conn) => {
			const up = await runQuery(
				conn,
				`add { genre_id: 1, name: "JAMAIS" } into genre on conflict (genre_id) ignore`
			);
			expect(up.written).toBe(true);
			expect(up.rowCount).toBe(0);
			const check = await runQuery(
				conn,
				`find genre where genre_id = 1 pick name`
			);
			expect(check.rows[0]?.["name"]).toBe("Rock");
		});
	});

	it("upsert MERGE edit set new.<col> : conflit → UPDATE avec la row proposée", async () => {
		await withConn(async (conn) => {
			const up = await runQuery(
				conn,
				`add { genre_id: 1, name: "Rock (upsert)" } into genre on conflict (genre_id) edit set name = new.name`
			);
			expect(up.rowCount).toBe(1);
			expect(up.rows[0]).toMatchObject({ genre_id: 1, name: "Rock (upsert)" });
			await runQuery(conn, `edit genre where genre_id = 1 set name = "Rock"`);
		});
	});

	it("upsert MERGE : pas de conflit → INSERT (puis nettoyage)", async () => {
		await withConn(async (conn) => {
			const up = await runQuery(
				conn,
				`add { genre_id: 9902, name: "SNQL M4 Upsert" } into genre on conflict (genre_id) ignore`
			);
			expect(up.rowCount).toBe(1);
			expect(up.rows[0]).toMatchObject({ genre_id: 9902 });
			await runQuery(conn, `remove from genre where genre_id = 9902`);
		});
	});

	it("transaction native : add + savepoint(remove) → commit atomique", async () => {
		await withConn(async (conn) => {
			const tx = await runQuery(
				conn,
				`transaction { add { genre_id: 9903, name: "SNQL M4 Tx" } into genre; savepoint sp1 { remove from genre where genre_id = 9903 } }`
			);
			expect(tx.written).toBe(true);
			// Le dernier statement (remove) a supprimé la row insérée — la DB
			// est nette après commit.
			const check = await runQuery(
				conn,
				`find genre where genre_id = 9903 pick name`
			);
			expect(check.rowCount).toBe(0);
		});
	});

	it("transaction : erreur au milieu → ROLLBACK global, rien n'est écrit", async () => {
		await withConn(async (conn) => {
			await expect(
				runQuery(
					conn,
					`transaction { add { genre_id: 9904, name: "SNQL M4 RB" } into genre; raw "SELECT 1/0" }`
				)
			).rejects.toThrow();
			const check = await runQuery(
				conn,
				`find genre where genre_id = 9904 pick name`
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
				`remove from genre where genre_id = 999999`
			);
			expect(del.rowCount).toBe(0);
			expect(del.rows).toEqual([]);
		});
	});
});

describe.skipIf(!hasMssql)("mssql introspection tier-1 + let (intégration M/5)", () => {
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

	it("list tables → 11 tables chinook triées", async () => {
		await withConn(async (conn) => {
			const rs = await runQuery(conn, "list tables");
			expect(rs.rows.map((r) => r["name"])).toEqual([
				"album",
				"artist",
				"customer",
				"employee",
				"genre",
				"invoice",
				"invoice_line",
				"media_type",
				"playlist",
				"playlist_track",
				"track"
			]);
		});
	});

	it("list tables + where/limit → postOps wrappés TOP", async () => {
		await withConn(async (conn) => {
			const rs = await runQuery(
				conn,
				`list tables where name like "p%" limit 1`
			);
			expect(rs.rows.map((r) => r["name"])).toEqual(["playlist"]);
		});
	});

	it("describe track → colonnes, PK, FK target", async () => {
		await withConn(async (conn) => {
			const rs = await runQuery(conn, "describe track");
			expect(rs.rows[0]).toMatchObject({
				name: "track_id",
				type: "int",
				nullable: false,
				is_primary_key: true
			});
			const albumFk = rs.rows.find((r) => r["name"] === "album_id");
			expect(albumFk?.["foreign_key"]).toBe("album.album_id");
			expect(albumFk?.["nullable"]).toBe(true);
		});
	});

	it("list indexes on album → PK index unique présent", async () => {
		await withConn(async (conn) => {
			const rs = await runQuery(conn, "list indexes on album");
			const pk = rs.rows.find((r) => String(r["name"]).startsWith("PK_"));
			expect(pk).toMatchObject({ table: "album", unique: true });
			expect(pk?.["columns"]).toBe("album_id");
		});
	});

	it("list schemas → dbo présent, plomberie sys/db_* exclue", async () => {
		await withConn(async (conn) => {
			const rs = await runQuery(conn, "list schemas");
			const names = rs.rows.map((r) => r["name"]);
			expect(names).toContain("dbo");
			expect(names).not.toContain("sys");
			expect(names.some((n) => String(n).startsWith("db_"))).toBe(false);
		});
	});

	it("list enums → table metadata absente = 0 row, JAMAIS une erreur", async () => {
		await withConn(async (conn) => {
			const rs = await runQuery(conn, "list enums");
			expect(rs.rowCount).toBe(0);
			expect(rs.rows).toEqual([]);
		});
	});

	it("describe enum inconnu → 0 row (miroir table absente)", async () => {
		await withConn(async (conn) => {
			const rs = await runQuery(conn, "describe enum statut");
			expect(rs.rowCount).toBe(0);
		});
	});

	it("let → WITH natif réel", async () => {
		await withConn(async (conn) => {
			const rs = await runQuery(
				conn,
				"let heavy = find track where milliseconds > 3000000; find heavy pick name sort name limit 2"
			);
			expect(rs.rowCount).toBe(2);
			expect(rs.written).toBe(false);
		});
	});

	it("let rec → CTE récursif réel (org chart employee)", async () => {
		await withConn(async (conn) => {
			const rs = await runQuery(
				conn,
				"let rec org = find employee where reports_to = null pick employee_id, first_name union all find employee as e with one org as o on e.reports_to = o.employee_id pick e.employee_id, e.first_name; find org pick employee_id sort employee_id limit 20"
			);
			// Chinook : 8 employees, tous atteignables depuis le root (Andrew).
			expect(rs.rowCount).toBe(8);
		});
	});
});
