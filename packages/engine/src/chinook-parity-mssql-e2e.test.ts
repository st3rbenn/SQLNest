/**
 * Parité PG ↔ MSSQL sur Chinook (chantier M/5) — troisième moteur du banc.
 *
 * Chaque cas exécute la MÊME requête SNQL sur les deux moteurs et assert que
 * les rows sont identiques (après normalisation). PG = référence (comme pour
 * la parité PG ↔ Mongo). Le seed MSSQL est renommé snake_case (M/5a) pour la
 * parité nominale.
 *
 * Prérequis :
 *   pnpm db:seed:chinook        (PG)
 *   pnpm db:seed:chinook:mssql  (MSSQL, renommage snake_case inclus)
 *
 * Sans les deux env vars, le bloc est skip :
 *   SNQL_TEST_PG_CHINOOK_URL=postgres://sqlnest:sqlnest@localhost:5433/chinook
 *   SNQL_TEST_MSSQL_URL=mssql://sa:...@localhost:1433/Chinook?trustServerCertificate=true
 *
 * Hors banc (couverts par les tests int mssql dédiés, pas comparables ici) :
 * json_contains / array_agg / json_agg (fonctions absentes du set mssql M/3,
 * refus planner par matrice) et l'introspection (shapes de types par moteur).
 */

import type { Row, SchemaModel } from "@sqlnest/snql";
import { beforeAll, describe, it, expect, afterAll } from "vitest";
import type { Connection } from "./adapter";
import { resolvePostgresConfig } from "./config";
import { resolveMssqlConfig } from "./mssql/config";
import { mssqlAdapter } from "./mssql/adapter";
import { postgresAdapter } from "./postgres/adapter";
import { runQuery } from "./run";

const PG_URL = process.env.SNQL_TEST_PG_CHINOOK_URL ?? "";
const MSSQL_URL = process.env.SNQL_TEST_MSSQL_URL ?? "";
const hasBoth = PG_URL !== "" && MSSQL_URL !== "";

/** Normalisation cross-engine — miroir de chinook-parity-e2e (PG↔Mongo) :
 *  strings numériques → Number (pg DECIMAL/COUNT bigint en string, tedious
 *  COUNT_BIG en string), bigint → Number, Date → ISO. */
function normalize(rows: readonly Row[]): unknown[] {
	return rows.map((r) => {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(r)) {
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

const EMPTY_SCHEMA: SchemaModel = {
	engine: "postgres",
	collections: [],
	relations: []
};

async function runOn(conn: Connection, snql: string): Promise<readonly Row[]> {
	const r = await runQuery(conn, snql, EMPTY_SCHEMA);
	return r.rows;
}

describe.skipIf(!hasBoth)("Chinook parité PG ↔ MSSQL", () => {
	let pgConn: Connection;
	let mssqlConn: Connection;

	beforeAll(async () => {
		pgConn = await postgresAdapter.connect(
			resolvePostgresConfig({ url: PG_URL })
		);
		mssqlConn = await mssqlAdapter.connect(
			resolveMssqlConfig({ url: MSSQL_URL })
		);
	}, 30_000);

	afterAll(async () => {
		await pgConn?.close();
		await mssqlConn?.close();
	});

	async function expectParity(q: string): Promise<void> {
		const [pg, ms] = await Promise.all([
			runOn(pgConn, q),
			runOn(mssqlConn, q)
		]);
		expect(normalize(ms)).toEqual(normalize(pg));
	}

	// ─── Basique ────────────────────────────────────────────────────────
	// ⚠ Collation : l'ordre d'un tri STRING est moteur-dépendant
	// (SQL_Latin1_General_CP1_CI_AS ignore casse/ponctuation autrement que la
	// libc PG — « AC/DC » se classe différemment). Divergence de moteur
	// assumée, pas de SNQL : les cas de tri string sont bornés à des plages
	// sans collision de casse/ponctuation ; le reste trie sur des clés
	// numériques (déterministes partout).
	it("find + pick + sort string + limit (plage sans piège de collation)", async () => {
		await expectParity(
			`find artist where artist_id <= 5 pick name sort name asc limit 5`
		);
	}, 20_000);

	it("where equality", async () => {
		await expectParity(`find genre where name = "Rock" pick genre_id, name`);
	}, 20_000);

	it("where AND multi conditions", async () => {
		await expectParity(
			`find track where genre_id = 1 and milliseconds > 300000 pick track_id, name sort track_id asc limit 10`
		);
	}, 20_000);

	it("where in [values]", async () => {
		await expectParity(
			`find album where artist_id in [1, 2, 3] pick album_id, title, artist_id sort album_id asc`
		);
	}, 20_000);

	it("limit + offset (OFFSET-FETCH vs LIMIT/OFFSET)", async () => {
		await expectParity(
			`find artist pick artist_id, name sort artist_id asc limit 5 offset 10`
		);
	}, 20_000);

	// ─── Aggregate / group / having ─────────────────────────────────────
	it("count(*)", async () => {
		await expectParity(`find track pick count(*) as n`);
	}, 20_000);

	it("group by + count", async () => {
		await expectParity(
			`find track group by genre_id pick genre_id, count(*) as n sort genre_id asc`
		);
	}, 20_000);

	it("having + sum", async () => {
		await expectParity(
			`find invoice_line group by invoice_id having count(*) > 5 pick invoice_id, sum(quantity) as total_qty sort invoice_id asc limit 10`
		);
	}, 20_000);

	it("avg float (AVG int T-SQL aurait tronqué)", async () => {
		await expectParity(
			`find track group by genre_id pick genre_id, avg(milliseconds) as avg_ms sort genre_id asc limit 5`
		);
	}, 20_000);

	// ─── Joins ──────────────────────────────────────────────────────────
	it("with one (LEFT JOIN) pick qualifié", async () => {
		await expectParity(
			`find album as a with one artist as ar on a.artist_id = ar.artist_id where a.album_id <= 5 pick a.album_id, a.title, ar.name sort a.album_id asc`
		);
	}, 20_000);

	it("with one + where sur la base", async () => {
		await expectParity(
			`find track as t with one album as a on t.album_id = a.album_id where t.milliseconds > 500000 pick t.name, a.title sort t.name asc limit 10`
		);
	}, 20_000);

	// ─── Distinct ───────────────────────────────────────────────────────
	it("pick unique", async () => {
		await expectParity(`find track pick unique genre_id sort genre_id asc`);
	}, 20_000);

	// ─── Subqueries ─────────────────────────────────────────────────────
	it("in (find …) subquery", async () => {
		await expectParity(
			`find track where genre_id in (find genre where name = "Rock" pick genre_id) pick track_id, name sort track_id asc limit 3`
		);
	}, 20_000);

	it("exists corrélé", async () => {
		await expectParity(
			`find album as a where exists (find track as t where t.album_id = a.album_id) pick album_id sort album_id asc limit 5`
		);
	}, 20_000);

	it("not exists corrélé", async () => {
		await expectParity(
			`find album as a where not exists (find track as t where t.album_id = a.album_id) pick album_id sort album_id asc limit 5`
		);
	}, 20_000);

	// ─── Fonctions ──────────────────────────────────────────────────────
	it("upper/length/concat", async () => {
		await expectParity(
			`find artist where artist_id <= 3 pick upper(name) as u, length(name) as l, concat(name, "!") as c sort artist_id asc`
		);
	}, 20_000);

	it("coalesce + nullif", async () => {
		await expectParity(
			`find track where track_id <= 5 pick coalesce(composer, "inconnu") as comp, nullif(genre_id, 1) as g sort track_id asc`
		);
	}, 20_000);

	it("date_part sur invoice_date", async () => {
		await expectParity(
			`find invoice where invoice_id <= 5 pick invoice_id, date_part("year", invoice_date) as y, date_part("month", invoice_date) as m sort invoice_id asc`
		);
	}, 20_000);

	it("if + arith", async () => {
		await expectParity(
			`find track where track_id <= 5 pick track_id, if(milliseconds > 300000, "long", "court") as cat, round(unit_price * 2, 2) as double_price sort track_id asc`
		);
	}, 20_000);

	// ─── Window ─────────────────────────────────────────────────────────
	it("row_number() over partition", async () => {
		await expectParity(
			`find track where album_id in [1, 2] pick track_id, row_number() over (partition album_id sort track_id) as rn sort track_id asc`
		);
	}, 20_000);

	// ─── let / let rec (CTE natifs des deux côtés) ──────────────────────
	it("let simple", async () => {
		await expectParity(
			`let heavy = find track where milliseconds > 3000000; find heavy pick name sort name asc limit 5`
		);
	}, 20_000);

	it("let rec org chart (INNER forcé sur la réf récursive — fix cross-engine)", async () => {
		await expectParity(
			`let rec org = find employee where reports_to = null pick employee_id, first_name union all find employee as e with one org as o on e.reports_to = o.employee_id pick e.employee_id, e.first_name; find org pick employee_id, first_name sort employee_id asc limit 20`
		);
	}, 20_000);

	// ─── Écritures round-trip (état remis à l'identique) ────────────────
	it("insert/update/delete parité OUTPUT vs RETURNING", async () => {
		const cleanup = `remove from genre where genre_id = 9970`;
		await runOn(pgConn, cleanup);
		await runOn(mssqlConn, cleanup);
		try {
			await expectParity(`add { genre_id: 9970, name: "Parity M5" } into genre`);
			await expectParity(
				`edit genre where genre_id = 9970 set name = "Parity M5 edited"`
			);
			await expectParity(`remove from genre where genre_id = 9970`);
		} finally {
			await runOn(pgConn, cleanup);
			await runOn(mssqlConn, cleanup);
		}
	}, 30_000);
});
