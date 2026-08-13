/**
 * Tests E2E parité cross-engine pour les 13 fonctions du sprint 3. Vérifie
 * que le SQL PG et le pipeline Mongo générés portent la même sémantique —
 * NULL propagation, indexing 1-based, whitelists unit, divergences documentées.
 *
 * Ces tests ne s'exécutent pas contre une vraie base — ils asservissent le
 * shape des sorties générées, ce qui protège contre les régressions codegen
 * (naming, mapping unit, ordre args, cast intermédiaire). L'exécution réelle
 * contre PG/Mongo est prévue dans un pipeline CI dédié plus tard.
 */

import { describe, expect, it } from "vitest";
import { SnqlError } from "./diagnostics";
import { compile } from "./index";

function pg(source: string): string {
	const { native } = compile(source, { engine: "postgres" });
	if (native.kind !== "sql") throw new Error("kind sql attendu");
	return native.text;
}

function mongo(source: string): readonly Record<string, unknown>[] {
	const { native } = compile(source, { engine: "mongodb" });
	if (native.kind !== "mongo") throw new Error("kind mongo attendu");
	return native.pipeline;
}

describe("sprint 3 parité — string : trim family, substring, replace, strpos", () => {
	it("trim cross-engine — même expression sémantique", () => {
		const sqlText = pg('find t pick trim(name) as x');
		const bson = JSON.stringify(mongo('find t pick trim(name) as x'));
		expect(sqlText).toContain("BTRIM");
		expect(bson).toContain("$trim");
	});

	it("substring 1-indexed — parité PG/Mongo (Mongo remap start-1)", () => {
		// PG: SUBSTRING(name, ($1)::int, ($2)::int) → "ell" pour "hello"
		// Cast ::int obligatoire (désambigüe l'overload regex qui matcherait
		// substring(text, text, text) en silence → NULL).
		// Mongo: $substrCP(name, max(2-1, 0)=1, max(3,0)=3) → "ell" — même résultat
		expect(pg('find t pick substring(name, 2, 3) as x')).toContain(
			`SUBSTRING("name", ($1)::int, ($2)::int)`
		);
		const bson = JSON.stringify(mongo('find t pick substring(name, 2, 3) as x'));
		expect(bson).toContain("$substrCP");
		expect(bson).toContain("$subtract");
	});

	it("substring NULL parity — null sur n'importe quel arg propage null", () => {
		// PG : NULL propagation native. Mongo : $cond wrap force la parité
		// (sinon $substrCP renvoie "" au lieu de null).
		const bson = JSON.stringify(mongo('find t pick substring(name, 2, 3) as x'));
		expect(bson).toContain("$cond");
		expect(bson).toContain('"$$s"');
		expect(bson).toContain('"$$start"');
		expect(bson).toContain('"$$len"');
	});

	it("replace littéral pur — même résultat cross-engine", () => {
		expect(pg('find t pick replace(name, "a", "b") as x')).toContain(
			`REPLACE("name", $1, $2)`
		);
		const bson = JSON.stringify(mongo('find t pick replace(name, "a", "b") as x'));
		expect(bson).toContain("$replaceAll");
	});

	it("strpos 1-indexed cross-engine — 0 = absent (parité PG)", () => {
		// PG : STRPOS retourne 0 si absent, N ≥ 1 sinon.
		// Mongo : $indexOfCP renvoie -1 si absent, N ≥ 0 sinon → remap dans le renderer.
		expect(pg('find t pick strpos(name, "x") as p')).toContain(`STRPOS`);
		const bson = JSON.stringify(mongo('find t pick strpos(name, "x") as p'));
		expect(bson).toContain("$indexOfCP");
		expect(bson).toContain('"$$p"'); // remap via $let
	});
});

describe("sprint 3 parité — number : floor, ceil", () => {
	it("floor cross-engine", () => {
		expect(pg("find t pick floor(price) as x")).toContain(`FLOOR("price")`);
		expect(JSON.stringify(mongo("find t pick floor(price) as x"))).toContain(
			"$floor"
		);
	});

	it("ceil cross-engine (jamais 'ceiling')", () => {
		expect(pg("find t pick ceil(price) as x")).toContain(`CEIL("price")`);
		expect(JSON.stringify(mongo("find t pick ceil(price) as x"))).toContain(
			"$ceil"
		);
	});
});

describe("sprint 3 parité — date : today UTC forcé", () => {
	it("today() UTC des 2 côtés (parité stricte)", () => {
		// PG : NOW() AT TIME ZONE 'UTC' → force UTC (pas CURRENT_DATE session-TZ).
		// Mongo : $$NOW est toujours UTC, $dateTrunc unit:day → même date.
		expect(pg("find t pick today() as d")).toBe(
			`SELECT ((NOW() AT TIME ZONE 'UTC')::date) AS "d" FROM "t"`
		);
		expect(JSON.stringify(mongo("find t pick today() as d"))).toContain(
			`"$$NOW"`
		);
	});
});

describe("sprint 3 parité — date_part : units mappés à même sémantique", () => {
	const units: { snql: string; pg: string; mongo: string }[] = [
		{ snql: "year", pg: "EXTRACT(year", mongo: "$year" },
		{ snql: "quarter", pg: "EXTRACT(quarter", mongo: "$quarter" },
		{ snql: "month", pg: "EXTRACT(month", mongo: "$month" },
		{ snql: "week", pg: "EXTRACT(week", mongo: "$isoWeek" }, // ISO des 2 côtés
		{ snql: "day", pg: "EXTRACT(day", mongo: "$dayOfMonth" },
		{ snql: "hour", pg: "EXTRACT(hour", mongo: "$hour" },
		{ snql: "minute", pg: "EXTRACT(minute", mongo: "$minute" },
		{ snql: "second", pg: "EXTRACT(second", mongo: "$second" },
		{ snql: "doy", pg: "EXTRACT(doy", mongo: "$dayOfYear" },
		{ snql: "epoch", pg: "EXTRACT(EPOCH", mongo: "$toLong" }
	];
	for (const u of units) {
		it(`date_part("${u.snql}", d) — PG=${u.pg} / Mongo=${u.mongo}`, () => {
			expect(pg(`find t pick date_part("${u.snql}", d) as x`)).toContain(u.pg);
			expect(
				JSON.stringify(mongo(`find t pick date_part("${u.snql}", d) as x`))
			).toContain(u.mongo);
		});
	}

	it('date_part("dow", d) — remap 0=dim des 2 côtés (Mongo $dayOfWeek - 1)', () => {
		// PG EXTRACT(dow) = 0..6 (dim=0) natif.
		// Mongo $dayOfWeek = 1..7 (dim=1) → renderer soustrait 1.
		expect(pg('find t pick date_part("dow", d) as x')).toContain("EXTRACT(dow");
		const bson = JSON.stringify(mongo('find t pick date_part("dow", d) as x'));
		expect(bson).toContain("$dayOfWeek");
		expect(bson).toContain("$subtract");
	});

	it('date_part("epoch", d) — PG ::bigint / Mongo $toLong/1000 (ms → sec)', () => {
		expect(pg('find t pick date_part("epoch", d) as e')).toContain("::bigint");
		const bson = JSON.stringify(mongo('find t pick date_part("epoch", d) as e'));
		expect(bson).toContain("$toLong");
		expect(bson).toContain("1000");
	});
});

describe("sprint 3 parité — date_trunc : week=monday cross-engine", () => {
	it('date_trunc("week", d) — Mongo force startOfWeek:monday (parité PG ISO)', () => {
		// PG DATE_TRUNC('week', d) = lundi (ISO).
		// Mongo default = dimanche → renderer force monday explicitement.
		expect(pg('find t pick date_trunc("week", d) as w')).toContain(
			`DATE_TRUNC('week'`
		);
		expect(JSON.stringify(mongo('find t pick date_trunc("week", d) as w'))).toContain(
			"monday"
		);
	});

	it('date_trunc("day", d) — pas de startOfWeek', () => {
		const bson = JSON.stringify(mongo('find t pick date_trunc("day", d) as w'));
		expect(bson).not.toContain("startOfWeek");
	});
});

describe("sprint 3 parité — date_add : unit-first + fix quarter", () => {
	it('date_add("quarter", d, 2) — PG MAKE_INTERVAL(months=>(2*3)) / Mongo unit:"quarter"', () => {
		// PG : MAKE_INTERVAL n'a pas `quarters` → mapping vers months*3.
		// Mongo : $dateAdd supporte unit:"quarter" nativement.
		expect(pg('find t pick date_add("quarter", d, 2) as d2')).toContain(
			"MAKE_INTERVAL(months => ($1 * 3))"
		);
		expect(JSON.stringify(mongo('find t pick date_add("quarter", d, 2) as d2'))).toContain(
			'"quarter"'
		);
	});

	it('date_add("day", d, -30) — soustraction implicite (amount négatif)', () => {
		// L'amount peut être négatif → soustraction sans date_sub distinct.
		expect(pg('find t pick date_add("day", d, -30) as past')).toContain(
			"MAKE_INTERVAL(days => "
		);
	});
});

describe("sprint 3 parité — date_diff : whitelist réduite + FLOOR truncate", () => {
	it('date_diff("day", later, earlier) — PG date subtraction / Mongo $dateDiff', () => {
		expect(pg('find t pick date_diff("day", end_dt, start_dt) as n')).toBe(
			`SELECT ("end_dt"::date - "start_dt"::date) AS "n" FROM "t"`
		);
		expect(
			JSON.stringify(mongo('find t pick date_diff("day", end_dt, start_dt) as n'))
		).toContain("$dateDiff");
	});

	it('date_diff("hour", ...) — PG FLOOR/3600 (truncate) parité Mongo', () => {
		// FLOOR obligatoire côté PG : `::int` seul ferait banker rounding.
		const sql = pg('find t pick date_diff("hour", end_dt, start_dt) as n');
		expect(sql).toContain("FLOOR");
		expect(sql).toContain("3600");
	});

	it('date_diff("month", ...) — refusé sprint 3 (whitelist réduite)', () => {
		try {
			pg('find t pick date_diff("month", end_dt, start_dt) as n');
			throw new Error("SnqlError attendu");
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.code).toBe("lower_call_enum_value");
		}
	});

	it('date_diff swap args Mongo — SNQL later-first → Mongo startDate=earlier', () => {
		const bson = JSON.stringify(
			mongo('find t pick date_diff("day", end_dt, start_dt) as n')
		);
		// startDate = earlier (start_dt), endDate = later (end_dt) → résultat positif.
		expect(bson).toContain('"startDate":"$start_dt"');
		expect(bson).toContain('"endDate":"$end_dt"');
	});
});

describe("sprint 3 parité — round fix (double-cast pattern)", () => {
	it("round(x) mono-arg inchangé cross-engine", () => {
		expect(pg("find t pick round(x) as r")).toContain("ROUND(");
		expect(JSON.stringify(mongo("find t pick round(x) as r"))).toContain(
			"$round"
		);
	});

	it("round(x, 2) — PG double-cast, Mongo natif", () => {
		expect(pg("find t pick round(x, 2) as r")).toBe(
			`SELECT ROUND(("x")::numeric, $1)::double precision AS "r" FROM "t"`
		);
	});
});

describe("sprint 3 parité — errors cross-engine (parser/lower avant codegen)", () => {
	it("date_part unit inconnue → même erreur PG/Mongo (lower est engine-indépendant)", () => {
		for (const engine of ["postgres", "mongodb"] as const) {
			try {
				compile('find t pick date_part("yaer", d) as y', { engine });
				throw new Error("SnqlError attendu");
			} catch (e) {
				if (!(e instanceof SnqlError)) throw e;
				expect(e.code).toBe("lower_call_enum_value");
			}
		}
	});

	it("substring zero-index → même erreur PG/Mongo", () => {
		for (const engine of ["postgres", "mongodb"] as const) {
			try {
				compile("find t pick substring(x, 0, 5) as y", { engine });
				throw new Error("SnqlError attendu");
			} catch (e) {
				if (!(e instanceof SnqlError)) throw e;
				expect(e.code).toBe("lower_call_substring_zero_index");
			}
		}
	});
});
