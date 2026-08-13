/**
 * Tests unitaires des 13 nouvelles fonctions du sprint 3 + validation
 * argEnum + guards dédiés (substring zero-index, replace empty-find, reserved
 * regex_replace, aliases Levenshtein).
 */

import { describe, expect, it } from "vitest";
import { SnqlError } from "../diagnostics";
import { compile, getMapper, lowerMutation, parse, tokenize } from "../index";

function sqlOf(source: string): string {
	const { native } = compile(source, { engine: "postgres" });
	if (native.kind !== "sql") throw new Error("kind sql attendu");
	return native.text;
}

function mongoPipe(source: string): readonly Record<string, unknown>[] {
	const { native } = compile(source, { engine: "mongodb" });
	if (native.kind !== "mongo") throw new Error("kind mongo attendu");
	return native.pipeline;
}

function expectCode(fn: () => unknown, code: string): void {
	try {
		fn();
		throw new Error(`SnqlError attendu avec code=${code}`);
	} catch (e) {
		if (!(e instanceof SnqlError)) throw e;
		expect(e.code).toBe(code);
	}
}

describe("sprint 3 — string : trim / ltrim / rtrim", () => {
	it("trim(s) → BTRIM(s)", () => {
		expect(sqlOf('find t pick trim(name) as x')).toBe(
			`SELECT BTRIM("name") AS "x" FROM "t"`
		);
	});

	it("trim(s, chars) → BTRIM(s, chars) 2-args", () => {
		expect(sqlOf('find t pick trim(name, "xy") as x')).toBe(
			`SELECT BTRIM("name", $1) AS "x" FROM "t"`
		);
	});

	it("ltrim / rtrim rendus symétriques", () => {
		expect(sqlOf('find t pick ltrim(name) as x')).toBe(
			`SELECT LTRIM("name") AS "x" FROM "t"`
		);
		expect(sqlOf('find t pick rtrim(name) as x')).toBe(
			`SELECT RTRIM("name") AS "x" FROM "t"`
		);
	});

	it("Mongo : $trim { input, chars? }", () => {
		expect(mongoPipe('find t pick trim(name) as x')[0]).toEqual({
			$project: { x: { $trim: { input: "$name" } }, _id: 0 }
		});
	});
});

describe("sprint 3 — substring : 1-indexed + guard zero-index", () => {
	it("substring(s, 2, 3) → SUBSTRING avec cast ::int (désambigüe overload regex)", () => {
		expect(sqlOf('find t pick substring(name, 2, 3) as x')).toBe(
			`SELECT SUBSTRING("name", ($1)::int, ($2)::int) AS "x" FROM "t"`
		);
	});

	it("substring(s, 0, N) littéral refusé (lower_call_substring_zero_index)", () => {
		expectCode(
			() => sqlOf('find t pick substring(name, 0, 5) as x'),
			"lower_call_substring_zero_index"
		);
	});

	it("Mongo : wrap $let + $cond null-parité + $substrCP + $max", () => {
		const pipeline = mongoPipe('find t pick substring(name, 2, 3) as x');
		const proj = pipeline[0] as {
			$project: { x: { $let: { in: unknown } } };
		};
		// Vérifie structure clé : $substrCP + $max sur start et len
		const serialized = JSON.stringify(proj);
		expect(serialized).toContain("$substrCP");
		expect(serialized).toContain("$max");
		expect(serialized).toContain("$cond"); // null-check propagation
	});
});

describe("sprint 3 — replace : guard empty-find + littéral pur", () => {
	it('replace(s, "from", "to") → REPLACE(s, from, to)', () => {
		expect(sqlOf('find t pick replace(name, "a", "b") as x')).toBe(
			`SELECT REPLACE("name", $1, $2) AS "x" FROM "t"`
		);
	});

	it('replace(s, "", to) littéral refusé (lower_call_replace_empty_find)', () => {
		expectCode(
			() => sqlOf('find t pick replace(name, "", "b") as x'),
			"lower_call_replace_empty_find"
		);
	});

	it("Mongo : $replaceAll { input, find, replacement }", () => {
		expect(mongoPipe('find t pick replace(name, "a", "b") as x')[0]).toEqual({
			$project: {
				x: {
					$replaceAll: { input: "$name", find: "a", replacement: "b" }
				},
				_id: 0
			}
		});
	});
});

describe("sprint 3 — strpos : 1-indexed cross-engine", () => {
	it("strpos(h, n) → STRPOS(h, n) — jamais POSITION(n IN h)", () => {
		expect(sqlOf('find t pick strpos(name, "x") as p')).toBe(
			`SELECT STRPOS("name", $1) AS "p" FROM "t"`
		);
	});

	it("Mongo : remap $indexOfCP -1 → 0 et N ≥ 0 → N+1", () => {
		const pipeline = mongoPipe('find t pick strpos(name, "x") as p');
		const serialized = JSON.stringify(pipeline[0]);
		expect(serialized).toContain("$indexOfCP");
		expect(serialized).toContain("$$p");
		expect(serialized).toContain("$cond"); // -1 → 0 remap
		expect(serialized).toContain("$add"); // N+1 pour 1-based
	});
});

describe("sprint 3 — number : floor / ceil", () => {
	it("floor(n) → FLOOR(n)", () => {
		expect(sqlOf("find t pick floor(price) as x")).toBe(
			`SELECT FLOOR("price") AS "x" FROM "t"`
		);
	});

	it("ceil(n) → CEIL(n) — jamais CEILING", () => {
		expect(sqlOf("find t pick ceil(price) as x")).toBe(
			`SELECT CEIL("price") AS "x" FROM "t"`
		);
	});

	it("Mongo : $floor / $ceil", () => {
		expect(mongoPipe("find t pick floor(price) as x")[0]).toEqual({
			$project: { x: { $floor: "$price" }, _id: 0 }
		});
	});
});

describe("sprint 3 — date : today() UTC forcé", () => {
	it("today() → ((NOW() AT TIME ZONE 'UTC')::date) — pas CURRENT_DATE", () => {
		expect(sqlOf("find t pick today() as d")).toBe(
			`SELECT ((NOW() AT TIME ZONE 'UTC')::date) AS "d" FROM "t"`
		);
	});

	it("Mongo : $dateTrunc sur $$NOW pour jour UTC", () => {
		expect(mongoPipe("find t pick today() as d")[0]).toEqual({
			$project: {
				d: { $dateTrunc: { date: "$$NOW", unit: "day" } },
				_id: 0
			}
		});
	});

	it("today est autorisé en write (deterministic)", () => {
		const stmt = parse(tokenize("update t where id = 1 set updated = today()"));
		if (stmt.operation !== "update") throw new Error("update attendu");
		expect(() => lowerMutation(stmt)).not.toThrow();
	});
});

describe("sprint 3 — date_part : whitelist + UTC + remap dow", () => {
	it('date_part("year", d) → EXTRACT(year FROM (d AT TIME ZONE UTC))::int', () => {
		expect(sqlOf('find t pick date_part("year", created) as y')).toBe(
			`SELECT EXTRACT(year FROM ("created" AT TIME ZONE 'UTC'))::int AS "y" FROM "t"`
		);
	});

	it('date_part("epoch", d) → ::bigint (pas ::int)', () => {
		expect(sqlOf('find t pick date_part("epoch", created) as e')).toContain(
			`::bigint`
		);
	});

	it('date_part("yaer", d) → lower_call_enum_value avec suggestion "year"', () => {
		try {
			sqlOf('find t pick date_part("yaer", created) as y');
			throw new Error("SnqlError attendu");
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.code).toBe("lower_call_enum_value");
			expect(e.message).toContain("year");
		}
	});

	it("date_part(dynamic, d) → lower_call_enum_literal_required", () => {
		expectCode(
			() => sqlOf("find t pick date_part(u, created) as y"),
			"lower_call_enum_literal_required"
		);
	});

	it('date_part("week", d) Mongo → $isoWeek (aligné PG ISO)', () => {
		expect(mongoPipe('find t pick date_part("week", created) as w')[0]).toEqual({
			$project: { w: { $isoWeek: "$created" }, _id: 0 }
		});
	});

	it('date_part("dow", d) Mongo → $subtract [$dayOfWeek, 1] (remap 1-7 → 0-6)', () => {
		expect(mongoPipe('find t pick date_part("dow", created) as d')[0]).toEqual({
			$project: {
				d: { $subtract: [{ $dayOfWeek: "$created" }, 1] },
				_id: 0
			}
		});
	});
});

describe("sprint 3 — date_trunc : whitelist + week=monday fix", () => {
	it('date_trunc("day", d) PG → DATE_TRUNC(\'day\', ...UTC)', () => {
		expect(sqlOf('find t pick date_trunc("day", created) as d')).toBe(
			`SELECT DATE_TRUNC('day', ("created" AT TIME ZONE 'UTC')) AS "d" FROM "t"`
		);
	});

	it('date_trunc("week", d) Mongo → force startOfWeek: monday', () => {
		const pipeline = mongoPipe('find t pick date_trunc("week", created) as d');
		const proj = pipeline[0] as {
			$project: {
				d: {
					$dateTrunc: {
						date: unknown;
						unit: string;
						binSize: number;
						startOfWeek?: string;
					};
				};
			};
		};
		expect(proj.$project.d.$dateTrunc.startOfWeek).toBe("monday");
	});

	it('date_trunc("day", d) Mongo → pas de startOfWeek', () => {
		const pipeline = mongoPipe('find t pick date_trunc("day", created) as d');
		const proj = pipeline[0] as {
			$project: {
				d: { $dateTrunc: { startOfWeek?: string } };
			};
		};
		expect(proj.$project.d.$dateTrunc.startOfWeek).toBeUndefined();
	});
});

describe("sprint 3 — date_add : unit-first + fix quarter → months*3", () => {
	it('date_add("day", d, 30) PG → d + MAKE_INTERVAL(days => 30)', () => {
		expect(sqlOf('find t pick date_add("day", created, 30) as d')).toBe(
			`SELECT ("created" + MAKE_INTERVAL(days => $1)) AS "d" FROM "t"`
		);
	});

	it('date_add("quarter", d, 2) PG → MAKE_INTERVAL(months => (2 * 3)) — fix quarter', () => {
		expect(sqlOf('find t pick date_add("quarter", created, 2) as d')).toBe(
			`SELECT ("created" + MAKE_INTERVAL(months => ($1 * 3))) AS "d" FROM "t"`
		);
	});

	it('date_add("day", d, 30) Mongo → $dateAdd {startDate, unit, amount}', () => {
		expect(mongoPipe('find t pick date_add("day", created, 30) as d')[0]).toEqual({
			$project: {
				d: { $dateAdd: { startDate: "$created", unit: "day", amount: 30 } },
				_id: 0
			}
		});
	});
});

describe("sprint 3 — date_diff : whitelist réduite + FLOOR + swap", () => {
	it('date_diff("day", later, earlier) PG → (later::date - earlier::date)', () => {
		expect(sqlOf('find t pick date_diff("day", end_dt, start_dt) as n')).toBe(
			`SELECT ("end_dt"::date - "start_dt"::date) AS "n" FROM "t"`
		);
	});

	it('date_diff("hour", ...) PG → FLOOR(EXTRACT(EPOCH)/3600)::int (pas banker round)', () => {
		const sql = sqlOf('find t pick date_diff("hour", end_dt, start_dt) as n');
		expect(sql).toContain("FLOOR");
		expect(sql).toContain("/ 3600");
	});

	it('date_diff("month", ...) → refusé sprint 3 (whitelist réduite)', () => {
		try {
			sqlOf('find t pick date_diff("month", end_dt, start_dt) as n');
			throw new Error("SnqlError attendu");
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.code).toBe("lower_call_enum_value");
		}
	});

	it('date_diff("day", later, earlier) Mongo → swap start/end pour convention Mongo', () => {
		expect(mongoPipe('find t pick date_diff("day", end_dt, start_dt) as n')[0]).toEqual({
			$project: {
				n: {
					$dateDiff: {
						startDate: "$start_dt",
						endDate: "$end_dt",
						unit: "day"
					}
				},
				_id: 0
			}
		});
	});
});

describe("sprint 3 — regex_replace : reserved sprint 4", () => {
	it("regex_replace(...) → lower_call_reserved (pas lower_unknown_function)", () => {
		expectCode(
			() => sqlOf('find t pick regex_replace(name, "x", "y") as r'),
			"lower_call_reserved"
		);
	});
});

describe("sprint 3 — aliases Levenshtein pour lower_unknown_function", () => {
	it("regexp_replace → suggère regex_replace réservé", () => {
		try {
			sqlOf('find t pick regexp_replace(name, "x", "y") as r');
			throw new Error("SnqlError attendu");
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.code).toBe("lower_unknown_function");
			expect(e.message).toContain("regex_replace");
		}
	});

	it("substr → suggère substring", () => {
		try {
			sqlOf("find t pick substr(name, 1, 3) as x");
			throw new Error("SnqlError attendu");
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.message).toContain("substring");
		}
	});

	it("ceiling → suggère ceil", () => {
		try {
			sqlOf("find t pick ceiling(price) as x");
			throw new Error("SnqlError attendu");
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.message).toContain("ceil");
		}
	});

	it("current_date → suggère today()", () => {
		try {
			sqlOf("find t pick current_date() as d");
			throw new Error("SnqlError attendu");
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.message).toContain("today");
		}
	});
});
