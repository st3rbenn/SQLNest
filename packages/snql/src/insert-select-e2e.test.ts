/**
 * Feature 2 : INSERT SELECT (`add (find … pick a, b as c) into t`).
 *
 * Couvre :
 *  - parser  : `add ( verb …) into t` détection lparen + verb select
 *  - lower   : refus sans pick, mapping cols inféré (alias > path last segment),
 *              refus duplicate col, refus unique pick, refus on-conflict combiné
 *  - IR      : MutationPlan.insert.sourcePlan + columns
 *  - planner : capability `insert-select` (PG only)
 *  - codegen : `INSERT INTO t (cols) SELECT … RETURNING *`
 */

import { describe, expect, it } from "vitest";
import { SnqlError } from "./diagnostics";
import {
	assertMutationInsertSelectSupported,
	getMapper,
	KV_CAPABILITIES,
	lowerMutation,
	MONGODB_CAPABILITIES,
	parse,
	tokenize
} from "./index";
import type { SchemaModel } from "./schema/model";

const SCHEMA: SchemaModel = {
	engine: "postgres",
	collections: [
		{
			name: "users",
			source: "declared",
			primaryKey: ["id"],
			fields: [
				{ name: "id", type: "bigint", nullable: false, source: "declared" },
				{ name: "email", type: "string", nullable: false, source: "declared" },
				{ name: "display_name", type: "string", nullable: true, source: "declared" }
			]
		},
		{
			name: "archive",
			source: "declared",
			primaryKey: ["id"],
			fields: [
				{ name: "id", type: "bigint", nullable: false, source: "declared" },
				{ name: "email", type: "string", nullable: false, source: "declared" }
			]
		}
	],
	relations: []
};

function pgSql(source: string, schema?: SchemaModel): { text: string; params: readonly unknown[] } {
	const statement = parse(tokenize(source));
	if (statement.operation === "select") throw new Error("mutation attendue");
	const mutation = lowerMutation(statement, schema);
	const native = getMapper("postgres").mapMutation(mutation);
	if (native.kind !== "sql") throw new Error("kind sql attendu");
	return { text: native.text, params: native.params };
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

// ═══════════════════════════════════════════════════════════════════════════
// Parser
// ═══════════════════════════════════════════════════════════════════════════

describe("parser — add (find …) into", () => {
	it("add (find …) into", () => {
		const stmt = parse(
			tokenize("add (find users pick id, email) into archive")
		);
		if (stmt.operation !== "insert") throw new Error();
		expect(stmt.sourceQuery).toBeDefined();
		expect(stmt.rows).toHaveLength(0);
	});

	it("add (get …) into (verb alias)", () => {
		const stmt = parse(
			tokenize("add (get users pick id, email) into archive")
		);
		if (stmt.operation !== "insert") throw new Error();
		expect(stmt.sourceQuery).toBeDefined();
	});

	it("refus verbe non-select en sourceQuery", () => {
		expectCode(
			() => parse(tokenize("add (update users set email = \"x\") into archive")),
			"parse_insert_source_not_select"
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Lower : refus + mapping cols
// ═══════════════════════════════════════════════════════════════════════════

describe("lower — insert-select validations", () => {
	it("refus sans pick", () => {
		expectCode(
			() => pgSql("add (find users) into archive"),
			"lower_insert_select_no_pick"
		);
	});

	it("refus pick unique", () => {
		expectCode(
			() => pgSql("add (find users pick unique email) into archive"),
			"lower_insert_select_unique_pick"
		);
	});

	it("refus col cible dupliquée dans mapping", () => {
		expectCode(
			() => pgSql("add (find users pick email, email) into archive"),
			"lower_insert_select_duplicate_column"
		);
	});

	it("refus on conflict combiné (v1)", () => {
		expectCode(
			() =>
				pgSql(
					"add (find users pick id, email) into archive on conflict (id) ignore"
				),
			"lower_insert_select_with_on_conflict"
		);
	});

	it("refus col cible inconnue (avec schema)", () => {
		expectCode(
			() =>
				pgSql(
					"add (find users pick display_name) into archive",
					SCHEMA
				),
			"lower_insert_select_unknown_target"
		);
	});

	it("mapping via alias pick x as tgt (avec schema)", () => {
		expect(() =>
			pgSql(
				"add (find users pick id, display_name as email) into archive",
				SCHEMA
			)
		).not.toThrow();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Codegen PG
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen PG — INSERT INTO... SELECT", () => {
	it("simple : add (find … pick a, b) into t", () => {
		const { text } = pgSql("add (find users pick id, email) into archive");
		expect(text).toBe(
			'INSERT INTO "archive" ("id", "email") SELECT "id", "email" FROM "users" RETURNING *'
		);
	});

	it("avec where dans sourceQuery", () => {
		const { text, params } = pgSql(
			'add (find users where email like "@old.com%" pick id, email) into archive'
		);
		expect(text).toBe(
			'INSERT INTO "archive" ("id", "email") SELECT "id", "email" FROM "users" WHERE "email" LIKE $1 RETURNING *'
		);
		expect(params).toEqual(["@old.com%"]);
	});

	it("mapping avec pick x as tgt renomme la col cible", () => {
		const { text } = pgSql(
			"add (find users pick id, display_name as email) into archive",
			SCHEMA
		);
		// L'INSERT cols porte le nom cible `email`, le SELECT lit display_name.
		expect(text).toContain('("id", "email")');
		expect(text).toContain('"display_name" AS "email"');
	});

	it("pick count droppe RETURNING", () => {
		const { text } = pgSql(
			"add (find users pick id, email) into archive pick count"
		);
		expect(text).toBe(
			'INSERT INTO "archive" ("id", "email") SELECT "id", "email" FROM "users"'
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Planner : capability insert-select
// ═══════════════════════════════════════════════════════════════════════════

describe("planner — capability 'insert-select' PG + Mongo, KV refusé", () => {
	it("Mongo supporte add (find …) into (aggregate+$merge)", () => {
		const stmt = parse(tokenize("add (find users pick id) into archive"));
		if (stmt.operation !== "insert") throw new Error();
		const mutation = lowerMutation(stmt);
		expect(() =>
			assertMutationInsertSelectSupported(mutation, MONGODB_CAPABILITIES)
		).not.toThrow();
	});

	it("KV refuse add (find …) into", () => {
		const stmt = parse(tokenize("add (find users pick id) into archive"));
		if (stmt.operation !== "insert") throw new Error();
		const mutation = lowerMutation(stmt);
		expectCode(
			() => assertMutationInsertSelectSupported(mutation, KV_CAPABILITIES),
			"planner_insert_select_unsupported"
		);
	});

	it("add rows literal passe partout", () => {
		const stmt = parse(tokenize('add {id: 1, email: "a@b.c"} into archive'));
		if (stmt.operation !== "insert") throw new Error();
		const mutation = lowerMutation(stmt);
		expect(() => assertMutationInsertSelectSupported(mutation, MONGODB_CAPABILITIES)).not.toThrow();
		expect(() => assertMutationInsertSelectSupported(mutation, KV_CAPABILITIES)).not.toThrow();
	});
});
