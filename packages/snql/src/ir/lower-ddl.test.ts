import { describe, expect, it } from "vitest";
import { tokenize } from "../lexer/lexer";
import type { CreateTableStmt, DDLFieldDef, DDLStatement } from "../parser/ast";
import { parse } from "../parser/parser";
import { lowerDDL } from "./lower-ddl";
import type { CreateTablePlan } from "./plan";

function lowerCreate(source: string): CreateTablePlan {
	const parsed = parse(tokenize(source)) as DDLStatement;
	const plan = lowerDDL(parsed);
	if (plan.kind !== "create-table") {
		throw new Error(`expected create-table plan, got ${plan.kind}`);
	}
	return plan;
}

const zeroSpan = { start: 0, end: 0 } as const;

function fakeField(
	name: string,
	overrides: Partial<Omit<DDLFieldDef, "name" | "span">> = {}
): DDLFieldDef {
	return {
		name,
		type: "string",
		span: zeroSpan,
		...overrides
	};
}

function fakeCreate(overrides: {
	target?: string;
	fields?: readonly DDLFieldDef[];
	primaryKey?: readonly string[];
	ifNotExists?: boolean;
}): CreateTableStmt {
	return {
		operation: "ddl",
		kind: "create-table",
		target: overrides.target ?? "users",
		fields: overrides.fields ?? [fakeField("id", { type: "uuid" })],
		...(overrides.primaryKey !== undefined
			? { primaryKey: overrides.primaryKey }
			: {}),
		...(overrides.ifNotExists !== undefined
			? { ifNotExists: overrides.ifNotExists }
			: {}),
		span: zeroSpan
	};
}

describe("lower DDL — create table (ADR-029)", () => {
	it("abaisse un create table minimal", () => {
		const plan = lowerCreate("create table users { id: uuid, email: text }");
		expect(plan).toMatchObject({
			op: "ddl",
			kind: "create-table",
			target: "users",
			ifNotExists: false,
			fields: [
				{ name: "id", type: "uuid", nullable: false, unique: false },
				{ name: "email", type: "string", nullable: false, unique: false }
			]
		});
		expect(plan.primaryKey).toBeUndefined();
	});

	it("propage `if not exists` (D3)", () => {
		const plan = lowerCreate(
			"create table if not exists sessions { token: text }"
		);
		expect(plan.ifNotExists).toBe(true);
	});

	it("normalise unique + nullable + defaults (D0 body)", () => {
		const plan = lowerCreate(
			`create table users {
				id: uuid unique,
				email: text not null,
				age: int nullable,
				tier: text default "free",
				score: int default 42,
				active: bool default true,
				bio: text default null
			}`
		);
		expect(plan.fields).toMatchObject([
			{ name: "id", unique: true, nullable: false },
			{ name: "email", nullable: false, unique: false },
			{ name: "age", nullable: true, unique: false },
			{ name: "tier", defaultValue: "free", nullable: false },
			{ name: "score", defaultValue: 42, nullable: false },
			{ name: "active", defaultValue: true, nullable: false },
			{ name: "bio", defaultValue: null, nullable: false }
		]);
	});

	it("préserve decimal en raw (précision arbitraire)", () => {
		const plan = lowerCreate(
			"create table prices { amount: decimal default 3.14 }"
		);
		expect(plan.fields[0]?.defaultValue).toEqual({
			kind: "decimal",
			raw: "3.14"
		});
	});

	it("convertit un default bigint en bigint natif", () => {
		const plan = lowerCreate("create table t { n: bigint default 42 }");
		expect(plan.fields[0]?.defaultValue).toBe(42n);
	});

	it("primary key single-field passe check reference", () => {
		const plan = lowerCreate(
			"create table users { id: uuid, name: text, primary key (id) }"
		);
		expect(plan.primaryKey).toEqual(["id"]);
	});

	it("primary key compound passe check reference", () => {
		const plan = lowerCreate(
			"create table pairs { a: uuid, b: uuid, primary key (a, b) }"
		);
		expect(plan.primaryKey).toEqual(["a", "b"]);
	});

	it("rejette un target non-ident (D1 safety-net)", () => {
		expect(() => lowerDDL(fakeCreate({ target: "u$$" }))).toThrow(
			/identifiant DDL valide/
		);
	});

	it("rejette un field name non-ident (D1 safety-net)", () => {
		expect(() =>
			lowerDDL(fakeCreate({ fields: [fakeField("email$")] }))
		).toThrow(/identifiant DDL valide/);
	});

	it("rejette un ident > 63 chars (WiredTiger limit D1)", () => {
		const long = "x".repeat(64);
		expect(() =>
			lowerCreate(`create table t { ${long}: text }`)
		).toThrow(/identifiant DDL valide/);
	});

	it("accepte un ident = 63 chars pile", () => {
		const long = `x${"y".repeat(62)}`;
		expect(long.length).toBe(63);
		const plan = lowerCreate(`create table t { ${long}: text }`);
		expect(plan.fields[0]?.name).toBe(long);
	});

	it("rejette un ident commençant par un chiffre (D1)", () => {
		expect(() => lowerCreate("create table 1users { id: uuid }")).toThrow();
	});

	it("rejette un default non-literal (call)", () => {
		expect(() =>
			lowerCreate("create table t { id: uuid default now() }")
		).toThrow(/littéral scalaire/);
	});

	it("rejette un default non-literal (field ref)", () => {
		expect(() =>
			lowerCreate("create table t { a: text, b: text default a }")
		).toThrow(/littéral scalaire/);
	});

	it("rejette une primary key qui réfère un field inconnu", () => {
		expect(() =>
			lowerCreate("create table t { id: uuid, primary key (nope) }")
		).toThrow(/n'est pas déclaré dans le body/);
	});

	it("accepte un string literal contenant '$where' (donnée, pas opérateur)", () => {
		const plan = lowerCreate(
			`create table t { flag: text default "$where" }`
		);
		expect(plan.fields[0]?.defaultValue).toBe("$where");
	});
});
