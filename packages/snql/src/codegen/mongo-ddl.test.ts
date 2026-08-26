import { describe, expect, it } from "vitest";
import type {
	AddColumnPlan,
	AddEnumMemberPlan,
	AddIndexPlan,
	CreateEnumPlan,
	CreateTablePlan,
	DDLPlan,
	DropColumnPlan,
	DropEnumPlan,
	DropIndexPlan,
	DropTablePlan
} from "../ir/plan";
import type {
	MongoDDLAddColumnQuery,
	MongoDDLAddEnumMemberQuery,
	MongoDDLAddIndexQuery,
	MongoDDLCreateCollectionQuery,
	MongoDDLCreateEnumQuery,
	MongoDDLDropCollectionQuery,
	MongoDDLDropColumnQuery,
	MongoDDLDropEnumQuery,
	MongoDDLDropIndexQuery
} from "./mapper";
import { mongoMapper } from "./mongodb";

function mapCreate(plan: CreateTablePlan): MongoDDLCreateCollectionQuery {
	if (mongoMapper.mapDDL === undefined) {
		throw new Error("mongoMapper.mapDDL manquant");
	}
	const q = mongoMapper.mapDDL(plan);
	if (q.kind !== "mongo-ddl" || q.operation !== "create-collection") {
		throw new Error(`attendu mongo-ddl create-collection, got ${q.kind}`);
	}
	return q;
}

function mapAdd(plan: AddColumnPlan): MongoDDLAddColumnQuery {
	if (mongoMapper.mapDDL === undefined) {
		throw new Error("mongoMapper.mapDDL manquant");
	}
	const q = mongoMapper.mapDDL(plan);
	if (q.kind !== "mongo-ddl" || q.operation !== "add-column") {
		throw new Error(`attendu mongo-ddl add-column, got ${q.kind}`);
	}
	return q;
}

/** compat wrapper : les tests DDL/1 utilisent mapDDL générique. */
function mapDDL(plan: DDLPlan): MongoDDLCreateCollectionQuery {
	return mapCreate(plan as CreateTablePlan);
}

function mapAddIdx(plan: AddIndexPlan): MongoDDLAddIndexQuery {
	if (mongoMapper.mapDDL === undefined) throw new Error("mapDDL manquant");
	const q = mongoMapper.mapDDL(plan);
	if (q.kind !== "mongo-ddl" || q.operation !== "add-index") {
		throw new Error(`attendu add-index, got ${q.kind}`);
	}
	return q;
}

function mapDropIdx(plan: DropIndexPlan): MongoDDLDropIndexQuery {
	if (mongoMapper.mapDDL === undefined) throw new Error("mapDDL manquant");
	const q = mongoMapper.mapDDL(plan);
	if (q.kind !== "mongo-ddl" || q.operation !== "drop-index") {
		throw new Error(`attendu drop-index, got ${q.kind}`);
	}
	return q;
}

function mapDropCol(plan: DropColumnPlan): MongoDDLDropColumnQuery {
	if (mongoMapper.mapDDL === undefined) throw new Error("mapDDL manquant");
	const q = mongoMapper.mapDDL(plan);
	if (q.kind !== "mongo-ddl" || q.operation !== "drop-column") {
		throw new Error(`attendu drop-column, got ${q.kind}`);
	}
	return q;
}

function mapDropTable(plan: DropTablePlan): MongoDDLDropCollectionQuery {
	if (mongoMapper.mapDDL === undefined) throw new Error("mapDDL manquant");
	const q = mongoMapper.mapDDL(plan);
	if (q.kind !== "mongo-ddl" || q.operation !== "drop-collection") {
		throw new Error(`attendu drop-collection, got ${q.kind}`);
	}
	return q;
}

describe("codegen Mongo — create table (ADR-029 DDL/1.6)", () => {
	it("émet MongoDDLQuery avec validator $jsonSchema minimal", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "create-table",
			target: "users",
			ifNotExists: false,
			fields: [
				{ name: "email", type: "string", nullable: false, unique: false }
			]
		});
		expect(q).toMatchObject({
			engine: "mongodb",
			kind: "mongo-ddl",
			operation: "create-collection",
			collection: "users",
			ifNotExists: false,
			validator: {
				$jsonSchema: {
					bsonType: "object",
					properties: { email: { bsonType: "string" } },
					required: ["email"]
				}
			}
		});
		expect(q.indexes).toBeUndefined();
		expect(q.primaryKeyAlias).toBeUndefined();
	});

	it("map SnqlType → MONGO_BSON_TYPE (D1)", () => {
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
		const props = (
			(q.validator as { $jsonSchema: { properties: Record<string, { bsonType?: string }> } })
				.$jsonSchema.properties
		);
		expect(props.s?.bsonType).toBe("string");
		expect(props.i?.bsonType).toBe("int");
		expect(props.bi?.bsonType).toBe("long");
		expect(props.f?.bsonType).toBe("double");
		expect(props.d?.bsonType).toBe("decimal");
		expect(props.b?.bsonType).toBe("bool");
		expect(props.dt?.bsonType).toBe("date");
		expect(props.j?.bsonType).toBe("object");
		expect(props.a?.bsonType).toBe("array");
		expect(props.u?.bsonType).toBe("binData");
		expect(props.e?.bsonType).toBe("string");
		expect(props.un?.bsonType).toBeUndefined(); // unknown → pas de contrainte
	});

	it("D13 : primary key (id) single-field UUID → alias _id, id skip du validator", () => {
		const q = mapDDL({
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
		expect(q.primaryKeyAlias).toBe("id");
		const schema = q.validator as { $jsonSchema: { properties: Record<string, unknown>; required: string[] } };
		expect(schema.$jsonSchema.properties).not.toHaveProperty("id");
		expect(schema.$jsonSchema.properties).toHaveProperty("email");
		expect(schema.$jsonSchema.required).toEqual(["email"]);
		expect(q.indexes).toBeUndefined();
	});

	it("D13 : primary key compound (a, b) → createIndex unique pk_a_b", () => {
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
		expect(q.primaryKeyAlias).toBeUndefined();
		expect(q.indexes).toEqual([
			{ keys: { a: 1, b: 1 }, options: { unique: true, name: "pk_a_b" } }
		]);
	});

	it("D13 refus sémantique : primary key single sur field ≠ 'id' → codegen_mongo_primary_key_not_id", () => {
		expect(() =>
			mapDDL({
				op: "ddl",
				kind: "create-table",
				target: "users",
				ifNotExists: false,
				fields: [
					{ name: "email", type: "string", nullable: false, unique: false }
				],
				primaryKey: ["email"]
			})
		).toThrow(/PK unique|add unique index/);
	});

	it("field unique → createIndex secondaire (skip si aliasé _id)", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "create-table",
			target: "users",
			ifNotExists: false,
			fields: [
				{ name: "id", type: "uuid", nullable: false, unique: true },
				{ name: "email", type: "string", nullable: false, unique: true }
			],
			primaryKey: ["id"]
		});
		expect(q.primaryKeyAlias).toBe("id");
		expect(q.indexes).toEqual([
			{ keys: { email: 1 }, options: { unique: true, name: "unique_email" } }
		]);
	});

	it("ifNotExists=true propagé (D3 adapter catch NamespaceExists 48)", () => {
		const q = mapDDL({
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

describe("codegen Mongo — add column (ADR-029 DDL/2.4)", () => {
	it("émet mongo-ddl add-column minimal (nullable, pas de default, pas de preflight)", () => {
		const q = mapAdd({
			op: "ddl",
			kind: "add-column",
			target: "users",
			ifNotExists: false,
			column: { name: "phone", type: "string", nullable: true, unique: false }
		});
		expect(q).toEqual({
			engine: "mongodb",
			kind: "mongo-ddl",
			operation: "add-column",
			collection: "users",
			ifNotExists: false,
			column: { name: "phone", bsonType: "string", required: false },
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
		expect(q.column.required).toBe(true);
		expect(q.backfill).toBe(false);
		expect(q.preflightNotNull).toBe(true);
	});

	it("D10 backfill = default présent → backfill=true, preflightNotNull=false (default couvre l'invariance)", () => {
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
			bsonType: "string",
			required: true,
			defaultValue: "free"
		});
		expect(q.backfill).toBe(true);
		expect(q.preflightNotNull).toBe(false);
	});

	it("nullable + default → backfill=true, preflightNotNull=false, required=false", () => {
		const q = mapAdd({
			op: "ddl",
			kind: "add-column",
			target: "users",
			ifNotExists: false,
			column: {
				name: "note",
				type: "string",
				nullable: true,
				unique: false,
				defaultValue: ""
			}
		});
		expect(q.column.required).toBe(false);
		expect(q.backfill).toBe(true);
		expect(q.preflightNotNull).toBe(false);
	});

	it("default json compound → unwrap `.parsed` natif pour l'adapter $set", () => {
		const q = mapAdd({
			op: "ddl",
			kind: "add-column",
			target: "users",
			ifNotExists: false,
			column: {
				name: "meta",
				type: "json",
				nullable: false,
				unique: false,
				defaultValue: {
					kind: "json",
					raw: '{"tier":"free"}',
					parsed: { tier: "free" }
				}
			}
		});
		expect(q.column.defaultValue).toEqual({ tier: "free" });
		expect(q.backfill).toBe(true);
	});

	it("unique → index secondaire propagé", () => {
		const q = mapAdd({
			op: "ddl",
			kind: "add-column",
			target: "users",
			ifNotExists: false,
			column: {
				name: "email",
				type: "string",
				nullable: false,
				unique: true,
				defaultValue: ""
			}
		});
		expect(q.index).toEqual({
			keys: { email: 1 },
			options: { unique: true, name: "unique_email" }
		});
	});

	it("MONGO_BSON_TYPE mapping (D1)", () => {
		const q = mapAdd({
			op: "ddl",
			kind: "add-column",
			target: "t",
			ifNotExists: false,
			column: { name: "at", type: "date", nullable: true, unique: false }
		});
		expect(q.column.bsonType).toBe("date");
	});

	it("unknown SnqlType → bsonType null (pas de contrainte validator)", () => {
		const q = mapAdd({
			op: "ddl",
			kind: "add-column",
			target: "t",
			ifNotExists: false,
			column: { name: "raw", type: "unknown", nullable: true, unique: false }
		});
		expect(q.column.bsonType).toBeNull();
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

describe("codegen Mongo — add/drop index (ADR-029 DDL/3.4)", () => {
	it("add index single-field → keys {f:1} + name auto (pas de unique)", () => {
		const q = mapAddIdx({
			op: "ddl",
			kind: "add-index",
			target: "users",
			fields: ["email"],
			name: "idx_users_email",
			ifNotExists: false
		});
		expect(q).toEqual({
			engine: "mongodb",
			kind: "mongo-ddl",
			operation: "add-index",
			collection: "users",
			ifNotExists: false,
			index: {
				keys: { email: 1 },
				options: { name: "idx_users_email" }
			}
		});
	});

	it("add unique index compound → keys {a:1, b:1} + options.unique=true", () => {
		const q = mapAddIdx({
			op: "ddl",
			kind: "add-unique-index",
			target: "pages",
			fields: ["tenant_id", "slug"],
			name: "unique_pages_tenant_id_slug",
			ifNotExists: true
		});
		expect(q.index).toEqual({
			keys: { tenant_id: 1, slug: 1 },
			options: { unique: true, name: "unique_pages_tenant_id_slug" }
		});
		expect(q.ifNotExists).toBe(true);
	});

	it("drop index minimal (D3 ifExists false)", () => {
		const q = mapDropIdx({
			op: "ddl",
			kind: "drop-index",
			target: "users",
			name: "idx_users_email",
			ifExists: false
		});
		expect(q).toEqual({
			engine: "mongodb",
			kind: "mongo-ddl",
			operation: "drop-index",
			collection: "users",
			ifExists: false,
			name: "idx_users_email"
		});
	});

	it("drop index if exists → ifExists=true propagé (adapter catch IndexNotFound 27)", () => {
		const q = mapDropIdx({
			op: "ddl",
			kind: "drop-index",
			target: "users",
			name: "idx_users_email",
			ifExists: true
		});
		expect(q.ifExists).toBe(true);
	});
});

describe("codegen Mongo — drop table / drop column (ADR-029 DDL/4.4)", () => {
	it("drop-collection minimal (D3 ifExists false)", () => {
		const q = mapDropTable({
			op: "ddl",
			kind: "drop-table",
			target: "users",
			ifExists: false
		});
		expect(q).toEqual({
			engine: "mongodb",
			kind: "mongo-ddl",
			operation: "drop-collection",
			collection: "users",
			ifExists: false
		});
	});

	it("drop-collection if exists (D3 catch NamespaceNotFound 26)", () => {
		expect(
			mapDropTable({
				op: "ddl",
				kind: "drop-table",
				target: "users",
				ifExists: true
			}).ifExists
		).toBe(true);
	});

	it("drop-column minimal (compensation collMod + $unset batched)", () => {
		const q = mapDropCol({
			op: "ddl",
			kind: "drop-column",
			target: "users",
			column: "age",
			ifExists: false
		});
		expect(q).toEqual({
			engine: "mongodb",
			kind: "mongo-ddl",
			operation: "drop-column",
			collection: "users",
			column: "age",
			ifExists: false
		});
	});

	it("drop-column if exists (D3 skip si property absente du validator)", () => {
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

describe("codegen Mongo — create enum (ADR-030 Enum/1.6)", () => {
	function mapEnum(plan: CreateEnumPlan): MongoDDLCreateEnumQuery {
		if (mongoMapper.mapDDL === undefined) throw new Error("mapDDL manquant");
		const q = mongoMapper.mapDDL(plan);
		if (q.kind !== "mongo-ddl" || q.operation !== "create-enum") {
			throw new Error(`attendu mongo-ddl create-enum, got ${q.kind}`);
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
			engine: "mongodb",
			kind: "mongo-ddl",
			operation: "create-enum",
			name: "role_type",
			members: ["user", "admin"],
			ifNotExists: false
		});
	});

	it("propage ifNotExists (adapter catch DuplicateKey 11000)", () => {
		expect(
			mapEnum({
				op: "ddl",
				kind: "create-enum",
				name: "status",
				members: ["a"],
				ifNotExists: true
			}).ifNotExists
		).toBe(true);
	});
});

describe("codegen Mongo — enum type dans create table + add column (Enum/2.6)", () => {
	it("create table field enum → property `{bsonType: string, enum: [...]}`", () => {
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
		const validator = q.validator as { $jsonSchema: { properties: Record<string, unknown> } };
		expect(validator.$jsonSchema.properties.role).toEqual({
			bsonType: "string",
			enum: ["user", "admin"]
		});
	});

	it("add column enum → column.enum snapshot propagé", () => {
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
			bsonType: "string",
			enum: ["free", "pro"]
		});
	});
});

describe("codegen Mongo — add enum member (ADR-030 Enum/3.5)", () => {
	function mapAddMember(plan: AddEnumMemberPlan): MongoDDLAddEnumMemberQuery {
		if (mongoMapper.mapDDL === undefined) throw new Error("mapDDL manquant");
		const q = mongoMapper.mapDDL(plan);
		if (q.kind !== "mongo-ddl" || q.operation !== "add-enum-member") {
			throw new Error(`attendu mongo-ddl add-enum-member, got ${q.kind}`);
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
			engine: "mongodb",
			kind: "mongo-ddl",
			operation: "add-enum-member",
			name: "role_type",
			member: "guest",
			ifNotExists: false
		});
	});

	it("propage ifNotExists", () => {
		expect(
			mapAddMember({
				op: "ddl",
				kind: "add-enum-member",
				name: "s",
				member: "m",
				ifNotExists: true
			}).ifNotExists
		).toBe(true);
	});
});

describe("codegen Mongo — drop enum (ADR-030 Enum/3.5 D8)", () => {
	function mapDropEnum(plan: DropEnumPlan): MongoDDLDropEnumQuery {
		if (mongoMapper.mapDDL === undefined) throw new Error("mapDDL manquant");
		const q = mongoMapper.mapDDL(plan);
		if (q.kind !== "mongo-ddl" || q.operation !== "drop-enum") {
			throw new Error(`attendu mongo-ddl drop-enum, got ${q.kind}`);
		}
		return q;
	}

	it("émet shape drop-enum RESTRICT + ifExists=false par défaut", () => {
		expect(
			mapDropEnum({
				op: "ddl",
				kind: "drop-enum",
				name: "role_type",
				ifExists: false,
				cascade: false
			})
		).toEqual({
			engine: "mongodb",
			kind: "mongo-ddl",
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
			name: "s",
			ifExists: true,
			cascade: true
		});
		expect(q.ifExists).toBe(true);
		expect(q.cascade).toBe(true);
	});
});

describe("codegen Mongo — ref FK modifier (ADR-031 FK/1a)", () => {
	it("create table avec ref → refs[] snapshot _snql_refs", () => {
		const q = mapCreate({
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
		expect(q.refs).toEqual([
			{
				name: "fk_orders_user_id_users",
				fromCollection: "orders",
				fromColumn: "user_id",
				toCollection: "users",
				toColumn: "id",
				onDelete: "cascade",
				onUpdate: "restrict"
			}
		]);
	});

	it("add column avec ref → column.ref snapshot", () => {
		const q = mapAdd({
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
		expect(q.column.ref).toMatchObject({
			name: "fk_posts_author_id_users",
			fromCollection: "posts",
			toCollection: "users",
			onDelete: "restrict"
		});
	});
});
