/**
 * ADR-024 PM/4 — Sibling parité Mongo pour write-join. Mirror de
 * mutation-join-t214-e2e.test.ts (oracle PG utilise `UPDATE ... FROM`).
 * Mongo compile via aggregate + $merge natif (Q4a).
 *
 * Pipeline attendu :
 *   [$match?, $lookup, $unwind, $set, $unset(alias), $merge into:self]
 *
 * L'exécution runtime (bulkWrite atomique par-doc) est couverte par
 * mutation-join adapter.int.test.ts et parity-matrix.e2e.test.ts (PM/9).
 * Ce fichier vérifie uniquement le SHAPE du pipeline codegen.
 */

import { describe, expect, it } from "vitest";
import { mongoWrite } from "./index";

describe("PM/4 — write-join Mongo pipeline shape", () => {
	it("update simple avec one join → pipeline aggregate+$merge", () => {
		const write = mongoWrite(
			"update orders with one users as u on user_id = u.id set discount = 0.1"
		);
		expect(write.kind).toBe("mongo-write");
		expect(write.op).toBe("update-agg-merge");
		if (write.op !== "update-agg-merge") throw new Error();
		expect(write.collection).toBe("orders");
		const pipeline = write.pipeline;
		// $lookup + $unwind + $set + $unset + $merge (aucun $match sans predicate)
		expect(pipeline).toHaveLength(5);
		expect(pipeline[0]).toEqual({
			$lookup: {
				from: "users",
				localField: "user_id",
				foreignField: "id",
				as: "u"
			}
		});
		expect(pipeline[1]).toEqual({
			$unwind: { path: "$u", preserveNullAndEmptyArrays: false }
		});
		// 0.1 est un decimal exact — marqueur SqlDecimal hydraté en Decimal128
		// par l'adapter (pattern homogène avec les autres codegen mongo).
		expect(pipeline[2]).toEqual({
			$set: { discount: { kind: "decimal", raw: "0.1" } }
		});
		expect(pipeline[3]).toEqual({ $unset: ["u"] });
		expect(pipeline[4]).toEqual({
			$merge: {
				into: "orders",
				whenMatched: "merge",
				whenNotMatched: "discard"
			}
		});
	});

	it("update avec predicate → $match en tête pour indexation", () => {
		const write = mongoWrite(
			'update orders with one users as u on user_id = u.id where u.premium = true set discount = 0.1'
		);
		if (write.op !== "update-agg-merge") throw new Error();
		const pipeline = write.pipeline;
		expect(pipeline).toHaveLength(6);
		// $match d'abord (indexé), puis $lookup+$unwind, puis $set, $unset, $merge.
		expect(pipeline[0]).toHaveProperty("$match");
		expect(pipeline[1]).toHaveProperty("$lookup");
	});

	it("set reference alias join → $ifNull wrapper", () => {
		const write = mongoWrite(
			"update orders with one users as u on user_id = u.id set discount = u.premium_rate"
		);
		if (write.op !== "update-agg-merge") throw new Error();
		const setStage = write.pipeline.find(
			(s) => "$set" in s
		) as { $set: Record<string, unknown> };
		// Field ref → $ifNull [operand, null] pour parité PG NULL semantics.
		expect(setStage.$set.discount).toEqual({
			$ifNull: ["$u.premium_rate", null]
		});
	});

	it("multi-joins accumulés (with one X … and one Y)", () => {
		const write = mongoWrite(
			"update orders with one users as u on user_id = u.id and one products as p on product_id = p.id set discount = 0.1"
		);
		if (write.op !== "update-agg-merge") throw new Error();
		const pipeline = write.pipeline;
		// 2 joins → 2× ($lookup+$unwind) = 4 stages, plus $set+$unset+$merge = 7
		expect(pipeline).toHaveLength(7);
		expect(pipeline[0]).toHaveProperty("$lookup");
		expect(pipeline[1]).toHaveProperty("$unwind");
		expect(pipeline[2]).toHaveProperty("$lookup");
		expect(pipeline[3]).toHaveProperty("$unwind");
		expect(pipeline[5]).toEqual({ $unset: ["u", "p"] });
	});

	it("$merge into:self (never accidental insert)", () => {
		const write = mongoWrite(
			"update orders with one users as u on user_id = u.id set discount = 0.1"
		);
		if (write.op !== "update-agg-merge") throw new Error();
		const mergeStage = write.pipeline.find(
			(s) => "$merge" in s
		) as { $merge: { into: string; whenMatched: string; whenNotMatched: string } };
		expect(mergeStage.$merge.into).toBe("orders");
		expect(mergeStage.$merge.whenMatched).toBe("merge");
		expect(mergeStage.$merge.whenNotMatched).toBe("discard");
	});
});
