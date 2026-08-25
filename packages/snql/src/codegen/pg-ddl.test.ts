import { describe, expect, it } from "vitest";
import type { CreateTablePlan, DDLPlan } from "../ir/plan";
import { postgresMapper } from "./postgres";

function mapDDL(plan: DDLPlan) {
	if (postgresMapper.mapDDL === undefined) {
		throw new Error("postgresMapper.mapDDL manquant");
	}
	return postgresMapper.mapDDL(plan);
}

const uuidPk: CreateTablePlan = {
	op: "ddl",
	kind: "create-table",
	target: "users",
	ifNotExists: false,
	fields: [
		{ name: "id", type: "uuid", nullable: false, unique: false },
		{ name: "email", type: "string", nullable: false, unique: true }
	],
	primaryKey: ["id"]
};

describe("codegen PG — create table (ADR-029 DDL/1.5)", () => {
	it("émet CREATE TABLE avec quoteIdent + types PG_DDL_TYPE + PRIMARY KEY", () => {
		const q = mapDDL(uuidPk);
		expect(q.kind).toBe("sql");
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(
			`CREATE TABLE "users" ("id" uuid NOT NULL, "email" text NOT NULL UNIQUE, PRIMARY KEY ("id"))`
		);
		expect(q.params).toEqual([]);
	});

	it("nullable / not null / default bindé + span", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "create-table",
			target: "t",
			ifNotExists: false,
			fields: [
				{ name: "id", type: "uuid", nullable: false, unique: false },
				{ name: "age", type: "int", nullable: true, unique: false },
				{
					name: "tier",
					type: "string",
					nullable: false,
					unique: false,
					defaultValue: "free"
				},
				{
					name: "score",
					type: "int",
					nullable: false,
					unique: false,
					defaultValue: 42
				}
			]
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(
			`CREATE TABLE "t" ("id" uuid NOT NULL, "age" integer, "tier" text NOT NULL DEFAULT $1, "score" integer NOT NULL DEFAULT $2)`
		);
		expect(q.params).toEqual(["free", 42]);
	});

	it("map SnqlType → PG_DDL_TYPE (round-trip D1)", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "create-table",
			target: "matrix",
			ifNotExists: false,
			fields: [
				{ name: "s", type: "string", nullable: true, unique: false },
				{ name: "i", type: "int", nullable: true, unique: false },
				{ name: "bi", type: "bigint", nullable: true, unique: false },
				{ name: "f", type: "float", nullable: true, unique: false },
				{ name: "d", type: "decimal", nullable: true, unique: false },
				{ name: "b", type: "bool", nullable: true, unique: false },
				{ name: "dt", type: "date", nullable: true, unique: false },
				{ name: "j", type: "json", nullable: true, unique: false },
				{ name: "a", type: "array", nullable: true, unique: false },
				{ name: "u", type: "uuid", nullable: true, unique: false },
				{ name: "e", type: "enum", nullable: true, unique: false },
				{ name: "un", type: "unknown", nullable: true, unique: false }
			]
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toContain(`"s" text`);
		expect(q.text).toContain(`"i" integer`);
		expect(q.text).toContain(`"bi" bigint`);
		expect(q.text).toContain(`"f" double precision`);
		expect(q.text).toContain(`"d" numeric`);
		expect(q.text).toContain(`"b" boolean`);
		expect(q.text).toContain(`"dt" timestamptz`);
		expect(q.text).toContain(`"j" jsonb`);
		expect(q.text).toContain(`"a" jsonb`);
		expect(q.text).toContain(`"u" uuid`);
		expect(q.text).toContain(`"e" text`);
		expect(q.text).toContain(`"un" text`);
	});

	it("primary key compound (a, b)", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "create-table",
			target: "pairs",
			ifNotExists: false,
			fields: [
				{ name: "a", type: "uuid", nullable: false, unique: false },
				{ name: "b", type: "uuid", nullable: false, unique: false }
			],
			primaryKey: ["a", "b"]
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toContain(`PRIMARY KEY ("a", "b")`);
	});

	it("if not exists → SqlTransaction 2-steps avec advisory_xact_lock (D3)", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "create-table",
			target: "sessions",
			ifNotExists: true,
			fields: [{ name: "token", type: "string", nullable: false, unique: false }]
		});
		expect(q.kind).toBe("transaction");
		if (q.kind !== "transaction") throw new Error("attendu transaction");
		expect(q.steps).toHaveLength(2);
		const [lock, create] = q.steps;
		if (lock?.kind !== "statement" || create?.kind !== "statement") {
			throw new Error("attendu 2 statements");
		}
		expect(lock.query.text).toBe(
			`SELECT pg_advisory_xact_lock(hashtextextended('sqlnest_ddl:' || $1, 0))`
		);
		expect(lock.query.params).toEqual(["sessions"]);
		expect(create.query.text).toBe(
			`CREATE TABLE IF NOT EXISTS "sessions" ("token" text NOT NULL)`
		);
	});

	it("interdit un identifier non-quoté-safe même si le lower est bypass", () => {
		expect(() =>
			mapDDL({
				op: "ddl",
				kind: "create-table",
				target: 'bad"quote',
				ifNotExists: false,
				fields: [{ name: "id", type: "uuid", nullable: false, unique: false }]
			})
		).toThrow(/Identifiant invalide/);
	});
});
