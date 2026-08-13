/**
 * Snapshots BSON Mongo pour les 4 fonctions JSON sprint 4 + hoist
 * indexable-natif dans renderCompare/negateCompare/isNull + fallback $expr
 * pour json_get_text + write predicate refusé si non-hoistable.
 */

import { describe, expect, it } from "vitest";
import { SnqlError } from "../diagnostics";
import { compile, getMapper, lowerMutation, parse, tokenize } from "../index";

function mongo(source: string): {
	collection: string;
	pipeline: readonly Record<string, unknown>[];
} {
	const { native } = compile(source, { engine: "mongodb" });
	if (native.kind !== "mongo") throw new Error("kind mongo attendu");
	return { collection: native.collection, pipeline: native.pipeline };
}

function mongoMutation(source: string) {
	const stmt = parse(tokenize(source));
	if (stmt.operation === "select") throw new Error("mutation attendue");
	return getMapper("mongodb").mapMutation(lowerMutation(stmt));
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

describe("Mongo json_get — projection $let/$ifNull/$getField chain", () => {
	it('json_get(meta, "role") single key', () => {
		const { pipeline } = mongo('find t pick json_get(meta, "role") as r');
		expect(pipeline[0]).toEqual({
			$project: {
				r: {
					$ifNull: [
						{
							$getField: {
								field: "role",
								input: { $ifNull: ["$meta", null] }
							}
						},
						null
					]
				},
				_id: 0
			}
		});
	});

	it("json_get nested string+int → $cond wrap sur segment array", () => {
		const { pipeline } = mongo(
			'find t pick json_get(meta, "items", 0, "name") as n'
		);
		const bson = JSON.stringify(pipeline[0]);
		expect(bson).toContain("$getField");
		expect(bson).toContain("$arrayElemAt");
		expect(bson).toContain("$cond");
		expect(bson).toContain('"array"'); // check $type='array' pour parité PG NULL
	});
});

describe("Mongo json_get_text — $cond AVANT $toString", () => {
	it("json_get_text single hop → $let $cond $toString", () => {
		const { pipeline } = mongo('find t pick json_get_text(meta, "a") as x');
		const serialized = JSON.stringify(pipeline[0]);
		expect(serialized).toContain("$toString");
		expect(serialized).toContain("$cond");
		// $cond doit précéder $toString dans la sérialisation (car $let$vars puis $cond in)
		const condIdx = serialized.indexOf("$cond");
		const toStringIdx = serialized.indexOf("$toString");
		expect(condIdx).toBeLessThan(toStringIdx);
	});
});

describe("Mongo json_has_key — $type != missing avec $ifNull wrap doc", () => {
	it('json_has_key(meta, "k")', () => {
		const { pipeline } = mongo('find t pick json_has_key(meta, "k") as h');
		expect(pipeline[0]).toEqual({
			$project: {
				h: {
					$ne: [
						{
							$type: {
								$getField: {
									field: "k",
									input: { $ifNull: ["$meta", {}] }
								}
							}
						},
						"missing"
					]
				},
				_id: 0
			}
		});
	});
});

describe("Mongo json_typeof — $switch avec remap BSON→JSON", () => {
	it("json_typeof(meta) génère $switch multi-branches", () => {
		const { pipeline } = mongo("find t pick json_typeof(meta) as t");
		const bson = JSON.stringify(pipeline[0]);
		expect(bson).toContain("$switch");
		expect(bson).toContain("branches");
		// Vérifie le remap number pour {int, long, double, decimal}.
		expect(bson).toContain('"number"');
		expect(bson).toContain('"long"');
		expect(bson).toContain('"double"');
		expect(bson).toContain('"decimal"');
		// ObjectId/Date/Timestamp remappés → 'string' (approximation cohérente drivers).
		expect(bson).toContain('"objectId"');
	});
});

describe("Mongo HOIST — json_get compare = literal → dot notation indexable", () => {
	it("where json_get(meta, 'role') = 'admin' → {'meta.role': 'admin'}", () => {
		const { pipeline } = mongo(
			'find t where json_get(meta, "role") = "admin"'
		);
		expect(pipeline[0]).toEqual({
			$match: { "meta.role": { $eq: "admin" } }
		});
	});

	it("where json_get nested path → dot notation chain", () => {
		const { pipeline } = mongo(
			'find t where json_get(meta, "profile", "role") = "admin"'
		);
		expect(pipeline[0]).toEqual({
			$match: { "meta.profile.role": { $eq: "admin" } }
		});
	});

	it("where json_get avec index array → dot notation avec index", () => {
		const { pipeline } = mongo(
			'find t where json_get(meta, "tags", 0) = "vip"'
		);
		expect(pipeline[0]).toEqual({
			$match: { "meta.tags.0": { $eq: "vip" } }
		});
	});

	it("json_get_text PAS de hoist v1 (coercion type sans schema) → $expr fallback", () => {
		const { pipeline } = mongo(
			'find t where json_get_text(meta, "role") = "admin"'
		);
		const bson = JSON.stringify(pipeline[0]);
		expect(bson).toContain("$expr");
		expect(bson).not.toContain('"meta.role":');
	});
});

describe("Mongo HOIST — json_has_key → $exists indexable", () => {
	it("where json_has_key(meta, 'k') = true → {'meta.k': {$exists: true}}", () => {
		const { pipeline } = mongo(
			'find t where json_has_key(meta, "k") = true'
		);
		expect(pipeline[0]).toEqual({
			$match: { "meta.k": { $exists: true } }
		});
	});

	it("where json_has_key(meta, 'k') = false → {'meta.k': {$exists: false}}", () => {
		const { pipeline } = mongo(
			'find t where json_has_key(meta, "k") = false'
		);
		expect(pipeline[0]).toEqual({
			$match: { "meta.k": { $exists: false } }
		});
	});

	it("where json_has_key(meta, 'k') != true → $exists inversé (ne swap sens)", () => {
		const { pipeline } = mongo(
			'find t where json_has_key(meta, "k") != true'
		);
		expect(pipeline[0]).toEqual({
			$match: { "meta.k": { $exists: false } }
		});
	});
});

describe("Mongo isNull hoist sur json_get", () => {
	it("where json_get(meta, 'k') is null → {'meta.k': {$exists: false}}", () => {
		const { pipeline } = mongo('find t where json_get(meta, "k") = null');
		expect(pipeline[0]).toEqual({
			$match: { "meta.k": { $exists: false } }
		});
	});

	it("where json_get(meta, 'k') != null → {'meta.k': {$exists: true}}", () => {
		const { pipeline } = mongo('find t where json_get(meta, "k") != null');
		expect(pipeline[0]).toEqual({
			$match: { "meta.k": { $exists: true } }
		});
	});
});

describe("Mongo write hoist JSON — indexable natif OK", () => {
	it("update where json_has_key(meta, 'k') = true : hoist $exists autorisé en write", () => {
		const nat = mongoMutation(
			'update t where json_has_key(meta, "archived") = true set y = 1'
		);
		if (nat.kind !== "mongo-write") throw new Error("mongo-write attendu");
		const serialized = JSON.stringify(nat);
		expect(serialized).toContain("$exists");
		expect(serialized).toContain("meta.archived");
	});

	it("remove where json_get(meta, 'role') = 'guest' : hoist value OK", () => {
		const nat = mongoMutation('remove from t where json_get(meta, "role") = "guest"');
		if (nat.kind !== "mongo-write") throw new Error("mongo-write attendu");
		const serialized = JSON.stringify(nat);
		expect(serialized).toContain('"meta.role"');
	});

	it("update where json_get_text(meta, 'k') = 'v' → codegen_mongo_write_expr_predicate (fallback non hoistable)", () => {
		expectCode(
			() =>
				mongoMutation(
					'update t where json_get_text(meta, "role") = "guest" set y = 1'
				),
			"codegen_mongo_write_expr_predicate"
		);
	});
});
