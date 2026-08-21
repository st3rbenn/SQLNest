/**
 * Sprint T2/14 — Feature 1 : mutation join (`update t [as a] with one X on l=f set …`).
 *
 * Couvre :
 *  - parser  : `as <alias>` + `with one X on l=f [and Y on ...]` avant where/set
 *  - lower   : refus `with many`, alias source + join autorisés en set/where
 *  - IR      : MutationPlan.update.alias + .joins (PlanUpdateJoin[])
 *  - planner : capability `write-join` (PG only) refuse Mongo/KV
 *  - codegen : `UPDATE t AS a SET … FROM x AS b WHERE t.l = b.f AND (predicate)`
 */

import { describe, expect, it } from "vitest";
import { SnqlError } from "./diagnostics";
import {
	assertMutationWriteJoinSupported,
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
			name: "resource",
			source: "declared",
			primaryKey: ["id"],
			fields: [
				{ name: "id", type: "uuid", nullable: false, source: "declared" },
				{ name: "first_name", type: "string", nullable: false, source: "declared" },
				{ name: "status", type: "string", nullable: true, source: "declared" },
				{ name: "agency_id", type: "uuid", nullable: false, source: "declared" }
			]
		},
		{
			name: "agency",
			source: "declared",
			primaryKey: ["id"],
			fields: [
				{ name: "id", type: "uuid", nullable: false, source: "declared" },
				{ name: "region_id", type: "uuid", nullable: false, source: "declared" }
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
// Parser : as alias + with one X on
// ═══════════════════════════════════════════════════════════════════════════

describe("parser — update as + with", () => {
	it("update t as a set …", () => {
		const stmt = parse(tokenize('update resource as r set status = "closed"'));
		if (stmt.operation !== "update") throw new Error();
		expect(stmt.alias).toBe("r");
	});

	it("update t with one X on l=f set …", () => {
		const stmt = parse(
			tokenize('update resource with one agency on agency_id = id set status = "closed"')
		);
		if (stmt.operation !== "update") throw new Error();
		expect(stmt.joins).toHaveLength(1);
		expect(stmt.joins?.[0]?.type).toBe("with");
	});

	it("update t as a with one X as b on l=f where … set …", () => {
		const stmt = parse(
			tokenize(
				'update resource as r with one agency as a on agency_id = id where a.region_id = "reg-1" set status = "closed"'
			)
		);
		if (stmt.operation !== "update") throw new Error();
		expect(stmt.alias).toBe("r");
		expect(stmt.joins).toHaveLength(1);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Lower : refus `with many`, alias autorisés
// ═══════════════════════════════════════════════════════════════════════════

describe("lower — mutation join validations", () => {
	it("with many refusé", () => {
		expectCode(
			() =>
				pgSql(
					'update resource with many agency on agency_id = id set status = "x"'
				),
			"lower_write_join_many"
		);
	});

	it("alias join utilisable en where (avec schema)", () => {
		expect(() =>
			pgSql(
				'update resource with one agency as a on agency_id = id where a.region_id = "r1" set status = "x"',
				SCHEMA
			)
		).not.toThrow();
	});

	it("alias source `t as r` utilisable en where", () => {
		expect(() =>
			pgSql(
				'update resource as r with one agency as a on agency_id = id where a.region_id = r.agency_id set status = "x"',
				SCHEMA
			)
		).not.toThrow();
	});

	it("head alias inconnu refusé (avec schema)", () => {
		expectCode(
			() =>
				pgSql(
					'update resource with one agency as a on agency_id = id where zzz.region_id = "r1" set status = "x"',
					SCHEMA
				),
			"lower_unknown_alias"
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Codegen PG : UPDATE ... FROM
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen PG — UPDATE ... FROM", () => {
	it("update simple sans join reste `UPDATE t SET`", () => {
		const { text } = pgSql('update resource set status = "closed"');
		expect(text).toBe('UPDATE "resource" SET "status" = $1 RETURNING *');
	});

	it("update as a set", () => {
		const { text } = pgSql('update resource as r set status = "closed"');
		expect(text).toBe(
			'UPDATE "resource" AS "r" SET "status" = $1 RETURNING *'
		);
	});

	it("update with one X on l=f — key auto-préfixée", () => {
		const { text } = pgSql(
			'update resource with one agency on agency_id = id set status = "closed"'
		);
		expect(text).toBe(
			'UPDATE "resource" SET "status" = $1 FROM "agency" AS "agency" WHERE "resource"."agency_id" = "agency"."id" RETURNING *'
		);
	});

	it("update as r with one X as a on ... where + set", () => {
		const { text } = pgSql(
			'update resource as r with one agency as a on agency_id = id where a.region_id = "reg-1" set status = "closed"'
		);
		expect(text).toBe(
			'UPDATE "resource" AS "r" SET "status" = $1 FROM "agency" AS "a" WHERE "r"."agency_id" = "a"."id" AND "a"."region_id" = $2 RETURNING *'
		);
	});

	it("update multi-joins (with … and …)", () => {
		const { text } = pgSql(
			'update resource with one agency as a on agency_id = id and one agency as b on agency_id = id set status = "x"'
		);
		// 2 FROM entries + 2 join preds AND'd.
		expect(text).toContain('FROM "agency" AS "a", "agency" AS "b"');
		expect(text).toContain('"resource"."agency_id" = "a"."id" AND "resource"."agency_id" = "b"."id"');
	});

	it("pick count droppe RETURNING", () => {
		const { text } = pgSql(
			'update resource with one agency on agency_id = id set status = "x" pick count'
		);
		expect(text).not.toContain("RETURNING");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Planner : capability write-join
// ═══════════════════════════════════════════════════════════════════════════

describe("planner — capability 'write-join' PG + Mongo (PM/4), KV refusé", () => {
	it("Mongo supporte update … with one … (PM/4 aggregate+$merge)", () => {
		const stmt = parse(
			tokenize('update resource with one agency on agency_id = id set status = "x"')
		);
		if (stmt.operation !== "update") throw new Error();
		const mutation = lowerMutation(stmt);
		expect(() =>
			assertMutationWriteJoinSupported(mutation, MONGODB_CAPABILITIES)
		).not.toThrow();
	});

	it("KV refuse update … with one …", () => {
		const stmt = parse(
			tokenize('update resource with one agency on agency_id = id set status = "x"')
		);
		if (stmt.operation !== "update") throw new Error();
		const mutation = lowerMutation(stmt);
		expectCode(
			() => assertMutationWriteJoinSupported(mutation, KV_CAPABILITIES),
			"planner_write_join_unsupported"
		);
	});

	it("update sans join passe partout", () => {
		const stmt = parse(tokenize('update resource set status = "x"'));
		if (stmt.operation !== "update") throw new Error();
		const mutation = lowerMutation(stmt);
		expect(() => assertMutationWriteJoinSupported(mutation, MONGODB_CAPABILITIES)).not.toThrow();
	});
});
