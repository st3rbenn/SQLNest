import { describe, expect, it } from "vitest";
import {
	compile,
	getMapper,
	lowerMutation,
	parse,
	tokenize
} from "../index";

function sql(source: string): { text: string; params: readonly unknown[] } {
	const { native } = compile(source, { engine: "postgres" });
	return { text: native.text, params: native.params };
}

function mutation(source: string): { text: string; params: readonly unknown[] } {
	const stmt = parse(tokenize(source));
	if (stmt.operation === "select") throw new Error("mutation attendue");
	const nat = getMapper("postgres").mapMutation(lowerMutation(stmt));
	if (nat.kind !== "sql") throw new Error("kind sql attendu");
	return { text: nat.text, params: nat.params };
}

describe("codegen postgres — cast (T2 sprint 2)", () => {
	it("cast(x as int) en pick → CAST(x AS bigint)", () => {
		expect(sql("get t pick cast(x as int) as x_int").text).toBe(
			`SELECT CAST("x" AS bigint) AS "x_int" FROM "t"`
		);
	});

	it("cast(x as float) en WHERE → CAST(x AS double precision)", () => {
		// Compare (pas arith) : `> $1` unknown, PG infère depuis le type de la gauche
		// (double precision). Pas de `::numeric` ajouté par renderArithOperand.
		const { text, params } = sql(
			"get t where cast(x as float) > 3.14"
		);
		expect(text).toBe(
			`SELECT * FROM "t" WHERE CAST("x" AS double precision) > $1`
		);
		expect(params).toEqual(["3.14"]);
	});

	it("les 7 targets mappent vers les types PG figés", () => {
		expect(sql("get t pick cast(x as int) as y").text).toContain(
			`CAST("x" AS bigint)`
		);
		expect(sql("get t pick cast(x as float) as y").text).toContain(
			`CAST("x" AS double precision)`
		);
		expect(sql("get t pick cast(x as text) as y").text).toContain(
			`CAST("x" AS text)`
		);
		expect(sql("get t pick cast(x as bool) as y").text).toContain(
			`CAST("x" AS boolean)`
		);
		expect(sql("get t pick cast(x as date) as y").text).toContain(
			`CAST("x" AS date)`
		);
		expect(sql("get t pick cast(x as timestamp) as y").text).toContain(
			`CAST("x" AS timestamptz)`
		);
		expect(sql("get t pick cast(x as json) as y").text).toContain(
			`CAST("x" AS jsonb)`
		);
	});

	it("cast d'un chemin pointé aliasé", () => {
		expect(
			sql("get users as u pick cast(u.age as int) as age_int").text
		).toBe(
			`SELECT CAST("u"."age" AS bigint) AS "age_int" FROM "users" AS "u"`
		);
	});

	it("cast d'une arith (opérande arith parenthésée)", () => {
		expect(sql("get t pick cast(a + b as int) as sum").text).toBe(
			`SELECT CAST(("a" + "b") AS bigint) AS "sum" FROM "t"`
		);
	});

	it("cast d'un call (now() → CAST(NOW() AS date))", () => {
		expect(sql("get t pick cast(now() as date) as today").text).toBe(
			`SELECT CAST(NOW() AS date) AS "today" FROM "t"`
		);
	});

	it("cast imbriqué", () => {
		expect(
			sql("get t pick cast(cast(raw as text) as int) as n").text
		).toBe(
			`SELECT CAST(CAST("raw" AS text) AS bigint) AS "n" FROM "t"`
		);
	});

	it("cast en UPDATE SET (write autorisé)", () => {
		const { text, params } = mutation(
			"update t where id = 1 set label = cast(code as text)"
		);
		expect(text).toBe(
			`UPDATE "t" SET "label" = CAST("code" AS text) WHERE "id" = $1 RETURNING *`
		);
		expect(params).toEqual([1]);
	});

	it("cast en UPDATE WHERE predicate", () => {
		const { text } = mutation(
			"update t where cast(age as int) > 30 set active = true"
		);
		expect(text).toBe(
			`UPDATE "t" SET "active" = $1 WHERE CAST("age" AS bigint) > $2 RETURNING *`
		);
	});

	it("cast en DELETE WHERE", () => {
		const { text } = mutation(
			"remove from t where cast(x as int) = 42"
		);
		expect(text).toBe(
			`DELETE FROM "t" WHERE CAST("x" AS bigint) = $1 RETURNING *`
		);
	});

	it("cast dans une liste in", () => {
		const { text } = sql(
			"get t where x in [cast(1 as int), cast(2 as int)]"
		);
		expect(text).toBe(
			`SELECT * FROM "t" WHERE "x" IN (CAST($1 AS bigint), CAST($2 AS bigint))`
		);
	});
});

describe("codegen postgres — cast n'empile pas ::numeric (regression)", () => {
	it("cast(0.1 as float) * col — pas de `::numeric` ajouté au param cast", () => {
		// Le cast wrap déjà le typage ; renderArithOperand ne doit PAS annoter
		// `::numeric` en plus (sinon double-cast et erreur PG).
		const { text } = sql("get t pick cast(0.1 as float) * col as x");
		expect(text).toBe(
			`SELECT (CAST($1 AS double precision) * "col") AS "x" FROM "t"`
		);
		expect(text).not.toContain(`$1::numeric`);
	});

	it("regression littéral décimal nu * col reste avec ::numeric local", () => {
		// Sans cast, l'idiome `::numeric` local s'applique — comportement inchangé.
		expect(sql("get t pick col * 0.1 as x").text).toBe(
			`SELECT ("col" * $1::numeric) AS "x" FROM "t"`
		);
	});
});
