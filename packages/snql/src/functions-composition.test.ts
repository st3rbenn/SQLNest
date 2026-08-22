/**
 * Composition cast + call + arith. Le codegen délègue déjà via
 * renderExpr, mais on verrouille les combinaisons courantes E2E cross-engine
 * pour catch les régressions futures (naming, mapping, null-parity).
 */

import { describe, expect, it } from "vitest";
import {
	compile,
	getMapper,
	lowerMutation,
	parse,
	tokenize
} from "./index";

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

function pgMutation(source: string): string {
	const stmt = parse(tokenize(source));
	if (stmt.operation === "select") throw new Error("mutation attendue");
	const nat = getMapper("postgres").mapMutation(lowerMutation(stmt));
	if (nat.kind !== "sql") throw new Error("kind sql attendu");
	return nat.text;
}

describe("composition cast + call", () => {
	it("round(cast(x as float), 3) — fix E2E RNAcentral (double-cast pattern)", () => {
		// Le cas qui a explosé en cast → double precision → round
		// throw 42883. Le renderer B++ absorbe le quirk sans casser le type.
		expect(pg("find t pick round(cast(rate as float), 3) as r")).toBe(
			`SELECT ROUND((CAST("rate" AS double precision))::numeric, $1)::double precision AS "r" FROM "t"`
		);
	});

	it("substring(cast(x as text), 1, 5) — cast en entrée d'un call", () => {
		expect(pg("find t pick substring(cast(id as text), 1, 5) as prefix")).toBe(
			`SELECT SUBSTRING(CAST("id" AS text), ($1)::int, ($2)::int) AS "prefix" FROM "t"`
		);
	});

	it('date_part("year", cast(ts as date)) — cast timestamp → date en entrée date_part', () => {
		expect(pg('find t pick date_part("year", cast(created as date)) as y')).toBe(
			`SELECT EXTRACT(year FROM (CAST("created" AS date) AT TIME ZONE 'UTC'))::int AS "y" FROM "t"`
		);
	});

	it("floor(cast(price as float)) — cast en entrée d'un floor", () => {
		expect(pg("find t pick floor(cast(price as float)) as p")).toBe(
			`SELECT FLOOR(CAST("price" AS double precision)) AS "p" FROM "t"`
		);
	});

	it("trim(concat(a, b)) — call sous call (composition sans cast)", () => {
		// Non-régression : la délégation registre marche récursivement.
		expect(pg('find t pick trim(concat(a, b)) as x')).toBe(
			`SELECT BTRIM(CONCAT("a"::text, "b"::text)) AS "x" FROM "t"`
		);
	});
});

describe("composition cast + arith + call (RNAcentral-like)", () => {
	it("round(cast(len as float) / 1000, 2) — expression réelle RNAcentral", () => {
		// Chaîne : cast → arith → round. Chaque étape passe par renderExpr.
		expect(pg("find t pick round(cast(len as float) / 1000, 2) as len_kb")).toBe(
			`SELECT ROUND(((CAST("len" AS double precision) / $1))::numeric, $2)::double precision AS "len_kb" FROM "t"`
		);
	});

	it("cast(round(cast(x as float), 2) as text) — cast wrap tout, cross-engine", () => {
		expect(pg("find t pick cast(round(cast(x as float), 2) as text) as s")).toContain(
			`CAST(ROUND(`
		);
		// Mongo doit produire un $convert wrappant $round.
		const pipeline = mongo("find t pick cast(round(cast(x as float), 2) as text) as s");
		const serialized = JSON.stringify(pipeline);
		expect(serialized).toContain("$convert");
		expect(serialized).toContain("$round");
	});
});

describe("composition write : cast + call safe", () => {
	it('update set y = trim(cast(raw as text)) passe (trim propagate + cast pur)', () => {
		// Composition safe cross-engine — pas de call refusé sous.
		expect(pgMutation('update t where id = 1 set y = trim(cast(raw as text))')).toBe(
			`UPDATE "t" SET "y" = BTRIM(CAST("raw" AS text)) WHERE "id" = $1 RETURNING *`
		);
	});
});
