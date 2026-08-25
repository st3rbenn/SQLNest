/**
 * E2E DDL Tier-2 cross-engine (ADR-029 DDL/1). Pipeline complet :
 * tokenize → parse → lowerDDL → mapDDL (PG / Mongo / KV).
 * Balaie D0 (body inline), D1 (types portables round-trip), D3 (if not exists
 * cross-engine), D6 (aliases PG paste-friendly), D13 (primary key sémantique).
 */

import { describe, expect, it } from "vitest";
import type {
	AddColumnPlan,
	CreateTablePlan,
	DDLStatement,
	KvDDLAddColumnQuery,
	KvDDLCreateTableQuery,
	MongoDDLAddColumnQuery,
	MongoDDLCreateCollectionQuery
} from "./index";
import {
	lowerDDL,
	mapKvDDL,
	mongoMapper,
	parse,
	postgresMapper,
	tokenize
} from "./index";

function lowerCreate(source: string): CreateTablePlan {
	const stmt = parse(tokenize(source)) as DDLStatement;
	const plan = lowerDDL(stmt);
	if (plan.kind !== "create-table") {
		throw new Error(`expected create-table plan, got ${plan.kind}`);
	}
	return plan;
}

function lowerAdd(source: string): AddColumnPlan {
	const stmt = parse(tokenize(source)) as DDLStatement;
	const plan = lowerDDL(stmt);
	if (plan.kind !== "add-column") {
		throw new Error(`expected add-column plan, got ${plan.kind}`);
	}
	return plan;
}

function pg(source: string) {
	if (postgresMapper.mapDDL === undefined) throw new Error("postgresMapper.mapDDL manquant");
	const plan = parse(tokenize(source)) as DDLStatement;
	return postgresMapper.mapDDL(lowerDDL(plan));
}

function mongoCreate(source: string): MongoDDLCreateCollectionQuery {
	if (mongoMapper.mapDDL === undefined) throw new Error("mongoMapper.mapDDL manquant");
	const q = mongoMapper.mapDDL(lowerCreate(source));
	if (q.kind !== "mongo-ddl" || q.operation !== "create-collection") {
		throw new Error(`attendu mongo-ddl create-collection, got ${q.kind}`);
	}
	return q;
}

function mongoAdd(source: string): MongoDDLAddColumnQuery {
	if (mongoMapper.mapDDL === undefined) throw new Error("mongoMapper.mapDDL manquant");
	const q = mongoMapper.mapDDL(lowerAdd(source));
	if (q.kind !== "mongo-ddl" || q.operation !== "add-column") {
		throw new Error(`attendu mongo-ddl add-column, got ${q.kind}`);
	}
	return q;
}

/** legacy alias — les tests DDL/1 utilisaient `mongo(source)` sans narrow. */
function mongo(source: string): MongoDDLCreateCollectionQuery {
	return mongoCreate(source);
}

function kvCreate(source: string): KvDDLCreateTableQuery {
	const q = mapKvDDL(lowerCreate(source));
	if (q.operation !== "create-table") {
		throw new Error(`attendu kv-ddl create-table, got ${q.operation}`);
	}
	return q;
}

function kvAdd(source: string): KvDDLAddColumnQuery {
	const q = mapKvDDL(lowerAdd(source));
	if (q.operation !== "add-column") {
		throw new Error(`attendu kv-ddl add-column, got ${q.operation}`);
	}
	return q;
}

/** legacy alias. */
function kv(source: string): KvDDLCreateTableQuery {
	return kvCreate(source);
}

describe("DDL/1 E2E — pipeline complet cross-engine (ADR-029)", () => {
	describe("D0 body inline + D1 types portables", () => {
		const source = "create table users { id: uuid, email: text, age: int nullable }";

		it("PG : CREATE TABLE avec types PG_DDL_TYPE", () => {
			const q = pg(source);
			if (q.kind !== "sql") throw new Error("attendu sql");
			expect(q.text).toBe(
				`CREATE TABLE "users" ("id" uuid NOT NULL, "email" text NOT NULL, "age" integer)`
			);
		});

		it("Mongo : validator $jsonSchema avec bsonType + required", () => {
			const q = mongo(source);
			expect(q.validator).toEqual({
				$jsonSchema: {
					bsonType: "object",
					properties: {
						id: { bsonType: "binData" },
						email: { bsonType: "string" },
						age: { bsonType: "int" }
					},
					required: ["id", "email"]
				}
			});
		});

		it("KV : fields descriptors 1:1", () => {
			const q = kv(source);
			expect(q.fields).toEqual([
				{ name: "id", type: "uuid", nullable: false, unique: false },
				{ name: "email", type: "string", nullable: false, unique: false },
				{ name: "age", type: "int", nullable: true, unique: false }
			]);
		});
	});

	describe("D6 alias PG paste-friendly (varchar/jsonb/timestamptz/bigserial/int8/boolean)", () => {
		const source = `create table t {
			a: varchar,
			b: jsonb,
			c: timestamptz,
			d: bigserial,
			e: int8,
			f: boolean
		}`;

		it("PG : normalisés vers text/jsonb/timestamptz/bigint/bigint/boolean", () => {
			const q = pg(source);
			if (q.kind !== "sql") throw new Error("attendu sql");
			expect(q.text).toBe(
				`CREATE TABLE "t" ("a" text NOT NULL, "b" jsonb NOT NULL, "c" timestamptz NOT NULL, "d" bigint NOT NULL, "e" bigint NOT NULL, "f" boolean NOT NULL)`
			);
		});

		it("Mongo : normalisés vers string/object/date/long/long/bool", () => {
			const q = mongo(source);
			const props = (
				(q.validator as { $jsonSchema: { properties: Record<string, { bsonType: string }> } })
					.$jsonSchema.properties
			);
			expect(props.a?.bsonType).toBe("string");
			expect(props.b?.bsonType).toBe("object");
			expect(props.c?.bsonType).toBe("date");
			expect(props.d?.bsonType).toBe("long");
			expect(props.e?.bsonType).toBe("long");
			expect(props.f?.bsonType).toBe("bool");
		});

		it("KV : normalisés vers types canoniques SnqlType", () => {
			const q = kv(source);
			expect(q.fields.map((f) => f.type)).toEqual([
				"string",
				"json",
				"date",
				"bigint",
				"bigint",
				"bool"
			]);
		});
	});

	describe("D3 if not exists cross-engine (name-only sémantique)", () => {
		const source = "create table if not exists sessions { token: text }";

		it("PG : SqlTransaction 2-steps avec advisory_xact_lock", () => {
			const q = pg(source);
			expect(q.kind).toBe("transaction");
			if (q.kind !== "transaction") throw new Error("attendu transaction");
			expect(q.steps).toHaveLength(2);
			const first = q.steps[0];
			if (first?.kind !== "statement") throw new Error("attendu statement");
			expect(first.query.text).toContain("pg_advisory_xact_lock");
		});

		it("Mongo : ifNotExists=true propagé (adapter catch NamespaceExists 48)", () => {
			expect(mongo(source).ifNotExists).toBe(true);
		});

		it("KV : ifNotExists=true propagé (adapter existence-check `_schema` hash)", () => {
			expect(kv(source).ifNotExists).toBe(true);
		});
	});

	describe("D13 primary key single-id UUID cross-engine", () => {
		const source =
			"create table users { id: uuid, email: text, primary key (id) }";

		it("PG : PRIMARY KEY (id) natif", () => {
			const q = pg(source);
			if (q.kind !== "sql") throw new Error("attendu sql");
			expect(q.text).toContain(`PRIMARY KEY ("id")`);
		});

		it("Mongo : alias 'id' → _id (skip du validator)", () => {
			const q = mongo(source);
			expect(q.primaryKeyAlias).toBe("id");
			const schema = q.validator as { $jsonSchema: { properties: Record<string, unknown> } };
			expect(schema.$jsonSchema.properties).not.toHaveProperty("id");
		});

		it("KV : compensation via metadata (jamais refus)", () => {
			expect(kv(source).primaryKey).toEqual(["id"]);
		});
	});

	describe("D13 primary key compound (a, b) cross-engine", () => {
		const source =
			"create table pairs { a: uuid, b: uuid, primary key (a, b) }";

		it("PG : PRIMARY KEY (a, b) natif", () => {
			const q = pg(source);
			if (q.kind !== "sql") throw new Error("attendu sql");
			expect(q.text).toContain(`PRIMARY KEY ("a", "b")`);
		});

		it("Mongo : createIndex compound {unique:true} + _id auto conservé", () => {
			const q = mongo(source);
			expect(q.primaryKeyAlias).toBeUndefined();
			expect(q.indexes).toEqual([
				{ keys: { a: 1, b: 1 }, options: { unique: true, name: "pk_a_b" } }
			]);
		});

		it("KV : compensation via metadata (jamais refus)", () => {
			expect(kv(source).primaryKey).toEqual(["a", "b"]);
		});
	});

	describe("D13 refus sémantique admis Mongo — PK sur field ≠ 'id'", () => {
		const source =
			"create table users { email: text, primary key (email) }";

		it("PG : autorisé (PG accepte n'importe quel PK)", () => {
			const q = pg(source);
			if (q.kind !== "sql") throw new Error("attendu sql");
			expect(q.text).toContain(`PRIMARY KEY ("email")`);
		});

		it("Mongo : refus sémantique — hint vers 'add unique index'", () => {
			expect(() => mongo(source)).toThrow(/PK unique|add unique index/);
		});

		it("KV : compensation runtime (thèse doctrine — jamais refus gap engine)", () => {
			const q = kv(source);
			expect(q.primaryKey).toEqual(["email"]);
		});
	});

	describe("Round-trip type matrix (D1)", () => {
		it("chaque SnqlType a un mapping non-vide sur PG/Mongo/KV", () => {
			// Balaie tous les types canoniques déclarés dans SnqlType.
			const source = `create table matrix {
				s: string, i: int, bi: bigint, f: float, d: decimal,
				b: bool, dt: date, j: json, a: array, u: uuid,
				e: enum, un: unknown
			}`;
			const pgQ = pg(source);
			if (pgQ.kind !== "sql") throw new Error("attendu sql");
			// PG : chaque field a un type non-vide entre "col" TYPE
			for (const t of [
				"text",
				"integer",
				"bigint",
				"double precision",
				"numeric",
				"boolean",
				"timestamptz",
				"jsonb",
				"jsonb",
				"uuid",
				"text",
				"text"
			]) {
				expect(pgQ.text).toContain(t);
			}

			// Mongo : chaque type produit une entry propre dans properties.
			const mongoQ = mongo(source);
			const props = (
				(mongoQ.validator as { $jsonSchema: { properties: Record<string, unknown> } })
					.$jsonSchema.properties
			);
			expect(Object.keys(props)).toHaveLength(12);

			// KV : 1:1 identity — les 12 types passent inchangés.
			const kvQ = kv(source);
			expect(kvQ.fields).toHaveLength(12);
		});
	});

	describe("defaults literals cross-engine (D0)", () => {
		const source = `create table t {
			tier: text default "free",
			score: int default 42,
			active: bool default true,
			bio: text default null
		}`;

		it("PG : bindés $1..$N", () => {
			const q = pg(source);
			if (q.kind !== "sql") throw new Error("attendu sql");
			// PG DDL rejette les params bindés — defaults inline via pgInlineDefault.
			expect(q.text).toContain(`DEFAULT 'free'`);
			expect(q.text).toContain(`DEFAULT 42`);
			expect(q.text).toContain(`DEFAULT TRUE`);
			expect(q.text).toContain(`DEFAULT NULL`);
			expect(q.params).toEqual([]);
		});

		it("KV : sérialisés dans fields.defaultValue", () => {
			const q = kv(source);
			expect(q.fields.map((f) => f.defaultValue)).toEqual([
				"free",
				42,
				true,
				null
			]);
		});
	});
});

describe("DDL/2 E2E — add column cross-engine (ADR-029)", () => {
	describe("minimal add column + D1 types portables", () => {
		const source = "add column age int into users";

		it("PG : ALTER TABLE ADD COLUMN natif", () => {
			const q = pg(source);
			if (q.kind !== "sql") throw new Error("attendu sql");
			expect(q.text).toBe(
				`ALTER TABLE "users" ADD COLUMN "age" integer NOT NULL`
			);
		});

		it("Mongo : mongo-ddl add-column avec bsonType + required + preflightNotNull", () => {
			const q = mongoAdd(source);
			expect(q).toMatchObject({
				operation: "add-column",
				collection: "users",
				column: { name: "age", bsonType: "int", required: true },
				backfill: false,
				preflightNotNull: true
			});
		});

		it("KV : kv-ddl add-column avec descriptor 1:1 + preflightNotNull", () => {
			const q = kvAdd(source);
			expect(q).toMatchObject({
				operation: "add-column",
				collection: "users",
				column: { name: "age", type: "int", nullable: false, unique: false },
				backfill: false,
				preflightNotNull: true
			});
		});
	});

	describe("D10 backfill obligatoire cross-engine (default v)", () => {
		const source = 'add column tier text not null default "free" into users';

		it("PG : DEFAULT bindé $1 — backfill natif PG (metadata-trick PG 11+)", () => {
			const q = pg(source);
			if (q.kind !== "sql") throw new Error("attendu sql");
			expect(q.text).toBe(
				`ALTER TABLE "users" ADD COLUMN "tier" text NOT NULL DEFAULT 'free'`
			);
			expect(q.params).toEqual([]);
		});

		it("Mongo : backfill=true + defaultValue propagé au shape (adapter runtime updateMany batched)", () => {
			const q = mongoAdd(source);
			expect(q.backfill).toBe(true);
			expect(q.preflightNotNull).toBe(false);
			expect(q.column.defaultValue).toBe("free");
		});

		it("KV : backfill=true + defaultValue propagé (adapter runtime SCAN + HSET batched)", () => {
			const q = kvAdd(source);
			expect(q.backfill).toBe(true);
			expect(q.preflightNotNull).toBe(false);
			expect(q.column.defaultValue).toBe("free");
		});
	});

	describe("D2 preflight NOT NULL sans default", () => {
		const source = "add column handle text into users";

		it("PG : émet NOT NULL — PG remonte l'erreur si rows existent (attendu, comportement natif)", () => {
			const q = pg(source);
			if (q.kind !== "sql") throw new Error("attendu sql");
			expect(q.text).toContain(`NOT NULL`);
			expect(q.text).not.toContain(`DEFAULT`);
		});

		it("Mongo : preflightNotNull=true — adapter count $exists false + refus si > 0 (invariance sémantique)", () => {
			const q = mongoAdd(source);
			expect(q.preflightNotNull).toBe(true);
			expect(q.backfill).toBe(false);
		});

		it("KV : preflightNotNull=true — adapter SCAN + count sans field + refus si > 0", () => {
			const q = kvAdd(source);
			expect(q.preflightNotNull).toBe(true);
			expect(q.backfill).toBe(false);
		});
	});

	describe("D3 if not exists cross-engine (name-only sémantique)", () => {
		const source = "add column at date if not exists into users";

		it("PG : IF NOT EXISTS natif PG 9.6+", () => {
			const q = pg(source);
			if (q.kind !== "sql") throw new Error("attendu sql");
			expect(q.text).toContain(`ADD COLUMN IF NOT EXISTS`);
		});

		it("Mongo : ifNotExists propagé (adapter check field présent dans validator)", () => {
			expect(mongoAdd(source).ifNotExists).toBe(true);
		});

		it("KV : ifNotExists propagé (adapter HEXISTS namespace:_schema field)", () => {
			expect(kvAdd(source).ifNotExists).toBe(true);
		});
	});

	describe("D6 alias PG paste-friendly sur add column", () => {
		const source = "add column at timestamptz nullable into users";

		it("PG : timestamptz préservé", () => {
			const q = pg(source);
			if (q.kind !== "sql") throw new Error("attendu sql");
			expect(q.text).toContain(`"at" timestamptz`);
		});

		it("Mongo : timestamptz → bsonType date", () => {
			expect(mongoAdd(source).column.bsonType).toBe("date");
		});

		it("KV : timestamptz → type date (SnqlType canonique)", () => {
			expect(kvAdd(source).column.type).toBe("date");
		});
	});

	describe("unique field-level (index secondaire)", () => {
		const source = "add column email text nullable unique into users";

		it("PG : UNIQUE inline", () => {
			const q = pg(source);
			if (q.kind !== "sql") throw new Error("attendu sql");
			expect(q.text).toContain(`UNIQUE`);
		});

		it("Mongo : createIndex secondaire unique_<name>", () => {
			expect(mongoAdd(source).index).toEqual({
				keys: { email: 1 },
				options: { unique: true, name: "unique_email" }
			});
		});

		it("KV : column.unique=true (adapter enregistre pour middleware SETNX D12 futur)", () => {
			expect(kvAdd(source).column.unique).toBe(true);
		});
	});
});
