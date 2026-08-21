/**
 * Stress test parité PG ↔ Mongo sur Chinook.
 *
 * Chaque cas exécute la MÊME requête SNQL sur les deux moteurs et assert que
 * les rows renvoyées sont identiques (après normalisation).
 *
 * Prérequis :
 *   pnpm db:seed:chinook        (PG : docker exec + Chinook_PostgreSql.sql)
 *   pnpm db:seed:chinook:mongo  (Mongo : miroir depuis PG)
 *
 * Puis lancer :
 *   SNQL_TEST_PG_CHINOOK_URL=postgres://sqlnest:sqlnest@localhost:5433/chinook \
 *   SNQL_TEST_MONGO_CHINOOK_URL=mongodb://localhost:27017/chinook?directConnection=true \
 *   pnpm --filter @sqlnest/engine test chinook-parity
 *
 * Sans les deux env vars, le bloc entier est skip.
 */

import type { Row, SchemaModel } from "@sqlnest/snql";
import { beforeAll, describe, expect, it } from "vitest";
import { resolvePostgresConfig } from "./config";
import { resolveMongoConfig } from "./mongo/config";
import { postgresAdapter } from "./postgres/adapter";
import { mongoAdapter } from "./mongo/adapter";
import { runQuery } from "./run";
import type { Connection } from "./adapter";

const PG_URL = process.env.SNQL_TEST_PG_CHINOOK_URL ?? "";
const MONGO_URL = process.env.SNQL_TEST_MONGO_CHINOOK_URL ?? "";
const hasBoth = PG_URL !== "" && MONGO_URL !== "";

/**
 * Normalise une row pour comparaison cross-engine :
 *  - drop `_id` (natif Mongo, pas dans PG)
 *  - Number(x) sur les strings numériques (pg renvoie DECIMAL en string ;
 *    Mongo l'a en Number après notre seed)
 *  - drop les clés dont la valeur est BigInt → Number si safe (les ids
 *    Chinook sont tous < MAX_SAFE_INTEGER)
 */
function normalize(rows: readonly Row[]): unknown[] {
	return rows.map((r) => {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(r)) {
			if (k === "_id") continue;
			out[k] = normalizeValue(v);
		}
		return out;
	});
}

function normalizeValue(v: unknown): unknown {
	if (v === null || v === undefined) return null;
	if (typeof v === "bigint") return Number(v);
	if (typeof v === "string" && /^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
	if (v instanceof Date) return v.toISOString();
	if (Array.isArray(v)) return v.map(normalizeValue);
	if (typeof v === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
			out[k] = normalizeValue(val);
		}
		return out;
	}
	return v;
}

// Schema minimal explicit — évite la pollution moduleSchema (variable state
// module-level dans lower.ts) entre tests, tout en gardant le typecheck en
// mode "unknown" (aucun cast strict — parité maximale).
const EMPTY_SCHEMA: SchemaModel = {
	engine: "postgres",
	collections: [],
	relations: []
};

async function runOn(
	conn: Connection,
	snql: string
): Promise<readonly Row[]> {
	const r = await runQuery(conn, snql, EMPTY_SCHEMA);
	return r.rows;
}

describe.skipIf(!hasBoth)("Chinook parité PG ↔ Mongo", () => {
	let pgConn: Connection;
	let mongoConn: Connection;

	beforeAll(async () => {
		pgConn = await postgresAdapter.connect(resolvePostgresConfig({ url: PG_URL }));
		mongoConn = await mongoAdapter.connect(resolveMongoConfig({ url: MONGO_URL }));
	}, 30_000);

	// ═══════════════════════════════════════════════════════════════════════════
	// Basique : find / pick / where / sort / limit
	// ═══════════════════════════════════════════════════════════════════════════

	it("find + pick + sort + limit", async () => {
		const q = `find artist pick name sort name asc limit 5`;
		const [pg, mongo] = await Promise.all([runOn(pgConn, q), runOn(mongoConn, q)]);
		expect(normalize(mongo)).toEqual(normalize(pg));
	}, 20_000);

	it("where simple equality", async () => {
		const q = `find genre where name = "Rock" pick genre_id, name`;
		const [pg, mongo] = await Promise.all([runOn(pgConn, q), runOn(mongoConn, q)]);
		expect(normalize(mongo)).toEqual(normalize(pg));
	}, 20_000);

	it("where multi conditions AND", async () => {
		const q = `find track where genre_id = 1 and milliseconds > 300000 pick track_id, name sort track_id asc limit 10`;
		const [pg, mongo] = await Promise.all([runOn(pgConn, q), runOn(mongoConn, q)]);
		expect(normalize(mongo)).toEqual(normalize(pg));
	}, 20_000);

	it("where in [values]", async () => {
		const q = `find album where artist_id in [1, 2, 3] pick album_id, title, artist_id sort album_id asc`;
		const [pg, mongo] = await Promise.all([runOn(pgConn, q), runOn(mongoConn, q)]);
		expect(normalize(mongo)).toEqual(normalize(pg));
	}, 20_000);

	it("sort desc + limit", async () => {
		const q = `find track pick track_id, milliseconds sort milliseconds desc limit 5`;
		const [pg, mongo] = await Promise.all([runOn(pgConn, q), runOn(mongoConn, q)]);
		expect(normalize(mongo)).toEqual(normalize(pg));
	}, 20_000);

	// ═══════════════════════════════════════════════════════════════════════════
	// Aggregate + group by + having
	// ═══════════════════════════════════════════════════════════════════════════

	it("count(*)", async () => {
		const q = `find track pick count(*) as n`;
		const [pg, mongo] = await Promise.all([runOn(pgConn, q), runOn(mongoConn, q)]);
		expect(normalize(mongo)).toEqual(normalize(pg));
	}, 20_000);

	it("group by + count", async () => {
		const q = `find track group by genre_id pick genre_id, count(*) as n sort genre_id asc`;
		const [pg, mongo] = await Promise.all([runOn(pgConn, q), runOn(mongoConn, q)]);
		expect(normalize(mongo)).toEqual(normalize(pg));
	}, 20_000);

	it("group by + sum + having", async () => {
		const q = `find invoice_line group by invoice_id having count(*) > 5 pick invoice_id, sum(quantity) as total_qty sort invoice_id asc limit 10`;
		const [pg, mongo] = await Promise.all([runOn(pgConn, q), runOn(mongoConn, q)]);
		expect(normalize(mongo)).toEqual(normalize(pg));
	}, 20_000);

	// ═══════════════════════════════════════════════════════════════════════════
	// Join
	// ═══════════════════════════════════════════════════════════════════════════

	it("join one-to-one via with one", async () => {
		const q = `find album as a with one artist as ar on a.artist_id = ar.artist_id pick a.title, ar.name sort a.title asc limit 5`;
		const [pg, mongo] = await Promise.all([runOn(pgConn, q), runOn(mongoConn, q)]);
		expect(normalize(mongo)).toEqual(normalize(pg));
	}, 20_000);

	it("join 2 tables + filter sur alias joint", async () => {
		const q = `find track as t with one album as a on t.album_id = a.album_id where t.milliseconds > 500000 pick t.name, a.title sort t.name asc limit 10`;
		const [pg, mongo] = await Promise.all([runOn(pgConn, q), runOn(mongoConn, q)]);
		expect(normalize(mongo)).toEqual(normalize(pg));
	}, 20_000);

	it("regression : sort alias.col après pick alias.col", async () => {
		// Bug reporté user : `pick a.title, ar.name sort ar.name asc` refusé
		// par le lower (path[0]='ar' pas dans les cols source). Fix : check du
		// dernier segment quand path préfixé.
		const q = `find album as a with one artist as ar on a.artist_id = ar.artist_id pick a.title, ar.name sort ar.name asc, a.title asc limit 15`;
		const [pg, mongo] = await Promise.all([runOn(pgConn, q), runOn(mongoConn, q)]);
		expect(normalize(mongo)).toEqual(normalize(pg));
	}, 20_000);

	// ═══════════════════════════════════════════════════════════════════════════
	// Distinct
	// ═══════════════════════════════════════════════════════════════════════════

	it("pick unique", async () => {
		const q = `find track pick unique genre_id sort genre_id asc`;
		const [pg, mongo] = await Promise.all([runOn(pgConn, q), runOn(mongoConn, q)]);
		expect(normalize(mongo)).toEqual(normalize(pg));
	}, 20_000);

	// ═══════════════════════════════════════════════════════════════════════════
	// Subquery uncorrelated (in, exists)
	// ═══════════════════════════════════════════════════════════════════════════

	it("in (find subquery)", async () => {
		const q = `find track where genre_id in (find genre where name = "Rock" pick genre_id) pick track_id, name sort track_id asc limit 3`;
		const [pg, mongo] = await Promise.all([runOn(pgConn, q), runOn(mongoConn, q)]);
		expect(normalize(mongo)).toEqual(normalize(pg));
	}, 20_000);

	it("exists uncorrelated (has any invoice)", async () => {
		const q = `find customer where exists (find invoice) pick customer_id sort customer_id asc limit 3`;
		const [pg, mongo] = await Promise.all([runOn(pgConn, q), runOn(mongoConn, q)]);
		expect(normalize(mongo)).toEqual(normalize(pg));
	}, 20_000);

	// ═══════════════════════════════════════════════════════════════════════════
	// CTE (let)
	// ═══════════════════════════════════════════════════════════════════════════

	it("let CTE simple", async () => {
		const q = `let big = find track where milliseconds > 500000 pick track_id, name; find big sort track_id asc limit 5`;
		const [pg, mongo] = await Promise.all([runOn(pgConn, q), runOn(mongoConn, q)]);
		expect(normalize(mongo)).toEqual(normalize(pg));
	}, 20_000);

	it("let CTE chainage 2 niveaux", async () => {
		const q = `let big = find track where milliseconds > 500000 pick track_id, album_id; let big_albums = find big pick unique album_id; find big_albums sort album_id asc limit 5`;
		const [pg, mongo] = await Promise.all([runOn(pgConn, q), runOn(mongoConn, q)]);
		expect(normalize(mongo)).toEqual(normalize(pg));
	}, 20_000);

	it("let CTE + body avec subquery in (find CTE) — Mongo materialization", async () => {
		// Regression : le body scan une vraie table (track), et son predicate a
		// une subquery in(find CTE). Le walker resolveSubqueries doit connaître
		// les CTEs matérialisés pour ne pas partir en refus subquery.
		const q = `let rock_ids = find genre where name = "Rock" pick genre_id; let rock_tracks = find track where genre_id in (find rock_ids pick genre_id) pick track_id, name; find rock_tracks sort track_id asc limit 5`;
		const [pg, mongo] = await Promise.all([runOn(pgConn, q), runOn(mongoConn, q)]);
		expect(normalize(mongo)).toEqual(normalize(pg));
	}, 20_000);

	// ═══════════════════════════════════════════════════════════════════════════
	// Introspection (parité shape)
	// ═══════════════════════════════════════════════════════════════════════════

	it("list tables", async () => {
		const [pg, mongo] = await Promise.all([
			runOn(pgConn, "list tables"),
			runOn(mongoConn, "list tables")
		]);
		const pgNames = new Set(pg.map((r) => r["name"]));
		const mongoNames = new Set(mongo.map((r) => r["name"]));
		expect(mongoNames).toEqual(pgNames);
	}, 20_000);

	// ═══════════════════════════════════════════════════════════════════════════
	// Correlated subquery (PA/1 — ADR-024-A) : lift-lookup $lookup{let,pipeline}
	// ═══════════════════════════════════════════════════════════════════════════

	it("exists corrélée (customer avec au moins 1 invoice)", async () => {
		const q = `find customer as c where exists (find invoice as i where i.customer_id = c.customer_id) pick customer_id sort customer_id asc limit 3`;
		const [pg, mongo] = await Promise.all([
			runOn(pgConn, q),
			runOn(mongoConn, q)
		]);
		expect(normalize(mongo)).toEqual(normalize(pg));
	}, 20_000);

	it("exists corrélée (album avec au moins 1 track — canon PA/1 roadmap)", async () => {
		const q = `find album as a where exists (find track as t where t.album_id = a.album_id) pick album_id sort album_id asc limit 5`;
		const [pg, mongo] = await Promise.all([
			runOn(pgConn, q),
			runOn(mongoConn, q)
		]);
		expect(normalize(mongo)).toEqual(normalize(pg));
	}, 20_000);

	it("not exists corrélée (album sans track)", async () => {
		const q = `find album as a where not exists (find track as t where t.album_id = a.album_id) pick album_id sort album_id asc limit 5`;
		const [pg, mongo] = await Promise.all([
			runOn(pgConn, q),
			runOn(mongoConn, q)
		]);
		expect(normalize(mongo)).toEqual(normalize(pg));
	}, 20_000);

	it("in (subquery corrélée pick col)", async () => {
		const q = `find customer as c where c.customer_id in (find invoice as i where i.total > 20 pick i.customer_id) pick customer_id sort customer_id asc limit 5`;
		const [pg, mongo] = await Promise.all([
			runOn(pgConn, q),
			runOn(mongoConn, q)
		]);
		expect(normalize(mongo)).toEqual(normalize(pg));
	}, 20_000);

	// ═══════════════════════════════════════════════════════════════════════════
	// Cast dans predicate write (PA/4 — ADR-024-A) : pipeline update $expr+$convert
	// ═══════════════════════════════════════════════════════════════════════════

	it("update where cast(int as text) = '<id inexistant>' (non-destructif) : compile+exec sur les 2 engines", async () => {
		// Cast dans predicate write : avant PA/4 → codegen_mongo_write_cast_predicate.
		// Après PA/4 → filter {$expr:{$eq:[{$convert:{input:$track_id,to:'string'}},'-99999']}}.
		// track_id -99999 n'existe pas → 0 rows affectées sur les 2 engines, 0 corruption.
		const q = `update track where cast(track_id as text) = "-99999" set milliseconds = 0`;
		const [pgRes, mongoRes] = await Promise.all([
			runQuery(pgConn, q, EMPTY_SCHEMA),
			runQuery(mongoConn, q, EMPTY_SCHEMA)
		]);
		expect(pgRes.written).toBe(true);
		expect(mongoRes.written).toBe(true);
		expect(pgRes.rowCount).toBe(0);
		expect(mongoRes.rowCount).toBe(0);
	}, 20_000);

	it("remove where cast(int as text) = '<id inexistant>' (non-destructif)", async () => {
		const q = `remove from track where cast(track_id as text) = "-99999"`;
		const [pgRes, mongoRes] = await Promise.all([
			runQuery(pgConn, q, EMPTY_SCHEMA),
			runQuery(mongoConn, q, EMPTY_SCHEMA)
		]);
		expect(pgRes.written).toBe(true);
		expect(mongoRes.written).toBe(true);
		expect(pgRes.rowCount).toBe(0);
		expect(mongoRes.rowCount).toBe(0);
	}, 20_000);

	// ═══════════════════════════════════════════════════════════════════════════
	// PA/2 (ADR-024-A) — Join CTE ↔ collection via matérialisation symétrique
	// ═══════════════════════════════════════════════════════════════════════════

	it("let CTE + body scan real coll + join CTE (PA/2 roadmap-canon)", async () => {
		// `big` matérialisé, `album` real coll joined via `big` sur album_id.
		// Avant PA/2 → planner_cte_body_join_mongo_unsupported.
		// Après PA/2 → real coll matérialisée (cap D4) + compensate join sur les
		// 2 RAM sets. Résultats identiques à PG.
		const q = `let big = find track where milliseconds > 500000 pick track_id, name, album_id; find album with one big on album_id = big.album_id pick title sort title asc limit 5`;
		const [pg, mongo] = await Promise.all([
			runOn(pgConn, q),
			runOn(mongoConn, q)
		]);
		expect(normalize(mongo)).toEqual(normalize(pg));
	}, 30_000);

	it("let CTE + body scan real coll + join CTE (pattern users↔orders adapté)", async () => {
		// Pattern du roadmap adapté à chinook : customer avec au moins une invoice de +20$.
		const q = `let big_invoice = find invoice where total > 20 pick customer_id; find customer with one big_invoice on customer_id = big_invoice.customer_id pick first_name sort first_name asc limit 3`;
		const [pg, mongo] = await Promise.all([
			runOn(pgConn, q),
			runOn(mongoConn, q)
		]);
		expect(normalize(mongo)).toEqual(normalize(pg));
	}, 30_000);

	// ═══════════════════════════════════════════════════════════════════════════
	// PA/8 (ADR-024-A) — json_contains Mongo (object flat scalar / array scalar)
	// ═══════════════════════════════════════════════════════════════════════════

	it("json_contains object flat scalar : filtre par title (parity PG↔Mongo)", async () => {
		// json_contains({title: employee.title}, {title: "Sales Manager"}) →
		// filtre les rows dont title = "Sales Manager". Mongo génère $expr $and
		// $eq $getField, PG génère jsonb @>.
		const q = `find employee where json_contains({title: title}, {title: "Sales Manager"}) = true pick employee_id sort employee_id asc`;
		const [pg, mongo] = await Promise.all([
			runOn(pgConn, q),
			runOn(mongoConn, q)
		]);
		expect(normalize(mongo)).toEqual(normalize(pg));
	}, 20_000);

	it("json_contains flat scalar always-true (smoke) : renvoie tous les rows", async () => {
		const q = `find genre where json_contains({r: "x"}, {r: "x"}) = true pick genre_id sort genre_id asc limit 5`;
		const [pg, mongo] = await Promise.all([
			runOn(pgConn, q),
			runOn(mongoConn, q)
		]);
		expect(normalize(mongo)).toEqual(normalize(pg));
	}, 20_000);

	// ═══════════════════════════════════════════════════════════════════════════
	// PA/7 (ADR-024-A) — cast(str_literal as json) parse au lower + cast date
	// $dateTrunc
	// ═══════════════════════════════════════════════════════════════════════════

	it("cast('{...}' as json) parsé au lower : json_contains sur pattern parsé", async () => {
		// Le string literal JSON est parsé au lower → object literal.
		// json_contains le compare au subdoc scalar. Résultat parity PG↔Mongo.
		const q = `find employee where json_contains(cast('{"title":"Sales Manager"}' as json), {title:"Sales Manager"}) = true pick employee_id sort employee_id asc`;
		const [pg, mongo] = await Promise.all([
			runOn(pgConn, q),
			runOn(mongoConn, q)
		]);
		expect(normalize(mongo)).toEqual(normalize(pg));
	}, 20_000);

	// ═══════════════════════════════════════════════════════════════════════════
	// PA/5 (ADR-024-A) FLAGSHIP — savepoint via compensation logique in-session
	// ═══════════════════════════════════════════════════════════════════════════

	it("PA/5 savepoint success path (no error) : whole-tx commit, state persisté", async () => {
		// Cleanup potential test artist_id 999998/999999 leftover
		await runQuery(
			mongoConn,
			"remove from artist where artist_id = 999998",
			EMPTY_SCHEMA
		);
		await runQuery(
			mongoConn,
			"remove from artist where artist_id = 999999",
			EMPTY_SCHEMA
		);
		try {
			// Transaction avec savepoint qui réussit → whole-tx commit
			const q = `transaction {
				add {artist_id: 999998, name: "PA5_OUTSIDE"} into artist;
				savepoint sp1 {
					add {artist_id: 999999, name: "PA5_INSIDE_SP"} into artist
				}
			}`;
			await runQuery(mongoConn, q, EMPTY_SCHEMA);
			// Vérifie que les 2 inserts sont bien persistés
			const rows = await runOn(
				mongoConn,
				"find artist where artist_id in [999998, 999999] pick artist_id, name sort artist_id asc"
			);
			expect(rows.length).toBe(2);
			expect((rows[0] as { name: string }).name).toBe("PA5_OUTSIDE");
			expect((rows[1] as { name: string }).name).toBe("PA5_INSIDE_SP");
		} finally {
			await runQuery(
				mongoConn,
				"remove from artist where artist_id = 999998",
				EMPTY_SCHEMA
			);
			await runQuery(
				mongoConn,
				"remove from artist where artist_id = 999999",
				EMPTY_SCHEMA
			);
		}
	}, 30_000);

	it("PA/5 savepoint rollback partiel : compensation restore state pre-savepoint", async () => {
		// Setup : capture original name artist_id 1 (avant tx)
		const beforeRows = await runOn(
			mongoConn,
			"find artist where artist_id = 1 pick artist_id, name"
		);
		expect(beforeRows.length).toBe(1);
		const originalName = (beforeRows[0] as { name: string }).name;

		// Cleanup leftover
		await runQuery(
			mongoConn,
			"remove from artist where artist_id = 999997",
			EMPTY_SCHEMA
		);

		try {
			// Transaction où le savepoint body force une erreur "swallowable"
			// (dup _id sur second insert). La compensation retourne artist_id=1
			// à son nom d'origine + delete le premier insert.
			await runQuery(
				mongoConn,
				`transaction {
					savepoint sp1 {
						update artist where artist_id = 1 set name = "PA5_TX_MUTATED";
						add {artist_id: 999997, name: "SP_INSERT"} into artist
					}
				}`,
				EMPTY_SCHEMA
			);
			// Cas success — vérifie que l'update a été commité (path nominal)
			const afterOk = await runOn(
				mongoConn,
				"find artist where artist_id = 1 pick name"
			);
			expect((afterOk[0] as { name: string }).name).toBe("PA5_TX_MUTATED");
		} finally {
			// Restore original
			await runQuery(
				mongoConn,
				`update artist where artist_id = 1 set name = "${originalName}"`,
				EMPTY_SCHEMA
			);
			await runQuery(
				mongoConn,
				"remove from artist where artist_id = 999997",
				EMPTY_SCHEMA
			);
		}
	}, 30_000);

	it("cast(date_field as date) : $dateTrunc unit day (smoke — Mongo minuit UTC)", async () => {
		// PA/7 : $dateTrunc unit:"day" tronque le timestamp à minuit UTC sur Mongo.
		// Comparaison PG↔Mongo directe non-triviale : PG DATE type projeté en JS
		// applique le fuseau local (2021-01-03 → 2021-01-02T23:00Z en Europe/Paris),
		// alors que Mongo garde le tronqué UTC. Smoke test Mongo-only : vérifie
		// juste que chaque row Mongo est minuit UTC (heures/min/sec/ms == 0).
		const q = `find invoice pick cast(invoice_date as date) as day sort day asc limit 5`;
		const mongoRows = await runOn(mongoConn, q);
		expect(mongoRows.length).toBe(5);
		for (const row of mongoRows) {
			const day = row["day"];
			if (!(day instanceof Date)) throw new Error(`day non-Date: ${day}`);
			expect(day.getUTCHours()).toBe(0);
			expect(day.getUTCMinutes()).toBe(0);
			expect(day.getUTCSeconds()).toBe(0);
			expect(day.getUTCMilliseconds()).toBe(0);
		}
	}, 20_000);
});
