import { describe, expect, it } from "vitest";
import { SnqlError } from "./diagnostics";
import { getMapper, lowerMutation, parse, tokenize } from "./index";

/** Compile une mutation SNQL en SQL Postgres (text + params). */
function sql(source: string): { text: string; params: readonly unknown[] } {
	const statement = parse(tokenize(source));
	if (statement.operation === "select") {
		throw new Error("attendu une mutation");
	}
	const native = getMapper("postgres").mapMutation(lowerMutation(statement));
	if (native.kind !== "sql") {
		throw new Error("attendu du SQL");
	}
	return { text: native.text, params: native.params };
}

describe("mutations → Postgres", () => {
	it("update simple", () => {
		const { text, params } = sql(
			'update users | where id = 7 | set status = "active"'
		);
		expect(text).toBe(
			'UPDATE "users" SET "status" = $1 WHERE "id" = $2 RETURNING *'
		);
		expect(params).toEqual(["active", 7]);
	});

	it("update multi-set", () => {
		const { text, params } = sql(
			'update users | where id = 7 | set status = "x", is_active = false'
		);
		expect(text).toBe(
			'UPDATE "users" SET "status" = $1, "is_active" = $2 WHERE "id" = $3 RETURNING *'
		);
		expect(params).toEqual(["x", false, 7]);
	});

	it("delete filtré", () => {
		const { text, params } = sql("remove from users | where age < 18");
		expect(text).toBe('DELETE FROM "users" WHERE "age" < $1 RETURNING *');
		expect(params).toEqual([18]);
	});

	it("plusieurs where → conjonction", () => {
		const { text, params } = sql(
			"remove from orders | where user_id = 1 | where total_cents > 1000"
		);
		expect(text).toBe(
			'DELETE FROM "orders" WHERE ("user_id" = $1 AND "total_cents" > $2) RETURNING *'
		);
		expect(params).toEqual([1, 1000]);
	});

	it("bigint préservé dans un prédicat de mutation", () => {
		const { params } = sql(
			"remove from users | where id = 9223372036854775807"
		);
		expect(params).toEqual([9223372036854775807n]);
	});
});

describe("mutations — garde-fous", () => {
	it("refuse un update sans where (write non filtré)", () => {
		expect(() => parse(tokenize('update users | set status = "x"'))).toThrow(
			SnqlError
		);
	});

	it("refuse un update sans set", () => {
		expect(() => parse(tokenize("update users | where id = 1"))).toThrow(
			SnqlError
		);
	});

	it("refuse un remove sans where (delete non filtré)", () => {
		expect(() => parse(tokenize("remove from users"))).toThrow(SnqlError);
	});

	it("refuse une colonne affectée deux fois dans un set", () => {
		const statement = parse(
			tokenize("update users | where id = 1 | set x = 1, x = 2")
		);
		if (statement.operation === "select") {
			throw new Error("attendu une mutation");
		}
		expect(() => lowerMutation(statement)).toThrow(SnqlError);
	});

	it("l'insertion n'est pas encore supportée (Slice 4b)", () => {
		expect(() => parse(tokenize("add users"))).toThrow(SnqlError);
	});

	it("le codegen de mutation MongoDB n'est pas encore supporté", () => {
		const statement = parse(tokenize("remove from users | where id = 1"));
		if (statement.operation === "select") {
			throw new Error("attendu une mutation");
		}
		expect(() =>
			getMapper("mongodb").mapMutation(lowerMutation(statement))
		).toThrow(SnqlError);
	});
});
