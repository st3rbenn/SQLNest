/**
 * Sprint v3 Mongo — Upsert natif Mongo via bulkWrite updateOne+upsert:true.
 *
 * Couvre :
 *  - codegen : `add {…} on conflict (k) ignore` → op=upsert, ops[i] avec
 *    filter+setOnInsert (pas de $set)
 *  - codegen : `add {…} on conflict (k) edit set c = new.c` → op=upsert avec
 *    $set (subst upsertNew) + $setOnInsert (les autres cols)
 *  - refus : action.where (v2), sourcePlan (v4), expr composite dans $set
 *  - capability : MONGODB_CAPABILITIES.supports('upsert') = true
 *
 * L'E2E réseau (bulkWrite réel sur Mongo) est validé côté user via CLI E2E.
 */

import { describe, expect, it } from "vitest";
import { SnqlError } from "./diagnostics";
import {
	assertMutationUpsertSupported,
	getMapper,
	lowerMutation,
	MONGODB_CAPABILITIES,
	parse,
	tokenize
} from "./index";
import type { MongoWriteQuery } from "./codegen/mapper";
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
				{ name: "display_name", type: "string", nullable: true, source: "declared" },
				{ name: "is_active", type: "bool", nullable: false, source: "declared" }
			]
		}
	],
	relations: []
};

function mongoUpsert(source: string): Extract<MongoWriteQuery, { op: "upsert" }> {
	const stmt = parse(tokenize(source));
	if (stmt.operation !== "insert") throw new Error("insert attendu");
	const mutation = lowerMutation(stmt, SCHEMA);
	const mapper = getMapper("mongodb");
	const native = mapper.mapMutation(mutation);
	if (native.kind !== "mongo-write" || native.op !== "upsert") {
		throw new Error(`op attendu 'upsert', reçu '${native.kind}/${(native as { op?: string }).op}'`);
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

describe("planner — 'upsert' capability sur MONGODB", () => {
	it("MONGODB_CAPABILITIES contient 'upsert'", () => {
		expect(MONGODB_CAPABILITIES.supports.has("upsert")).toBe(true);
	});

	it("assertMutationUpsertSupported accepte Mongo", () => {
		const stmt = parse(
			tokenize(`add {_id: 1, email: "a@e.com", is_active: true} into users on conflict (_id) ignore`)
		);
		if (stmt.operation !== "insert") throw new Error();
		const mutation = lowerMutation(stmt, SCHEMA);
		expect(() =>
			assertMutationUpsertSupported(mutation, MONGODB_CAPABILITIES)
		).not.toThrow();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Codegen — action ignore
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen Mongo — on conflict ignore", () => {
	it("1 row → 1 op avec filter + setOnInsert, pas de $set", () => {
		const q = mongoUpsert(
			`add {_id: 1, email: "a@e.com", is_active: true} into users on conflict (_id) ignore`
		);
		expect(q.operations).toHaveLength(1);
		const op = q.operations[0]!;
		expect(op.filter).toEqual({ _id: 1 });
		expect(op.set).toBeUndefined();
		expect(op.setOnInsert).toEqual({
			_id: 1,
			email: "a@e.com",
			is_active: true
		});
	});

	it("2 rows → 2 ops indépendantes (chacune ses valeurs)", () => {
		const q = mongoUpsert(
			`add [{_id: 1, email: "a@e.com", is_active: true}, {_id: 2, email: "b@e.com", is_active: false}] into users on conflict (_id) ignore`
		);
		expect(q.operations).toHaveLength(2);
		expect(q.operations[0]?.filter).toEqual({ _id: 1 });
		expect(q.operations[1]?.filter).toEqual({ _id: 2 });
		expect(q.operations[0]?.setOnInsert).toMatchObject({ email: "a@e.com" });
		expect(q.operations[1]?.setOnInsert).toMatchObject({ email: "b@e.com" });
	});

	it("conflict target multi-cols → filter multi-clés", () => {
		const q = mongoUpsert(
			`add {_id: 42, email: "x@e.com", is_active: true} into users on conflict (_id, email) ignore`
		);
		expect(q.operations[0]?.filter).toEqual({ _id: 42, email: "x@e.com" });
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Codegen — action edit set
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen Mongo — on conflict edit set", () => {
	it("edit set literal → $set inline, $setOnInsert = le reste", () => {
		const q = mongoUpsert(
			`add {_id: 1, email: "a@e.com", is_active: false} into users on conflict (_id) edit set is_active = true`
		);
		const op = q.operations[0]!;
		expect(op.filter).toEqual({ _id: 1 });
		expect(op.set).toEqual({ is_active: true });
		// _id + email restent en $setOnInsert ; is_active a été poussé en $set.
		expect(op.setOnInsert).toEqual({ _id: 1, email: "a@e.com" });
	});

	it("edit set new.<col> → substitué par la valeur de la row", () => {
		const q = mongoUpsert(
			`add {_id: 1, email: "new@e.com", is_active: true} into users on conflict (_id) edit set email = new.email`
		);
		const op = q.operations[0]!;
		expect(op.set).toEqual({ email: "new@e.com" });
		expect(op.setOnInsert).toEqual({ _id: 1, is_active: true });
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Refus v1
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen Mongo — refus v1", () => {
	it("action.where refusée", () => {
		expectCode(
			() =>
				mongoUpsert(
					`add {_id: 1, email: "a", is_active: true} into users on conflict (_id) edit set is_active = true where email != "spam@e.com"`
				),
			"codegen_mongo_upsert_action_where"
		);
	});

	it("expression composite dans $set refusée (v1 : literal/new.<col> uniquement)", () => {
		// `new.email` seul serait accepté ; `new.email` concat autre chose (call) est refusé.
		expectCode(
			() =>
				mongoUpsert(
					`add {_id: 1, email: "a@e.com", is_active: true} into users on conflict (_id) edit set email = upper(new.email)`
				),
			"codegen_mongo_upsert_edit_composite"
		);
	});
});
