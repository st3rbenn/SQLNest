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

	it("update sans where affecte toutes les lignes (assumé)", () => {
		const { text, params } = sql("update users | set is_active = false");
		expect(text).toBe('UPDATE "users" SET "is_active" = $1 RETURNING *');
		expect(params).toEqual([false]);
	});

	it("remove sans where supprime toutes les lignes (assumé)", () => {
		const { text, params } = sql("remove from users");
		expect(text).toBe('DELETE FROM "users" RETURNING *');
		expect(params).toEqual([]);
	});

	it("insert simple → INSERT … RETURNING *", () => {
		const { text, params } = sql(
			'add {email: "a@b.c", display_name: "Bob", is_active: true} into users'
		);
		expect(text).toBe(
			'INSERT INTO "users" ("email", "display_name", "is_active") VALUES ($1, $2, $3) RETURNING *'
		);
		expect(params).toEqual(["a@b.c", "Bob", true]);
	});

	it("insert multi-lignes (liste de documents)", () => {
		const { text, params } = sql("add [{a: 1}, {a: 2}] into t");
		expect(text).toBe('INSERT INTO "t" ("a") VALUES ($1), ($2) RETURNING *');
		expect(params).toEqual([1, 2]);
	});

	it("insert avec null (NULL en clair, pas paramétré)", () => {
		const { text, params } = sql("add {display_name: null} into users");
		expect(text).toBe(
			'INSERT INTO "users" ("display_name") VALUES (NULL) RETURNING *'
		);
		expect(params).toEqual([]);
	});

	it("clé de document entre guillemets acceptée", () => {
		const { text } = sql('add {"email": "a@b.c"} into users');
		expect(text).toBe('INSERT INTO "users" ("email") VALUES ($1) RETURNING *');
	});

	it("préserve la précision d'un décimal (pas de double lossy)", () => {
		const { text, params } = sql(
			"add {balance: 1.123456789012345678} into accounts"
		);
		expect(text).toBe(
			'INSERT INTO "accounts" ("balance") VALUES ($1) RETURNING *'
		);
		// Le texte brut exact est bindé — Postgres caste vers NUMERIC sans perte.
		expect(params).toEqual(["1.123456789012345678"]);
	});
});

describe("mutations — règles de correction", () => {
	it("refuse un update sans set (rien à écrire)", () => {
		expect(() => parse(tokenize("update users | where id = 1"))).toThrow(
			SnqlError
		);
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

	it("refuse 'add' sans document { … }", () => {
		expect(() => parse(tokenize("add users"))).toThrow(SnqlError);
	});

	it("refuse un document vide", () => {
		expect(() => parse(tokenize("add {} into t"))).toThrow(SnqlError);
	});

	it("refuse une valeur d'insertion non littérale", () => {
		expect(() => sql("add {a: b} into t")).toThrow(SnqlError);
	});

	it("refuse des documents hétérogènes en insert multiple", () => {
		expect(() => sql("add [{a: 1}, {b: 2}] into t")).toThrow(SnqlError);
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
