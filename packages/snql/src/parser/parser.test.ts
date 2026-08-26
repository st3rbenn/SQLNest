import { describe, expect, it } from "vitest";
import { tokenize } from "../lexer/lexer";
import type { Query } from "./ast";
import { parse } from "./parser";

function ast(source: string): Query {
	return parse(tokenize(source));
}

describe("parser", () => {
	it("parse verbe + source + étapes", () => {
		const q = ast("get users where age > 30 limit 5");
		expect(q).toMatchObject({
			operation: "select",
			verb: "get",
			source: { collection: "users" },
			stages: [{ type: "where" }, { type: "limit", count: 5 }]
		});
	});

	it("collapse l'alias `find` vers 'select'", () => {
		expect(ast("find users").operation).toBe("select");
	});

	it("'and' lie plus fort que 'or'", () => {
		const q = ast("get u where a = 1 or b = 2 and c = 3");
		expect(q.stages[0]).toMatchObject({
			type: "where",
			predicate: {
				type: "logical",
				operator: "or",
				left: { type: "compare" },
				right: { type: "logical", operator: "and" }
			}
		});
	});

	it("parenthèses forcent la précédence", () => {
		const q = ast("get u where (a = 1 or b = 2) and c = 3");
		expect(q.stages[0]).toMatchObject({
			type: "where",
			predicate: {
				type: "logical",
				operator: "and",
				left: { type: "logical", operator: "or" }
			}
		});
	});

	it("parse alias, chemins pointés et 'in'", () => {
		const q = ast(
			`get users as u where u.role in ["admin", "mod"] pick u.name as n`
		);
		expect(q.source).toMatchObject({ collection: "users", alias: "u" });
		expect(q.stages[0]).toMatchObject({
			type: "where",
			predicate: { type: "in", target: { type: "field", path: ["u", "role"] } }
		});
		expect(q.stages[1]).toMatchObject({
			type: "pick",
			fields: [{ path: ["u", "name"], alias: "n" }]
		});
	});

	it("rejette une requête sans verbe", () => {
		expect(() => ast("users limit 1")).toThrow(/verbe/i);
	});

	it("rejette un mot inattendu après la source", () => {
		expect(() => ast("get users frobnicate 1")).toThrow();
	});

	it("rejette un stage hors ordre canonique (limit avant sort)", () => {
		expect(() => ast("get users limit 5 sort age")).toThrow(/hors ordre/i);
	});

	it("parse plusieurs joins chaînés par `and`", () => {
		const q = ast(
			"get users with addresses on id = user_id and orders on id = user_id"
		);
		expect(q.stages).toHaveLength(2);
		expect(q.stages[0]).toMatchObject({
			type: "with",
			collection: "addresses"
		});
		expect(q.stages[1]).toMatchObject({ type: "with", collection: "orders" });
	});

	it("accepte 'constructor'/'__proto__' comme identifiants (bug G, prototype)", () => {
		expect(ast("get constructor").source).toMatchObject({
			collection: "constructor"
		});
		expect(ast("get __proto__").source).toMatchObject({
			collection: "__proto__"
		});
	});

	it("parse un littéral numérique négatif (bug D)", () => {
		const q = ast("get users where balance = -50");
		expect(q.stages[0]).toMatchObject({
			type: "where",
			predicate: {
				type: "compare",
				operator: "=",
				right: { type: "literal", value: { kind: "number", raw: "-50" } }
			}
		});
	});

	it("parse un join 'with … on … = …'", () => {
		const q = ast("get users with orders on id = user_id");
		expect(q.stages[0]).toMatchObject({
			type: "with",
			collection: "orders",
			localField: ["id"],
			foreignField: ["user_id"]
		});
	});

	it("parse un join avec alias", () => {
		expect(
			ast("get users with orders as cmds on id = user_id").stages[0]
		).toMatchObject({ type: "with", collection: "orders", alias: "cmds" });
	});

	it("rejette un 'with' sans 'on'", () => {
		expect(() => ast("get users with orders")).toThrow(/on/i);
	});
});

// ─── DDL Tier-2 (ADR-029) — create table ───────────────────────────────
import type { Statement } from "./ast";

function stmt(source: string): Statement {
	return parse(tokenize(source));
}

describe("create table DDL (ADR-029)", () => {
	it("parse minimal create table", () => {
		expect(stmt("create table users { id: uuid, email: text }")).toMatchObject({
			operation: "ddl",
			kind: "create-table",
			target: "users",
			ifNotExists: false,
			fields: [
				{ name: "id", type: { kind: "builtin", type: "uuid" } },
				{ name: "email", type: { kind: "builtin", type: "string" } }
			]
		});
	});

	it("parse if not exists (D3)", () => {
		expect(
			stmt("create table if not exists sessions { token: text }")
		).toMatchObject({
			kind: "create-table",
			target: "sessions",
			ifNotExists: true
		});
	});

	it("parse primary key single (D13)", () => {
		expect(
			stmt("create table users { id: uuid, name: text, primary key (id) }")
		).toMatchObject({ primaryKey: ["id"] });
	});

	it("parse primary key compound (D13)", () => {
		expect(
			stmt("create table pairs { a: uuid, b: uuid, primary key (a, b) }")
		).toMatchObject({ primaryKey: ["a", "b"] });
	});

	it("parse field modifiers nullable / not null / default / unique", () => {
		const s = stmt(
			`create table users {
				id: uuid unique,
				email: text not null,
				age: int nullable,
				tier: text default "free"
			}`
		);
		expect((s as { fields: unknown[] }).fields).toMatchObject([
			{ name: "id", type: { kind: "builtin", type: "uuid" }, unique: true },
			{ name: "email", type: { kind: "builtin", type: "string" }, nullable: false },
			{ name: "age", type: { kind: "builtin", type: "int" }, nullable: true },
			{ name: "tier", type: { kind: "builtin", type: "string" } }
		]);
	});

	it("parse alias types PG paste-friendly (D6)", () => {
		const s = stmt(
			"create table t { a: varchar, b: jsonb, c: timestamptz, d: bigserial, e: int8, f: boolean }"
		) as { fields: readonly { type: { kind: "builtin"; type: string } | { kind: "enum-ref"; name: string } }[] };
		expect(
			s.fields.map((f) => (f.type.kind === "builtin" ? f.type.type : null))
		).toEqual(["string", "json", "date", "bigint", "bigint", "bool"]);
	});

	it("Enum/2 : type non-builtin devient enum-ref (le lower valide)", () => {
		const s = stmt("create table t { role: role_type }") as {
			fields: readonly { type: unknown }[];
		};
		expect(s.fields[0]?.type).toEqual({ kind: "enum-ref", name: "role_type" });
	});

	it("préserve `create { ... } into t` insert alias (dispatch DDL non-invasif)", () => {
		expect(stmt('create { name: "a" } into t')).toMatchObject({
			operation: "insert",
			verb: "create"
		});
	});

	it("Enum/2 : type inconnu accepté au parser (le lower décide builtin/enum)", () => {
		// Le parser laisse passer tout ident lowercase — le refus final vient
		// du lower quand aucun enum match dans schema.enums (voir lower-ddl.test).
		expect(() => stmt("create table t { a: fakeType }")).not.toThrow();
	});

	it("refuse 'primary' sans 'key'", () => {
		expect(() => stmt("create table t { a: uuid, primary (a) }")).toThrow(
			/'primary' doit être suivi de 'key'/
		);
	});

	it("refuse body vide", () => {
		expect(() => stmt("create table t {}")).toThrow(/attend au moins un field/);
	});

	it("refuse field dupliqué dans le body", () => {
		expect(() => stmt("create table t { a: uuid, a: text }")).toThrow(
			/Field dupliqué/
		);
	});

	it("refuse primary key déclaré deux fois", () => {
		expect(() =>
			stmt("create table t { a: uuid, primary key (a), primary key (a) }")
		).toThrow(/déclaré deux fois/);
	});
});

// ─── Enum/1 — create enum (ADR-030) ───────────────────────────────
describe("create enum DDL (ADR-030 Enum/1)", () => {
	it("parse minimal create enum", () => {
		expect(stmt('create enum role_type { "user", "admin" }')).toMatchObject({
			operation: "ddl",
			kind: "create-enum",
			name: "role_type",
			members: ["user", "admin"]
		});
	});

	it("parse create enum single member", () => {
		expect(stmt('create enum status { "active" }')).toMatchObject({
			kind: "create-enum",
			name: "status",
			members: ["active"]
		});
	});

	it("parse if not exists", () => {
		expect(
			stmt('create enum if not exists role_type { "user" }')
		).toMatchObject({
			kind: "create-enum",
			ifNotExists: true,
			members: ["user"]
		});
	});

	it("préserve `create { … } into t` insert alias (dispatch enum non-invasif)", () => {
		expect(stmt('create { enum: "x" } into t')).toMatchObject({
			operation: "insert",
			verb: "create"
		});
	});

	it("refuse body vide", () => {
		expect(() => stmt("create enum role_type {}")).toThrow(
			/attend au moins un member/
		);
	});

	it("refuse member non-string (ident)", () => {
		expect(() => stmt("create enum role_type { user }")).toThrow(
			/doit être un string literal/
		);
	});

	it("refuse member non-string (number)", () => {
		expect(() => stmt("create enum n { 1, 2 }")).toThrow(
			/doit être un string literal/
		);
	});

	it("Q1 tranché — casing libre (PascalCase OK)", () => {
		expect(stmt('create enum Role { "user" }')).toMatchObject({
			kind: "create-enum",
			name: "Role"
		});
	});

	it("Q1 tranché — casing libre (snake_case OK)", () => {
		expect(stmt('create enum user_role { "u" }')).toMatchObject({
			kind: "create-enum",
			name: "user_role"
		});
	});
});

// ─── DDL/2 — add column (ADR-029) ───────────────────────────────────
describe("add column DDL (ADR-029 DDL/2)", () => {
	it("parse minimal add column", () => {
		expect(stmt("add column age int into users")).toMatchObject({
			operation: "ddl",
			kind: "add-column",
			target: "users",
			column: { name: "age", type: { kind: "builtin", type: "int" } }
		});
	});

	it("parse add column not null default (D10 backfill obligatoire cross-engine)", () => {
		expect(
			stmt('add column tier text not null default "free" into users')
		).toMatchObject({
			kind: "add-column",
			target: "users",
			column: {
				name: "tier",
				type: { kind: "builtin", type: "string" },
				nullable: false
			}
		});
	});

	it("parse add column nullable + unique", () => {
		expect(stmt("add column phone text nullable unique into users")).toMatchObject({
			column: { name: "phone", nullable: true, unique: true }
		});
	});

	it("parse if not exists (D3)", () => {
		expect(
			stmt("add column tier text default \"free\" if not exists into users")
		).toMatchObject({
			ifNotExists: true,
			target: "users"
		});
	});

	it("parse alias types PG paste-friendly (D6) sur add column", () => {
		expect(stmt("add column at timestamptz into users")).toMatchObject({
			column: { name: "at", type: { kind: "builtin", type: "date" } }
		});
	});

	it("Enum/2 : add column type enum-ref", () => {
		expect(stmt("add column role role_type into users")).toMatchObject({
			column: { name: "role", type: { kind: "enum-ref", name: "role_type" } }
		});
	});

	it("préserve `add {...} into t` insert alias (dispatch non-invasif)", () => {
		expect(stmt('add { name: "a" } into t')).toMatchObject({
			operation: "insert",
			verb: "add"
		});
	});

	it("préserve un field nommé 'column' dans un insert (soft-ident)", () => {
		expect(stmt('add { column: "id", value: 1 } into t')).toMatchObject({
			operation: "insert"
		});
	});

	it("Enum/2 : add column type inconnu accepté au parser (lower décide)", () => {
		expect(() => stmt("add column x fakeType into t")).not.toThrow();
	});

	it("refuse missing 'into'", () => {
		expect(() => stmt("add column x int users")).toThrow(
			/'into <table>'/
		);
	});
});

// ─── DDL/3 — add index / add unique index / drop index (ADR-029) ───────
describe("add/drop index DDL (ADR-029 DDL/3)", () => {
	it("parse add index single-field", () => {
		expect(stmt("add index (email) into users")).toMatchObject({
			operation: "ddl",
			kind: "add-index",
			target: "users",
			fields: ["email"]
		});
	});

	it("parse add index compound", () => {
		expect(stmt("add index (last_name, first_name) into users")).toMatchObject({
			kind: "add-index",
			fields: ["last_name", "first_name"]
		});
	});

	it("parse add unique index (D12 KV middleware SETNX)", () => {
		expect(stmt("add unique index (email) into users")).toMatchObject({
			kind: "add-unique-index",
			fields: ["email"]
		});
	});

	it("parse add unique index compound", () => {
		expect(
			stmt("add unique index (tenant_id, slug) into pages")
		).toMatchObject({
			kind: "add-unique-index",
			fields: ["tenant_id", "slug"]
		});
	});

	it("parse if not exists (D3)", () => {
		expect(
			stmt("add unique index (email) if not exists into users")
		).toMatchObject({ ifNotExists: true, kind: "add-unique-index" });
	});

	it("parse drop index minimal", () => {
		expect(stmt("drop index idx_users_email from users")).toMatchObject({
			operation: "ddl",
			kind: "drop-index",
			target: "users",
			name: "idx_users_email"
		});
	});

	it("parse drop index if exists (D3)", () => {
		expect(
			stmt("drop index idx_users_email from users if exists")
		).toMatchObject({ ifExists: true, kind: "drop-index" });
	});

	it("refuse add index sans fields (parens vides)", () => {
		expect(() => stmt("add index () into users")).toThrow(
			/attend au moins un field/
		);
	});

	it("refuse add index sans 'into'", () => {
		expect(() => stmt("add index (email) users")).toThrow(
			/'into <table>'/
		);
	});

	it("refuse drop index sans 'from'", () => {
		expect(() => stmt("drop index idx_email users")).toThrow(
			/'from <table>'/
		);
	});

	it("préserve `add {index: 42} into t` insert alias (dispatch soft-ident non-invasif)", () => {
		expect(stmt("add { index: 42 } into t")).toMatchObject({
			operation: "insert"
		});
	});
});

// ─── DDL/4 — drop table / drop column (ADR-029) ────────────────────────
describe("drop table / drop column DDL (ADR-029 DDL/4)", () => {
	it("parse drop table minimal", () => {
		expect(stmt("drop table users")).toMatchObject({
			operation: "ddl",
			kind: "drop-table",
			target: "users"
		});
	});

	it("parse drop table if exists (D3)", () => {
		expect(stmt("drop table users if exists")).toMatchObject({
			ifExists: true,
			kind: "drop-table"
		});
	});

	it("parse drop column minimal", () => {
		expect(stmt("drop column age from users")).toMatchObject({
			operation: "ddl",
			kind: "drop-column",
			target: "users",
			column: "age"
		});
	});

	it("parse drop column if exists (D3)", () => {
		expect(stmt("drop column age from users if exists")).toMatchObject({
			ifExists: true,
			kind: "drop-column"
		});
	});

	it("refuse drop column sans 'from'", () => {
		expect(() => stmt("drop column age users")).toThrow(/'from <table>'/);
	});

	it("préserve `drop` comme ident hors DDL (soft-ident head-of-statement)", () => {
		// `drop` en tant que field/ident dans un DML normal reste valide —
		// dispatch DDL uniquement si suivi de `table`/`column`/`index`.
		expect(stmt('add {drop: "yes"} into t')).toMatchObject({
			operation: "insert"
		});
	});
});
