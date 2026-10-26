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

	it("default json compound inline en '...'::jsonb", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "create-table",
			target: "t",
			ifNotExists: false,
			fields: [
				{ name: "id", type: "uuid", nullable: false, unique: false },
				{
					name: "meta",
					type: "json",
					nullable: false,
					unique: false,
					defaultValue: {
						kind: "json",
						raw: '{"tier":"free","quota":10}',
						parsed: { tier: "free", quota: 10 }
					}
				}
			]
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(
			`CREATE TABLE "t" ("id" uuid NOT NULL, "meta" jsonb NOT NULL DEFAULT '{"tier":"free","quota":10}'::jsonb)`
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
			`CREATE TABLE "t" ("id" uuid NOT NULL, "age" integer, "tier" text NOT NULL DEFAULT 'free', "score" integer NOT NULL DEFAULT 42)`
		);
		// PG DDL rejette les params bindés $N (extended query protocol errors 08P01).
		// Les defaults sont inline via pgInlineDefault — voir postgres.ts.
		expect(q.params).toEqual([]);
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

describe("codegen PG — add column (ADR-029 DDL/2.3)", () => {
	it("émet ALTER TABLE ADD COLUMN minimal", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "add-column",
			target: "users",
			ifNotExists: false,
			column: { name: "age", type: "int", nullable: false, unique: false }
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(`ALTER TABLE "users" ADD COLUMN "age" integer NOT NULL`);
		expect(q.params).toEqual([]);
	});

	it("D10 backfill natif PG : DEFAULT bindé $1", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "add-column",
			target: "users",
			ifNotExists: false,
			column: {
				name: "tier",
				type: "string",
				nullable: false,
				unique: false,
				defaultValue: "free"
			}
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(
			`ALTER TABLE "users" ADD COLUMN "tier" text NOT NULL DEFAULT 'free'`
		);
		expect(q.params).toEqual([]);
	});

	it("nullable + unique", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "add-column",
			target: "users",
			ifNotExists: false,
			column: {
				name: "phone",
				type: "string",
				nullable: true,
				unique: true
			}
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(`ALTER TABLE "users" ADD COLUMN "phone" text UNIQUE`);
	});

	it("if not exists (D3 name-only sémantique)", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "add-column",
			target: "users",
			ifNotExists: true,
			column: { name: "at", type: "date", nullable: true, unique: false }
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(
			`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "at" timestamptz`
		);
	});

	it("interdit un target non-quoté-safe (safety-net quoteIdent)", () => {
		expect(() =>
			mapDDL({
				op: "ddl",
				kind: "add-column",
				target: 'bad"quote',
				ifNotExists: false,
				column: { name: "age", type: "int", nullable: false, unique: false }
			})
		).toThrow(/Identifiant invalide/);
	});
});

describe("codegen PG — add/drop index (ADR-029 DDL/3.3, D11 CONCURRENTLY)", () => {
	it("émet CREATE INDEX CONCURRENTLY (single field)", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "add-index",
			target: "users",
			fields: ["email"],
			name: "idx_users_email",
			ifNotExists: false
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(
			`CREATE INDEX CONCURRENTLY "idx_users_email" ON "users" ("email")`
		);
		expect(q.params).toEqual([]);
	});

	it("compound + UNIQUE + IF NOT EXISTS (D3)", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "add-unique-index",
			target: "pages",
			fields: ["tenant_id", "slug"],
			name: "unique_pages_tenant_id_slug",
			ifNotExists: true
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(
			`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "unique_pages_tenant_id_slug" ON "pages" ("tenant_id", "slug")`
		);
	});

	it("DROP INDEX minimal (pas de CONCURRENTLY sur drop V1)", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "drop-index",
			target: "users",
			name: "idx_users_email",
			ifExists: false
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(`DROP INDEX "idx_users_email"`);
	});

	it("DROP INDEX IF EXISTS (D3)", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "drop-index",
			target: "users",
			name: "idx_users_email",
			ifExists: true
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(`DROP INDEX IF EXISTS "idx_users_email"`);
	});

	it("interdit un name non-quoté-safe (safety-net quoteIdent)", () => {
		expect(() =>
			mapDDL({
				op: "ddl",
				kind: "drop-index",
				target: "users",
				name: 'bad"idx',
				ifExists: false
			})
		).toThrow(/Identifiant invalide/);
	});
});

describe("codegen PG — drop table / drop column (ADR-029 DDL/4.3)", () => {
	it("DROP TABLE RESTRICT (safe vs FK)", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "drop-table",
			target: "users",
			ifExists: false
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(`DROP TABLE "users" RESTRICT`);
	});

	it("DROP TABLE IF EXISTS (D3)", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "drop-table",
			target: "users",
			ifExists: true
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(`DROP TABLE IF EXISTS "users" RESTRICT`);
	});

	it("ALTER TABLE DROP COLUMN RESTRICT", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "drop-column",
			target: "users",
			column: "age",
			ifExists: false
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(
			`ALTER TABLE "users" DROP COLUMN "age" RESTRICT`
		);
	});

	it("ALTER TABLE DROP COLUMN IF EXISTS (D3)", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "drop-column",
			target: "users",
			column: "age",
			ifExists: true
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(
			`ALTER TABLE "users" DROP COLUMN IF EXISTS "age" RESTRICT`
		);
	});
});

describe("codegen PG — create enum (ADR-030 Enum/1.5)", () => {
	it("émet CREATE TYPE ... AS ENUM inline", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "create-enum",
			name: "role_type",
			members: ["user", "admin"],
			ifNotExists: false
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(
			`CREATE TYPE "role_type" AS ENUM ('user', 'admin')`
		);
		expect(q.params).toEqual([]);
	});

	it("if not exists → DO $$ EXCEPTION duplicate_object (D3 idempotence)", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "create-enum",
			name: "status",
			members: ["active", "archived"],
			ifNotExists: true
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(
			`DO $$ BEGIN CREATE TYPE "status" AS ENUM ('active', 'archived'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`
		);
	});

	it("escape single-quote dans les members", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "create-enum",
			name: "quotes",
			members: ["o'brien", "d'arcy"],
			ifNotExists: false
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(
			`CREATE TYPE "quotes" AS ENUM ('o''brien', 'd''arcy')`
		);
	});
});

describe("codegen PG — add enum member (ADR-030 Enum/3.4)", () => {
	it("émet ALTER TYPE ADD VALUE IF NOT EXISTS inline", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "add-enum-member",
			name: "role_type",
			member: "guest",
			ifNotExists: false
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(
			`ALTER TYPE "role_type" ADD VALUE IF NOT EXISTS 'guest'`
		);
		expect(q.params).toEqual([]);
	});

	it("escape single-quote dans le member", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "add-enum-member",
			name: "quotes",
			member: "o'brien",
			ifNotExists: false
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(
			`ALTER TYPE "quotes" ADD VALUE IF NOT EXISTS 'o''brien'`
		);
	});
});

describe("codegen PG — drop enum (ADR-030 Enum/3.4 D8)", () => {
	it("RESTRICT par défaut", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "drop-enum",
			name: "role_type",
			ifExists: false,
			cascade: false
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(`DROP TYPE "role_type" RESTRICT`);
	});

	it("cascade explicite → CASCADE", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "drop-enum",
			name: "role_type",
			ifExists: false,
			cascade: true
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(`DROP TYPE "role_type" CASCADE`);
	});

	it("if exists + cascade → DROP TYPE IF EXISTS ... CASCADE", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "drop-enum",
			name: "role_type",
			ifExists: true,
			cascade: true
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(`DROP TYPE IF EXISTS "role_type" CASCADE`);
	});
});

describe("codegen PG — enum type dans create table + add column (Enum/2.5)", () => {
	it("create table avec field enum → column type = enum name quoted", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "create-table",
			target: "users",
			ifNotExists: false,
			fields: [
				{ name: "id", type: "uuid", nullable: false, unique: false },
				{
					name: "role",
					type: "enum",
					enumTypeName: "role_type",
					enumMembers: ["user", "admin"],
					nullable: false,
					unique: false
				}
			]
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(
			`CREATE TABLE "users" ("id" uuid NOT NULL, "role" "role_type" NOT NULL)`
		);
	});

	it("add column enum → ALTER ADD COLUMN avec type enum name", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "add-column",
			target: "users",
			ifNotExists: false,
			column: {
				name: "tier",
				type: "enum",
				enumTypeName: "tier_type",
				enumMembers: ["free", "pro"],
				nullable: true,
				unique: false
			}
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(
			`ALTER TABLE "users" ADD COLUMN "tier" "tier_type"`
		);
	});
});

describe("codegen PG — ref FK modifier (ADR-031 FK/1)", () => {
	it("émet REFERENCES ... ON DELETE ... ON UPDATE inline dans create table", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "create-table",
			target: "orders",
			ifNotExists: false,
			fields: [
				{ name: "id", type: "uuid", nullable: false, unique: false },
				{
					name: "user_id",
					type: "uuid",
					nullable: false,
					unique: false,
					ref: {
						name: "fk_orders_user_id_users",
						fromColumn: "user_id",
						targetCollection: "users",
						targetColumn: "id",
						onDelete: "cascade",
						onUpdate: "restrict"
					}
				}
			]
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(
			`CREATE TABLE "orders" ("id" uuid NOT NULL, "user_id" uuid NOT NULL ` +
				`CONSTRAINT "fk_orders_user_id_users" REFERENCES "users" ("id") ` +
				`ON DELETE CASCADE ON UPDATE RESTRICT)`
		);
	});

	it("émet SET NULL pour on delete set-null", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "create-table",
			target: "orders",
			ifNotExists: false,
			fields: [
				{
					name: "user_id",
					type: "uuid",
					nullable: true,
					unique: false,
					ref: {
						name: "fk_x",
						fromColumn: "user_id",
						targetCollection: "users",
						targetColumn: "id",
						onDelete: "set-null",
						onUpdate: "restrict"
					}
				}
			]
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toContain("ON DELETE SET NULL");
	});

	it("add column avec ref → ALTER TABLE ADD COLUMN ... REFERENCES", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "add-column",
			target: "posts",
			ifNotExists: false,
			column: {
				name: "author_id",
				type: "uuid",
				nullable: false,
				unique: false,
				ref: {
					name: "fk_posts_author_id_users",
					fromColumn: "author_id",
					targetCollection: "users",
					targetColumn: "id",
					onDelete: "restrict",
					onUpdate: "restrict"
				}
			}
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toContain(
			`CONSTRAINT "fk_posts_author_id_users" REFERENCES "users" ("id")`
		);
	});
});

describe("codegen PG — alter column (ADR-036 E/1c)", () => {
	const base = { op: "ddl" as const, kind: "alter-column" as const, target: "agency", column: "zip" };

	it("nullabilité", () => {
		const nullable = mapDDL({ ...base, action: { kind: "set-nullable" } });
		const notNull = mapDDL({ ...base, action: { kind: "set-not-null" } });
		if (nullable.kind !== "sql" || notNull.kind !== "sql") throw new Error("attendu sql");
		expect(nullable.text).toBe(`ALTER TABLE "agency" ALTER COLUMN "zip" DROP NOT NULL`);
		expect(notNull.text).toBe(`ALTER TABLE "agency" ALTER COLUMN "zip" SET NOT NULL`);
	});

	it("set type sans défaut : TYPE … USING", () => {
		const q = mapDDL({ ...base, action: { kind: "set-type", type: "int" } });
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(
			`ALTER TABLE "agency" ALTER COLUMN "zip" TYPE integer USING "zip"::integer`
		);
	});

	it("set type vers un enum", () => {
		const q = mapDDL({
			...base,
			action: { kind: "set-type", type: "enum", enumTypeName: "TIER", enumMembers: ["a"] }
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toContain(`TYPE "TIER" USING "zip"::"TIER"`);
	});

	it("set type : les colonnes liées par FK prennent le type dans la même transaction", () => {
		const q = mapDDL({
			...base,
			action: { kind: "set-type", type: "bigint" },
			partners: [{ table: "booking", column: "agency_zip" }]
		});
		if (q.kind !== "transaction") throw new Error("attendu transaction");
		expect(
			q.steps.map((s) => (s.kind === "statement" ? s.query.text : ""))
		).toEqual([
			`ALTER TABLE "agency" ALTER COLUMN "zip" TYPE bigint USING "zip"::bigint`,
			`ALTER TABLE "booking" ALTER COLUMN "agency_zip" TYPE bigint USING "agency_zip"::bigint`
		]);
	});

	it("set type avec un défaut : retiré puis reposé converti", () => {
		const q = mapDDL({
			...base,
			action: { kind: "set-type", type: "int" },
			current: { type: "string", nullable: true, hasDefault: true }
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toContain("DO $$");
		expect(q.text).toContain(`EXECUTE 'ALTER TABLE "agency" ALTER COLUMN "zip" DROP DEFAULT';`);
		// Constant : reposé en littéral du nouveau type ; sinon converti par un cast.
		expect(q.text).toContain(
			`EXECUTE format('SELECT ((%s)::integer)::text', d) INTO v;`
		);
		expect(q.text).toContain(`SET DEFAULT %L::integer', v)`);
		expect(q.text).toContain(`SET DEFAULT (%s)::integer', d)`);
	});
});

describe("codegen PG — défauts (ADR-036 E/1d)", () => {
	const base = { op: "ddl" as const, kind: "alter-column" as const, target: "agency", column: "zip" };

	it("set default / drop default", () => {
		const set = mapDDL({ ...base, action: { kind: "set-default", value: "75000" } });
		const fn = mapDDL({ ...base, action: { kind: "set-default", value: { kind: "fn", fn: "uuid" } } });
		const drop = mapDDL({ ...base, action: { kind: "drop-default" } });
		if (set.kind !== "sql" || fn.kind !== "sql" || drop.kind !== "sql") {
			throw new Error("attendu sql");
		}
		expect(set.text).toBe(`ALTER TABLE "agency" ALTER COLUMN "zip" SET DEFAULT '75000'`);
		expect(fn.text).toBe(`ALTER TABLE "agency" ALTER COLUMN "zip" SET DEFAULT gen_random_uuid()`);
		expect(drop.text).toBe(`ALTER TABLE "agency" ALTER COLUMN "zip" DROP DEFAULT`);
	});

	it("bigint : littéral sans cast, relu comme une valeur", () => {
		const q = mapDDL({
			...base,
			action: { kind: "set-default", value: 9007199254740993n }
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(
			`ALTER TABLE "agency" ALTER COLUMN "zip" SET DEFAULT 9007199254740993`
		);
	});
});

describe("codegen PG — rename column (ADR-036 E/1b)", () => {
	it("émet ALTER TABLE RENAME COLUMN", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "rename-column",
			target: "agency",
			column: "phone",
			newName: "mobile"
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(`ALTER TABLE "agency" RENAME COLUMN "phone" TO "mobile"`);
	});
});

describe("codegen PG — add ref (ADR-036 E/1a)", () => {
	it("émet ALTER TABLE ADD CONSTRAINT FOREIGN KEY", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "add-ref",
			target: "orders",
			ref: {
				name: "fk_orders_user_id_users",
				fromColumn: "user_id",
				targetCollection: "users",
				targetColumn: "id",
				onDelete: "cascade",
				onUpdate: "restrict"
			}
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(
			`ALTER TABLE "orders" ADD CONSTRAINT "fk_orders_user_id_users" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE RESTRICT`
		);
		expect(q.params).toEqual([]);
	});
});

describe("codegen PG — drop ref (ADR-031 FK/3)", () => {
	it("émet ALTER TABLE DROP CONSTRAINT", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "drop-ref",
			target: "orders",
			name: "fk_orders_user_id_users",
			ifExists: false
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(
			`ALTER TABLE "orders" DROP CONSTRAINT "fk_orders_user_id_users"`
		);
		expect(q.params).toEqual([]);
	});

	it("DROP CONSTRAINT IF EXISTS (D3)", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "drop-ref",
			target: "orders",
			name: "fk_orders_user_id_users",
			ifExists: true
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(
			`ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "fk_orders_user_id_users"`
		);
	});

	it("interdit un name non-quoté-safe (safety-net quoteIdent)", () => {
		expect(() =>
			mapDDL({
				op: "ddl",
				kind: "drop-ref",
				target: "orders",
				name: 'bad"fk',
				ifExists: false
			})
		).toThrow(/Identifiant invalide/);
	});
});

describe("codegen PG — profil ORM (ADR-036 E/1e)", () => {
	it("clé primaire et unique nommés quand le plan porte leur nom", () => {
		const q = mapDDL({
			...uuidPk,
			primaryKeyName: "users_pkey",
			fields: [
				{ name: "id", type: "uuid", nullable: false, unique: false },
				{
					name: "email",
					type: "string",
					nullable: false,
					unique: true,
					uniqueName: "users_email_key"
				}
			]
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(
			`CREATE TABLE "users" ("id" uuid NOT NULL, "email" text NOT NULL CONSTRAINT "users_email_key" UNIQUE, CONSTRAINT "users_pkey" PRIMARY KEY ("id"))`
		);
	});

	it("add column unique nommé", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "add-column",
			target: "users",
			ifNotExists: false,
			column: {
				name: "slug",
				type: "string",
				nullable: true,
				unique: true,
				uniqueName: "users_slug_key"
			}
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(
			`ALTER TABLE "users" ADD COLUMN "slug" text CONSTRAINT "users_slug_key" UNIQUE`
		);
	});

	it("concurrently: false → CREATE INDEX simple", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "add-index",
			target: "agency",
			fields: ["city"],
			name: "agency_city_idx",
			ifNotExists: false,
			concurrently: false
		});
		if (q.kind !== "sql") throw new Error("attendu sql");
		expect(q.text).toBe(`CREATE INDEX "agency_city_idx" ON "agency" ("city")`);
	});

	it("rename column : index et FK conventionnels renommés dans la même transaction, défaut ignoré", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "rename-column",
			target: "agency",
			column: "code",
			newName: "slug",
			renames: [
				{ kind: "index", from: "agency_code_key", to: "agency_slug_key" },
				{
					kind: "foreign-key",
					from: "agency_code_fkey",
					to: "agency_slug_fkey"
				},
				{ kind: "default", from: "agency_code_df", to: "agency_slug_df" }
			]
		});
		if (q.kind !== "transaction") throw new Error("attendu transaction");
		expect(
			q.steps.map((s) =>
				s.kind === "statement" && s.query.kind === "sql" ? s.query.text : ""
			)
		).toEqual([
			`ALTER TABLE "agency" RENAME COLUMN "code" TO "slug"`,
			`ALTER INDEX "agency_code_key" RENAME TO "agency_slug_key"`,
			`ALTER TABLE "agency" RENAME CONSTRAINT "agency_code_fkey" TO "agency_slug_fkey"`
		]);
	});
});
