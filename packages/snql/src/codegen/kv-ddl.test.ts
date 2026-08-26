import { describe, expect, it } from "vitest";
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
} from "../ir/plan";
import type {
	KvDDLAddColumnQuery,
	KvDDLAddEnumMemberQuery,
	KvDDLAddIndexQuery,
	KvDDLCreateEnumQuery,
	KvDDLCreateTableQuery,
	KvDDLDropColumnQuery,
	KvDDLDropEnumQuery,
	KvDDLDropIndexQuery,
	KvDDLDropTableQuery
} from "./mapper";
import { mapKvDDL } from "./kv-ddl";

function mapCreate(plan: CreateTablePlan): KvDDLCreateTableQuery {
	const q = mapKvDDL(plan);
	if (q.operation !== "create-table") {
		throw new Error(`attendu create-table, got ${q.operation}`);
	}
	return q;
}

function mapAdd(plan: AddColumnPlan): KvDDLAddColumnQuery {
	const q = mapKvDDL(plan);
	if (q.operation !== "add-column") {
		throw new Error(`attendu add-column, got ${q.operation}`);
	}
	return q;
}

function mapAddIdx(plan: AddIndexPlan): KvDDLAddIndexQuery {
	const q = mapKvDDL(plan);
	if (q.operation !== "add-index") {
		throw new Error(`attendu add-index, got ${q.operation}`);
	}
	return q;
}

function mapDropIdx(plan: DropIndexPlan): KvDDLDropIndexQuery {
	const q = mapKvDDL(plan);
	if (q.operation !== "drop-index") {
		throw new Error(`attendu drop-index, got ${q.operation}`);
	}
	return q;
}

function mapDropTbl(plan: DropTablePlan): KvDDLDropTableQuery {
	const q = mapKvDDL(plan);
	if (q.operation !== "drop-table") {
		throw new Error(`attendu drop-table, got ${q.operation}`);
	}
	return q;
}

function mapDropCol(plan: DropColumnPlan): KvDDLDropColumnQuery {
	const q = mapKvDDL(plan);
	if (q.operation !== "drop-column") {
		throw new Error(`attendu drop-column, got ${q.operation}`);
	}
	return q;
}

describe("codegen KV — create table (ADR-029 DDL/1.7)", () => {
	it("émet KvDDLQuery minimal avec fields descriptors", () => {
		const q = mapCreate({
			op: "ddl",
			kind: "create-table",
			target: "users",
			ifNotExists: false,
			fields: [
				{ name: "email", type: "string", nullable: false, unique: false }
			]
		});
		expect(q).toEqual({
			engine: "kv",
			kind: "kv-ddl",
			operation: "create-table",
			collection: "users",
			ifNotExists: false,
			fields: [
				{ name: "email", type: "string", nullable: false, unique: false }
			]
		});
	});

	it("map SnqlType 1:1 (D1 round-trip identity — pas de coercion)", () => {
		const q = mapCreate({
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
		expect(q.fields.map((f) => f.type)).toEqual([
			"string",
			"int",
			"bigint",
			"float",
			"decimal",
			"bool",
			"date",
			"json",
			"array",
			"uuid",
			"enum",
			"unknown"
		]);
	});

	it("D13 : primary key single (id) propagé tel quel (jamais refus)", () => {
		const q = mapCreate({
			op: "ddl",
			kind: "create-table",
			target: "users",
			ifNotExists: false,
			fields: [
				{ name: "id", type: "uuid", nullable: false, unique: false },
				{ name: "email", type: "string", nullable: false, unique: false }
			],
			primaryKey: ["id"]
		});
		expect(q.primaryKey).toEqual(["id"]);
	});

	it("D13 : primary key compound propagé tel quel (jamais refus)", () => {
		const q = mapCreate({
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
		expect(q.primaryKey).toEqual(["a", "b"]);
	});

	it("D13 : primary key sur field ≠ 'id' propagé (compensation runtime, PAS refus)", () => {
		// C'est le fix qui prouve la doctrine : sur Mongo c'est refus sémantique,
		// sur KV c'est compensation. Aucun refus « engine gap » sur KV.
		const q = mapCreate({
			op: "ddl",
			kind: "create-table",
			target: "users",
			ifNotExists: false,
			fields: [
				{ name: "email", type: "string", nullable: false, unique: false }
			],
			primaryKey: ["email"]
		});
		expect(q.primaryKey).toEqual(["email"]);
	});

	it("uniqueFields extrait de fields.unique=true", () => {
		const q = mapCreate({
			op: "ddl",
			kind: "create-table",
			target: "users",
			ifNotExists: false,
			fields: [
				{ name: "id", type: "uuid", nullable: false, unique: false },
				{ name: "email", type: "string", nullable: false, unique: true },
				{ name: "handle", type: "string", nullable: false, unique: true }
			]
		});
		expect(q.uniqueFields).toEqual(["email", "handle"]);
	});

	it("bigint / decimal defaults sérialisés lossless (D1)", () => {
		const q = mapCreate({
			op: "ddl",
			kind: "create-table",
			target: "t",
			ifNotExists: false,
			fields: [
				{
					name: "big",
					type: "bigint",
					nullable: false,
					unique: false,
					defaultValue: 9007199254740993n
				},
				{
					name: "price",
					type: "decimal",
					nullable: false,
					unique: false,
					defaultValue: { kind: "decimal", raw: "3.1415926535" }
				}
			]
		});
		expect(q.fields[0]?.defaultValue).toBe("9007199254740993");
		expect(q.fields[1]?.defaultValue).toBe("3.1415926535");
	});

	it("ifNotExists propagé (D3 : adapter existence-check `_schema` hash)", () => {
		const q = mapCreate({
			op: "ddl",
			kind: "create-table",
			target: "sessions",
			ifNotExists: true,
			fields: [
				{ name: "token", type: "string", nullable: false, unique: false }
			]
		});
		expect(q.ifNotExists).toBe(true);
	});
});

describe("codegen KV — add column (ADR-029 DDL/2.5)", () => {
	it("émet KvDDLAddColumnQuery minimal (nullable, pas de default, pas de preflight)", () => {
		const q = mapAdd({
			op: "ddl",
			kind: "add-column",
			target: "users",
			ifNotExists: false,
			column: { name: "phone", type: "string", nullable: true, unique: false }
		});
		expect(q).toEqual({
			engine: "kv",
			kind: "kv-ddl",
			operation: "add-column",
			collection: "users",
			ifNotExists: false,
			column: {
				name: "phone",
				type: "string",
				nullable: true,
				unique: false
			},
			backfill: false,
			preflightNotNull: false
		});
	});

	it("D2 preflight = NOT NULL sans default → preflightNotNull=true", () => {
		const q = mapAdd({
			op: "ddl",
			kind: "add-column",
			target: "users",
			ifNotExists: false,
			column: { name: "handle", type: "string", nullable: false, unique: false }
		});
		expect(q.backfill).toBe(false);
		expect(q.preflightNotNull).toBe(true);
	});

	it("D10 backfill = default présent → backfill=true, preflightNotNull=false", () => {
		const q = mapAdd({
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
		expect(q.column).toMatchObject({
			name: "tier",
			type: "string",
			nullable: false,
			unique: false,
			defaultValue: "free"
		});
		expect(q.backfill).toBe(true);
		expect(q.preflightNotNull).toBe(false);
	});

	it("bigint / decimal defaults sérialisés lossless (D1)", () => {
		const bigQ = mapAdd({
			op: "ddl",
			kind: "add-column",
			target: "t",
			ifNotExists: false,
			column: {
				name: "big",
				type: "bigint",
				nullable: false,
				unique: false,
				defaultValue: 9007199254740993n
			}
		});
		expect(bigQ.column.defaultValue).toBe("9007199254740993");
		const decQ = mapAdd({
			op: "ddl",
			kind: "add-column",
			target: "t",
			ifNotExists: false,
			column: {
				name: "price",
				type: "decimal",
				nullable: false,
				unique: false,
				defaultValue: { kind: "decimal", raw: "3.1415926535" }
			}
		});
		expect(decQ.column.defaultValue).toBe("3.1415926535");
	});

	it("KV_META_TYPE identity 1:1 (D1)", () => {
		const q = mapAdd({
			op: "ddl",
			kind: "add-column",
			target: "t",
			ifNotExists: false,
			column: { name: "at", type: "date", nullable: true, unique: false }
		});
		expect(q.column.type).toBe("date");
	});

	it("ifNotExists propagé (D3)", () => {
		const q = mapAdd({
			op: "ddl",
			kind: "add-column",
			target: "users",
			ifNotExists: true,
			column: { name: "x", type: "int", nullable: true, unique: false }
		});
		expect(q.ifNotExists).toBe(true);
	});
});

describe("codegen KV — add/drop index (ADR-029 DDL/3.5 D12 middleware SETNX)", () => {
	it("add index non-unique → uniqueEnforcement: 'none' (no-op planner)", () => {
		const q = mapAddIdx({
			op: "ddl",
			kind: "add-index",
			target: "users",
			fields: ["email"],
			name: "idx_users_email",
			ifNotExists: false
		});
		expect(q).toEqual({
			engine: "kv",
			kind: "kv-ddl",
			operation: "add-index",
			collection: "users",
			ifNotExists: false,
			name: "idx_users_email",
			fields: ["email"],
			unique: false,
			uniqueEnforcement: "none"
		});
	});

	it("add unique index → uniqueEnforcement: 'middleware-setnx' (D12)", () => {
		const q = mapAddIdx({
			op: "ddl",
			kind: "add-unique-index",
			target: "users",
			fields: ["email"],
			name: "unique_users_email",
			ifNotExists: false
		});
		expect(q.unique).toBe(true);
		expect(q.uniqueEnforcement).toBe("middleware-setnx");
	});

	it("compound unique → fields propagés en ordre", () => {
		const q = mapAddIdx({
			op: "ddl",
			kind: "add-unique-index",
			target: "pages",
			fields: ["tenant_id", "slug"],
			name: "unique_pages_tenant_id_slug",
			ifNotExists: false
		});
		expect(q.fields).toEqual(["tenant_id", "slug"]);
		expect(q.uniqueEnforcement).toBe("middleware-setnx");
	});

	it("drop index minimal", () => {
		const q = mapDropIdx({
			op: "ddl",
			kind: "drop-index",
			target: "users",
			name: "idx_users_email",
			ifExists: false
		});
		expect(q).toEqual({
			engine: "kv",
			kind: "kv-ddl",
			operation: "drop-index",
			collection: "users",
			ifExists: false,
			name: "idx_users_email"
		});
	});

	it("drop index if exists (D3)", () => {
		expect(
			mapDropIdx({
				op: "ddl",
				kind: "drop-index",
				target: "users",
				name: "idx_users_email",
				ifExists: true
			}).ifExists
		).toBe(true);
	});
});

describe("codegen KV — drop table / drop column (ADR-029 DDL/4.5)", () => {
	it("drop-table minimal (adapter SCAN + DEL batched + DEL _schema)", () => {
		const q = mapDropTbl({
			op: "ddl",
			kind: "drop-table",
			target: "users",
			ifExists: false
		});
		expect(q).toEqual({
			engine: "kv",
			kind: "kv-ddl",
			operation: "drop-table",
			collection: "users",
			ifExists: false
		});
	});

	it("drop-table if exists (D3 adapter HEXISTS _schema skip si absent)", () => {
		expect(
			mapDropTbl({
				op: "ddl",
				kind: "drop-table",
				target: "users",
				ifExists: true
			}).ifExists
		).toBe(true);
	});

	it("drop-column minimal (adapter SCAN + HDEL batched miroir D10)", () => {
		const q = mapDropCol({
			op: "ddl",
			kind: "drop-column",
			target: "users",
			column: "age",
			ifExists: false
		});
		expect(q).toEqual({
			engine: "kv",
			kind: "kv-ddl",
			operation: "drop-column",
			collection: "users",
			column: "age",
			ifExists: false
		});
	});

	it("drop-column if exists (D3 name-only)", () => {
		expect(
			mapDropCol({
				op: "ddl",
				kind: "drop-column",
				target: "users",
				column: "age",
				ifExists: true
			}).ifExists
		).toBe(true);
	});
});

describe("codegen KV — create enum (ADR-030 Enum/1.7)", () => {
	function mapEnum(plan: CreateEnumPlan): KvDDLCreateEnumQuery {
		const q = mapKvDDL(plan);
		if (q.operation !== "create-enum") {
			throw new Error(`attendu create-enum, got ${q.operation}`);
		}
		return q;
	}

	it("émet shape create-enum avec name + members", () => {
		expect(
			mapEnum({
				op: "ddl",
				kind: "create-enum",
				name: "role_type",
				members: ["user", "admin"],
				ifNotExists: false
			})
		).toEqual({
			engine: "kv",
			kind: "kv-ddl",
			operation: "create-enum",
			name: "role_type",
			members: ["user", "admin"],
			ifNotExists: false
		});
	});

	it("propage ifNotExists (adapter HEXISTS pre-check)", () => {
		expect(
			mapEnum({
				op: "ddl",
				kind: "create-enum",
				name: "s",
				members: ["a"],
				ifNotExists: true
			}).ifNotExists
		).toBe(true);
	});
});

describe("codegen KV — enum type dans create table + add column (Enum/2.7)", () => {
	it("create table field enum → descriptor `{enumTypeName, enum: [...]}`", () => {
		const q = mapCreate({
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
		expect(q.fields[1]).toMatchObject({
			name: "role",
			type: "enum",
			enumTypeName: "role_type",
			enum: ["user", "admin"]
		});
	});

	it("add column enum → descriptor enrichi", () => {
		const q = mapAdd({
			op: "ddl",
			kind: "add-column",
			target: "users",
			ifNotExists: false,
			column: {
				name: "tier",
				type: "enum",
				enumTypeName: "tier_type",
				enumMembers: ["free", "pro"],
				nullable: false,
				unique: false
			}
		});
		expect(q.column).toMatchObject({
			name: "tier",
			type: "enum",
			enumTypeName: "tier_type",
			enum: ["free", "pro"]
		});
	});
});

describe("codegen KV — add enum member (ADR-030 Enum/3.6)", () => {
	function mapAddMember(plan: AddEnumMemberPlan): KvDDLAddEnumMemberQuery {
		const q = mapKvDDL(plan);
		if (q.operation !== "add-enum-member") {
			throw new Error(`attendu add-enum-member, got ${q.operation}`);
		}
		return q;
	}

	it("émet shape add-enum-member avec name + member", () => {
		expect(
			mapAddMember({
				op: "ddl",
				kind: "add-enum-member",
				name: "role_type",
				member: "guest",
				ifNotExists: false
			})
		).toEqual({
			engine: "kv",
			kind: "kv-ddl",
			operation: "add-enum-member",
			name: "role_type",
			member: "guest",
			ifNotExists: false
		});
	});

	it("propage ifNotExists (idempotent silence)", () => {
		expect(
			mapAddMember({
				op: "ddl",
				kind: "add-enum-member",
				name: "role_type",
				member: "guest",
				ifNotExists: true
			}).ifNotExists
		).toBe(true);
	});
});

describe("codegen KV — drop enum (ADR-030 Enum/3.6 D8)", () => {
	function mapDropEnum(plan: DropEnumPlan): KvDDLDropEnumQuery {
		const q = mapKvDDL(plan);
		if (q.operation !== "drop-enum") {
			throw new Error(`attendu drop-enum, got ${q.operation}`);
		}
		return q;
	}

	it("émet shape drop-enum RESTRICT par défaut", () => {
		expect(
			mapDropEnum({
				op: "ddl",
				kind: "drop-enum",
				name: "role_type",
				ifExists: false,
				cascade: false
			})
		).toEqual({
			engine: "kv",
			kind: "kv-ddl",
			operation: "drop-enum",
			name: "role_type",
			ifExists: false,
			cascade: false
		});
	});

	it("propage cascade + ifExists", () => {
		const q = mapDropEnum({
			op: "ddl",
			kind: "drop-enum",
			name: "role_type",
			ifExists: true,
			cascade: true
		});
		expect(q.ifExists).toBe(true);
		expect(q.cascade).toBe(true);
	});
});
