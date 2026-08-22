/**
 * Sprint TxMongo — Transaction native Mongo (replica set côté serveur).
 *
 * Couvre :
 *  - codegen : mapTransaction → MongoTransaction avec steps typés
 *  - refus   : savepoint (non simulable sans re-jeu dangereux)
 *  - capability : MONGODB_CAPABILITIES a 'transaction' (accepté au planner)
 *  - isolation : propagée sur le native pour mapping ultérieur adapter-side
 *
 * L'E2E réseau (startTransaction/commit/abort réel avec un mongod en RS) est
 * couvert par les integration tests engine (adapter.int.test.ts) — ici on
 * s'arrête au codegen (pur, hermétique).
 */

import { describe, expect, it } from "vitest";
import { SnqlError } from "./diagnostics";
import {
	assertTransactionSupported,
	getMapper,
	lowerTransaction,
	MONGODB_CAPABILITIES,
	parse,
	tokenize
} from "./index";
import type { MongoTransaction, MongoTransactionStep } from "./codegen/mapper";
import type { SchemaModel } from "./schema/model";

const SCHEMA: SchemaModel = {
	engine: "mongodb",
	collections: [
		{
			name: "users",
			source: "declared",
			primaryKey: ["_id"],
			fields: [
				{ name: "_id", type: "bigint", nullable: false, source: "declared" },
				{ name: "email", type: "string", nullable: false, source: "declared" },
				{ name: "is_active", type: "bool", nullable: false, source: "declared" }
			]
		},
		{
			name: "orders",
			source: "declared",
			primaryKey: ["_id"],
			fields: [
				{ name: "_id", type: "bigint", nullable: false, source: "declared" },
				{ name: "user_id", type: "bigint", nullable: false, source: "declared" },
				{ name: "total_cents", type: "int", nullable: false, source: "declared" }
			]
		}
	],
	relations: []
};

function mongoTx(source: string): MongoTransaction {
	const stmt = parse(tokenize(source));
	if (stmt.operation !== "transaction") throw new Error("transaction attendue");
	const planned = lowerTransaction(stmt, SCHEMA);
	const mapper = getMapper("mongodb");
	if (mapper.mapTransaction === undefined) throw new Error("no mapTransaction");
	const native = mapper.mapTransaction(planned);
	if (native.kind !== "mongo-transaction") {
		throw new Error(`kind attendu 'mongo-transaction', reçu '${native.kind}'`);
	}
	return native;
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
// Capability
// ═══════════════════════════════════════════════════════════════════════════

describe("planner — 'transaction' capability sur MONGODB", () => {
	it("MONGODB_CAPABILITIES.supports contient 'transaction'", () => {
		expect(MONGODB_CAPABILITIES.supports.has("transaction")).toBe(true);
	});

	it("assertTransactionSupported accepte Mongo (RS côté serveur)", () => {
		const stmt = parse(tokenize("transaction { find users pick _id }"));
		if (stmt.operation !== "transaction") throw new Error();
		const planned = lowerTransaction(stmt, SCHEMA);
		expect(() =>
			assertTransactionSupported(planned, MONGODB_CAPABILITIES)
		).not.toThrow();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Codegen mapTransaction
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen — mapTransaction Mongo", () => {
	it("read step → { kind: 'query', query: MongoQuery }", () => {
		const tx = mongoTx("transaction { find users pick _id, email }");
		expect(tx.steps).toHaveLength(1);
		const step = tx.steps[0] as Extract<MongoTransactionStep, { kind: "query" }>;
		expect(step.kind).toBe("query");
		expect(step.query.kind).toBe("mongo");
		expect(step.query.collection).toBe("users");
		expect(Array.isArray(step.query.pipeline)).toBe(true);
	});

	it("write step insert → { kind: 'write', write: MongoWriteQuery }", () => {
		const tx = mongoTx(
			`transaction { add {_id: 42, email: "x@e.com", is_active: true} into users }`
		);
		expect(tx.steps).toHaveLength(1);
		const step = tx.steps[0] as Extract<MongoTransactionStep, { kind: "write" }>;
		expect(step.kind).toBe("write");
		expect(step.write.kind).toBe("mongo-write");
		expect(step.write.op).toBe("insert");
		expect(step.write.collection).toBe("users");
	});

	it("séquence read + write : préservée en steps ordonnés", () => {
		const tx = mongoTx(
			`transaction { find users pick _id; update users where _id = 1 set is_active = false }`
		);
		expect(tx.steps).toHaveLength(2);
		expect(tx.steps[0]?.kind).toBe("query");
		expect(tx.steps[1]?.kind).toBe("write");
		const wr = tx.steps[1] as Extract<MongoTransactionStep, { kind: "write" }>;
		expect(wr.write.op).toBe("update");
	});

	it("isolation 'serializable' propagée sur le native", () => {
		const tx = mongoTx(
			`transaction isolation serializable { find users pick _id }`
		);
		expect(tx.isolation).toBe("serializable");
	});

	it("isolation 'repeatable read' propagée", () => {
		const tx = mongoTx(
			`transaction isolation repeatable read { find users pick _id }`
		);
		expect(tx.isolation).toBe("repeatable_read");
	});

	it("isolation 'read committed' propagée", () => {
		const tx = mongoTx(
			`transaction isolation read committed { find users pick _id }`
		);
		expect(tx.isolation).toBe("read_committed");
	});

	it("kind du native = 'mongo-transaction' (dispatch adapter sur ce discriminant)", () => {
		const tx = mongoTx(`transaction { find users pick _id }`);
		expect(tx.kind).toBe("mongo-transaction");
		expect(tx.engine).toBe("mongodb");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Refus explicit
// ═══════════════════════════════════════════════════════════════════════════

describe("savepoint Mongo accepté via compensation logique in-session", () => {
	it("savepoint simple accepté au planner (walker assertSavepointLiftable)", () => {
		const stmt = parse(
			tokenize(`transaction { savepoint sp1 { find users pick _id } }`)
		);
		if (stmt.operation !== "transaction") throw new Error();
		const planned = lowerTransaction(stmt);
		expect(() =>
			assertTransactionSupported(planned, MONGODB_CAPABILITIES)
		).not.toThrow();
	});

	it("savepoint mixé avec read/write accepté (writes analysables MVP)", () => {
		const stmt = parse(
			tokenize(
				`transaction { find users pick _id; savepoint sp1 { update users where _id = 1 set is_active = false } }`
			)
		);
		if (stmt.operation !== "transaction") throw new Error();
		const planned = lowerTransaction(stmt);
		expect(() =>
			assertTransactionSupported(planned, MONGODB_CAPABILITIES)
		).not.toThrow();
	});

	it("codegen préserve savepoint comme step dédié (plus flatten)", () => {
		const tx = mongoTx(
			`transaction { savepoint sp1 { update users where _id = 1 set is_active = false } }`
		);
		expect(tx.steps).toHaveLength(1);
		const step = tx.steps[0] as Extract<
			MongoTransactionStep,
			{ kind: "savepoint" }
		>;
		expect(step.kind).toBe("savepoint");
		expect(step.name).toBe("sp1");
		expect(step.body).toHaveLength(1);
		expect(step.body[0]?.kind).toBe("write");
	});

	it("savepoint nested → refus planner_savepoint_nested_v3", () => {
		const stmt = parse(
			tokenize(
				`transaction { savepoint sp1 { savepoint sp2 { find users pick _id } } }`
			)
		);
		if (stmt.operation !== "transaction") throw new Error();
		const planned = lowerTransaction(stmt);
		expectCode(
			() => assertTransactionSupported(planned, MONGODB_CAPABILITIES),
			"planner_savepoint_nested_v3"
		);
	});

	it("savepoint body avec write-join → refus planner_savepoint_body_write_join_v3", () => {
		const stmt = parse(
			tokenize(
				`transaction { savepoint sp1 { update users with one orders as o on _id = o.user_id set is_active = false } }`
			)
		);
		if (stmt.operation !== "transaction") throw new Error();
		const planned = lowerTransaction(stmt);
		expectCode(
			() => assertTransactionSupported(planned, MONGODB_CAPABILITIES),
			"planner_savepoint_body_write_join_v3"
		);
	});

	it("savepoint body avec insert-select → refus planner_savepoint_body_insert_select_v3", () => {
		const stmt = parse(
			tokenize(
				`transaction { savepoint sp1 { add (find users pick _id) into orders } }`
			)
		);
		if (stmt.operation !== "transaction") throw new Error();
		const planned = lowerTransaction(stmt);
		expectCode(
			() => assertTransactionSupported(planned, MONGODB_CAPABILITIES),
			"planner_savepoint_body_insert_select_v3"
		);
	});
});
