import { describe, expect, it } from "vitest";
import { tokenize } from "../lexer/lexer";
import type { CreateTableStmt, DDLFieldDef, DDLStatement } from "../parser/ast";
import { parse } from "../parser/parser";
import { lowerDDL } from "./lower-ddl";
import type {
	AddColumnPlan,
	AddEnumMemberPlan,
	AddIndexPlan,
	CreateEnumPlan,
	CreateTablePlan,
	DropColumnPlan,
	DropEnumPlan,
	DropIndexPlan,
	DropTablePlan
} from "./plan";

function lowerCreate(source: string): CreateTablePlan {
	const parsed = parse(tokenize(source)) as DDLStatement;
	const plan = lowerDDL(parsed);
	if (plan.kind !== "create-table") {
		throw new Error(`expected create-table plan, got ${plan.kind}`);
	}
	return plan;
}

function lowerAdd(source: string): AddColumnPlan {
	const parsed = parse(tokenize(source)) as DDLStatement;
	const plan = lowerDDL(parsed);
	if (plan.kind !== "add-column") {
		throw new Error(`expected add-column plan, got ${plan.kind}`);
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

	it("accepte un default object literal sur type json", () => {
		const plan = lowerCreate(
			`create table t { meta: json default {tier: "free", quota: 10} }`
		);
		expect(plan.fields[0]?.defaultValue).toEqual({
			kind: "json",
			raw: '{"tier":"free","quota":10}',
			parsed: { tier: "free", quota: 10 }
		});
	});

	it("accepte un default array literal sur type json (imbriqué)", () => {
		const plan = lowerCreate(
			`create table t { tags: json default [1, "a", true, null] }`
		);
		expect(plan.fields[0]?.defaultValue).toEqual({
			kind: "json",
			raw: '[1,"a",true,null]',
			parsed: [1, "a", true, null]
		});
	});

	it("rejette un default object literal sur type non-json", () => {
		expect(() =>
			lowerCreate("create table t { meta: text default {a: 1} }")
		).toThrow(/l'object\/array literal n'est admis que sur 'type: json'/);
	});

	it("rejette un default json avec call imbriqué", () => {
		expect(() =>
			lowerCreate("create table t { meta: json default {t: now()} }")
		).toThrow(/n'est pas un littéral/);
	});
});

describe("lower DDL — add column (ADR-029 DDL/2)", () => {
	it("abaisse un add column minimal", () => {
		expect(lowerAdd("add column age int into users")).toMatchObject({
			op: "ddl",
			kind: "add-column",
			target: "users",
			ifNotExists: false,
			column: { name: "age", type: "int", nullable: false, unique: false }
		});
	});

	it("propage nullable + default (D10 backfill = adapter runtime, PAS lower)", () => {
		const plan = lowerAdd(
			'add column tier text nullable default "free" into users'
		);
		expect(plan.column).toMatchObject({
			name: "tier",
			type: "string",
			nullable: true,
			defaultValue: "free"
		});
	});

	it("propage `if not exists` (D3)", () => {
		expect(
			lowerAdd(
				'add column tier text default "free" if not exists into users'
			)
		).toMatchObject({ ifNotExists: true, target: "users" });
	});

	it("D6 alias PG paste-friendly sur add column", () => {
		expect(lowerAdd("add column at timestamptz into users")).toMatchObject({
			column: { name: "at", type: "date" }
		});
	});

	it("rejette un default non-literal (D1 safety)", () => {
		expect(() =>
			lowerAdd("add column x int default now() into t")
		).toThrow(/littéral scalaire/);
	});

	it("accepte un default object literal sur type json (add column)", () => {
		const plan = lowerAdd(
			`add column meta json default {tier: "free"} into users`
		);
		expect(plan.column.defaultValue).toEqual({
			kind: "json",
			raw: '{"tier":"free"}',
			parsed: { tier: "free" }
		});
	});

	it("rejette un target non-ident (D1 safety-net via parser DDL)", () => {
		// Parser rejette d'abord — safety net réel via AST synthétique déjà
		// couvert dans le suite create-table (assertIdent partagée).
		expect(() =>
			lowerAdd("add column x int into 1users")
		).toThrow();
	});
});

function lowerIndex(source: string): AddIndexPlan {
	const parsed = parse(tokenize(source)) as DDLStatement;
	const plan = lowerDDL(parsed);
	if (plan.kind !== "add-index" && plan.kind !== "add-unique-index") {
		throw new Error(`expected add-index plan, got ${plan.kind}`);
	}
	return plan;
}

function lowerDrop(source: string): DropIndexPlan {
	const parsed = parse(tokenize(source)) as DDLStatement;
	const plan = lowerDDL(parsed);
	if (plan.kind !== "drop-index") {
		throw new Error(`expected drop-index plan, got ${plan.kind}`);
	}
	return plan;
}

describe("lower DDL — add/drop index (ADR-029 DDL/3)", () => {
	it("abaisse un add index avec nom auto-généré (pattern idx_<t>_<f>)", () => {
		expect(lowerIndex("add index (email) into users")).toMatchObject({
			op: "ddl",
			kind: "add-index",
			target: "users",
			fields: ["email"],
			name: "idx_users_email",
			ifNotExists: false
		});
	});

	it("compound index → nom auto joined par _", () => {
		expect(
			lowerIndex("add index (last_name, first_name) into users")
		).toMatchObject({
			name: "idx_users_last_name_first_name",
			fields: ["last_name", "first_name"]
		});
	});

	it("unique → prefix unique_ dans le nom auto", () => {
		expect(lowerIndex("add unique index (email) into users")).toMatchObject({
			kind: "add-unique-index",
			name: "unique_users_email"
		});
	});

	it("if not exists (D3)", () => {
		expect(
			lowerIndex("add index (a, b) if not exists into t")
		).toMatchObject({ ifNotExists: true });
	});

	it("nom > 63 chars tronqué (WiredTiger limit)", () => {
		const longFields = [
			"a".repeat(20),
			"b".repeat(20),
			"c".repeat(20)
		];
		const src = `add index (${longFields.join(", ")}) into t`;
		const p = lowerIndex(src);
		expect(p.name.length).toBeLessThanOrEqual(63);
	});

	it("dédup fields refusée (usage error)", () => {
		expect(() =>
			lowerIndex("add index (email, email) into users")
		).toThrow(/plusieurs fois/);
	});

	it("drop index minimal", () => {
		expect(
			lowerDrop("drop index idx_users_email from users")
		).toMatchObject({
			op: "ddl",
			kind: "drop-index",
			target: "users",
			name: "idx_users_email",
			ifExists: false
		});
	});

	it("drop index if exists (D3)", () => {
		expect(
			lowerDrop("drop index idx_users_email from users if exists")
		).toMatchObject({ ifExists: true });
	});
});

function lowerDropTable(source: string): DropTablePlan {
	const parsed = parse(tokenize(source)) as DDLStatement;
	const plan = lowerDDL(parsed);
	if (plan.kind !== "drop-table") {
		throw new Error(`expected drop-table plan, got ${plan.kind}`);
	}
	return plan;
}

function lowerDropCol(source: string): DropColumnPlan {
	const parsed = parse(tokenize(source)) as DDLStatement;
	const plan = lowerDDL(parsed);
	if (plan.kind !== "drop-column") {
		throw new Error(`expected drop-column plan, got ${plan.kind}`);
	}
	return plan;
}

describe("lower DDL — drop table / drop column (ADR-029 DDL/4)", () => {
	it("abaisse drop table minimal", () => {
		expect(lowerDropTable("drop table users")).toMatchObject({
			op: "ddl",
			kind: "drop-table",
			target: "users",
			ifExists: false
		});
	});

	it("drop table if exists (D3)", () => {
		expect(
			lowerDropTable("drop table users if exists")
		).toMatchObject({ ifExists: true });
	});

	it("abaisse drop column minimal", () => {
		expect(lowerDropCol("drop column age from users")).toMatchObject({
			op: "ddl",
			kind: "drop-column",
			target: "users",
			column: "age",
			ifExists: false
		});
	});

	it("drop column if exists (D3)", () => {
		expect(
			lowerDropCol("drop column age from users if exists")
		).toMatchObject({ ifExists: true });
	});
});

function lowerCreateEnum(source: string): CreateEnumPlan {
	const parsed = parse(tokenize(source)) as DDLStatement;
	const plan = lowerDDL(parsed);
	if (plan.kind !== "create-enum") {
		throw new Error(`expected create-enum plan, got ${plan.kind}`);
	}
	return plan;
}

describe("lower DDL — create enum (ADR-030 Enum/1)", () => {
	it("abaisse create enum minimal", () => {
		expect(lowerCreateEnum('create enum role_type { "user", "admin" }')).toMatchObject({
			op: "ddl",
			kind: "create-enum",
			name: "role_type",
			members: ["user", "admin"],
			ifNotExists: false
		});
	});

	it("propage if not exists (D3)", () => {
		expect(
			lowerCreateEnum('create enum if not exists status { "a" }')
		).toMatchObject({ ifNotExists: true });
	});

	it("D1 : refuse enum name commençant par un chiffre", () => {
		expect(() => lowerCreateEnum('create enum 1bad { "a" }')).toThrow();
	});

	it("refuse member dupliqué", () => {
		expect(() =>
			lowerCreateEnum('create enum role_type { "user", "user" }')
		).toThrow(/dupliqué/);
	});

	it("accepte 63 chars pile pour enum name (D1 boundary)", () => {
		const long = `x${"y".repeat(62)}`;
		expect(long.length).toBe(63);
		expect(lowerCreateEnum(`create enum ${long} { "a" }`)).toMatchObject({
			name: long
		});
	});
});

describe("lower DDL — resolve type field via schema.enums (Enum/2)", () => {
	const schemaWithEnum: import("../schema/model").SchemaModel = {
		engine: "postgres",
		collections: [],
		relations: [],
		enums: [{ name: "role_type", members: ["user", "admin"], source: "declared" }]
	};

	function lowerWithSchema(source: string): CreateTablePlan {
		const parsed = parse(tokenize(source)) as DDLStatement;
		const plan = lowerDDL(parsed, schemaWithEnum);
		if (plan.kind !== "create-table") {
			throw new Error(`expected create-table plan, got ${plan.kind}`);
		}
		return plan;
	}

	it("resolve `type: role_type` → SnqlType enum + enumTypeName + enumMembers", () => {
		const plan = lowerWithSchema(
			"create table users { id: uuid, role: role_type }"
		);
		expect(plan.fields[1]).toMatchObject({
			name: "role",
			type: "enum",
			enumTypeName: "role_type",
			enumMembers: ["user", "admin"]
		});
	});

	it("refuse `type: unknown_enum` avec liste enums en scope", () => {
		expect(() =>
			lowerWithSchema("create table t { role: unknown_enum }")
		).toThrow(/inconnu.*Enums disponibles.*role_type/);
	});

	it("builtin passe-plat inchangé quand schema.enums peuplé", () => {
		const plan = lowerWithSchema("create table t { name: text }");
		expect(plan.fields[0]).toMatchObject({ name: "name", type: "string" });
		expect(plan.fields[0]?.enumTypeName).toBeUndefined();
	});

	it("add column enum-ref → resolved dans le CreateTableField", () => {
		const parsed = parse(tokenize("add column role role_type into users")) as DDLStatement;
		const plan = lowerDDL(parsed, schemaWithEnum);
		if (plan.kind !== "add-column") throw new Error("expected add-column");
		expect(plan.column).toMatchObject({
			name: "role",
			type: "enum",
			enumTypeName: "role_type",
			enumMembers: ["user", "admin"]
		});
	});
});

describe("lower DDL — add enum member (ADR-030 Enum/3)", () => {
	const schemaWithEnum: import("../schema/model").SchemaModel = {
		engine: "postgres",
		collections: [],
		relations: [],
		enums: [{ name: "role_type", members: ["user", "admin"], source: "declared" }]
	};

	function lowerAddMember(
		source: string,
		schema?: import("../schema/model").SchemaModel
	): AddEnumMemberPlan {
		const parsed = parse(tokenize(source)) as DDLStatement;
		const plan = lowerDDL(parsed, schema);
		if (plan.kind !== "add-enum-member") {
			throw new Error(`expected add-enum-member plan, got ${plan.kind}`);
		}
		return plan;
	}

	it("abaisse minimal (sans schema — analyse offline)", () => {
		expect(
			lowerAddMember('add enum member role_type "guest"')
		).toMatchObject({
			op: "ddl",
			kind: "add-enum-member",
			name: "role_type",
			member: "guest",
			ifNotExists: false
		});
	});

	it("propage ifNotExists", () => {
		expect(
			lowerAddMember('add enum member role_type "guest" if not exists')
		).toMatchObject({ ifNotExists: true });
	});

	it("valide que l'enum existe si schema fourni", () => {
		expect(() =>
			lowerAddMember('add enum member unknown_enum "x"', schemaWithEnum)
		).toThrow(/inconnu.*role_type/);
	});

	it("D1 : refuse enum name commençant par un chiffre", () => {
		expect(() =>
			lowerAddMember('add enum member 1bad "x"')
		).toThrow();
	});
});

describe("lower DDL — drop enum (ADR-030 Enum/3 D8)", () => {
	const schemaWithEnum: import("../schema/model").SchemaModel = {
		engine: "postgres",
		collections: [],
		relations: [],
		enums: [{ name: "role_type", members: ["user", "admin"], source: "declared" }]
	};

	function lowerDropEnum(
		source: string,
		schema?: import("../schema/model").SchemaModel
	): DropEnumPlan {
		const parsed = parse(tokenize(source)) as DDLStatement;
		const plan = lowerDDL(parsed, schema);
		if (plan.kind !== "drop-enum") {
			throw new Error(`expected drop-enum plan, got ${plan.kind}`);
		}
		return plan;
	}

	it("abaisse minimal", () => {
		expect(lowerDropEnum("drop enum role_type")).toMatchObject({
			op: "ddl",
			kind: "drop-enum",
			name: "role_type",
			ifExists: false,
			cascade: false
		});
	});

	it("propage if exists + cascade", () => {
		expect(
			lowerDropEnum("drop enum role_type if exists cascade")
		).toMatchObject({ ifExists: true, cascade: true });
	});

	it("refuse enum inconnu sans ifExists (schema fourni)", () => {
		expect(() =>
			lowerDropEnum("drop enum unknown_enum", schemaWithEnum)
		).toThrow(/inconnu/);
	});

	it("ifExists → pas de refus si enum inconnu (silence D3 pattern)", () => {
		expect(() =>
			lowerDropEnum("drop enum unknown_enum if exists", schemaWithEnum)
		).not.toThrow();
	});

	it("D1 : refuse enum name commençant par un chiffre", () => {
		expect(() => lowerDropEnum("drop enum 1bad")).toThrow();
	});
});
