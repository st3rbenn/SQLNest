import { describe, expect, it } from "vitest";
import { SnqlError } from "../diagnostics";
import {
	compile,
	getMapper,
	lowerMutation,
	mongoWrite,
	parse,
	planFor,
	tokenize
} from "../index";

function mongo(source: string): {
	collection: string;
	pipeline: readonly Record<string, unknown>[];
} {
	const { native } = compile(source, { engine: "mongodb" });
	if (native.kind !== "mongo") throw new Error("attendu mongo");
	return { collection: native.collection, pipeline: native.pipeline };
}

function mongoMutation(source: string) {
	const stmt = parse(tokenize(source));
	if (stmt.operation === "select") throw new Error("mutation attendue");
	const nat = getMapper("mongodb").mapMutation(lowerMutation(stmt));
	return nat;
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

describe("codegen mongodb — cast ()", () => {
	it("cast(x as int) en pick → $project avec $convert to long + $ifNull wrap", () => {
		const { pipeline } = mongo("get t pick cast(x as int) as x_int");
		expect(pipeline).toEqual([
			{
				$project: {
					x_int: {
						$convert: { input: { $ifNull: ["$x", null] }, to: "long" }
					},
					_id: 0
				}
			}
		]);
	});

	it("les 5 targets $convert mappent vers les types BSON figés", () => {
		// target=date passe désormais par $dateTrunc unit
		// day (émule PG date-only, comble div #15) — testé séparément.
		const cases: [string, string][] = [
			["int", "long"],
			["float", "double"],
			["text", "string"],
			["bool", "bool"],
			["timestamp", "date"]
		];
		for (const [target, bson] of cases) {
			const { pipeline } = mongo(`get t pick cast(x as ${target}) as y`);
			const proj = pipeline[0] as { $project: { y: { $convert: { to: string } } } };
			expect(proj.$project.y.$convert.to).toBe(bson);
		}
	});

	it("cast(x as date) → $dateTrunc unit day (émule PG date-only)", () => {
		const { pipeline } = mongo("get t pick cast(x as date) as y");
		expect(pipeline[0]).toEqual({
			$project: {
				y: {
					$dateTrunc: {
						date: {
							$convert: { input: { $ifNull: ["$x", null] }, to: "date" }
						},
						unit: "day",
						timezone: "UTC"
					}
				},
				_id: 0
			}
		});
	});

	it("cast d'une arith (operand non-field, pas de $ifNull)", () => {
		const { pipeline } = mongo("get t pick cast(a + b as int) as sum");
		expect(pipeline[0]).toEqual({
			$project: {
				sum: {
					$convert: { input: { $add: ["$a", "$b"] }, to: "long" }
				},
				_id: 0
			}
		});
	});

	it("cast d'un call as date (operand call, pas de $ifNull) — wrap $dateTrunc", () => {
		const { pipeline } = mongo("get t pick cast(now() as date) as today");
		expect(pipeline[0]).toEqual({
			$project: {
				today: {
					$dateTrunc: {
						date: { $convert: { input: "$$NOW", to: "date" } },
						unit: "day",
						timezone: "UTC"
					}
				},
				_id: 0
			}
		});
	});

	it("cast imbriqué", () => {
		const { pipeline } = mongo(
			"get t pick cast(cast(raw as text) as int) as n"
		);
		// L'inner cast passe par $ifNull (field), l'outer non (operand cast).
		expect(pipeline[0]).toEqual({
			$project: {
				n: {
					$convert: {
						input: {
							$convert: {
								input: { $ifNull: ["$raw", null] },
								to: "string"
							}
						},
						to: "long"
					}
				},
				_id: 0
			}
		});
	});

	it("cast en WHERE (READ) — $expr gardé existence (ADR-032 1b)", () => {
		const { pipeline } = mongo("get t where cast(x as int) > 30");
		const castExpr = {
			$convert: { input: { $ifNull: ["$x", null] }, to: "long" }
		};
		// Parité 3VL : si le cast rend null (x absent/null) → prédicat UNKNOWN →
		// ligne exclue, comme PG. Les gardes d'existence enveloppent la comparaison.
		expect(pipeline[0]).toEqual({
			$match: {
				$expr: {
					$and: [
						{ $ne: [castExpr, null] },
						{ $ne: [30, null] },
						{ $gt: [castExpr, 30] }
					]
				}
			}
		});
	});

	it("cast en UPDATE SET (write autorisé) — $set pipeline avec $convert", () => {
		const nat = mongoMutation(
			"update t where id = 1 set label = cast(code as text)"
		);
		if (nat.kind !== "mongo-write") throw new Error("mongo-write attendu");
		// L'update Mongo pour un cast en SET matérialise un $set dans un pipeline
		// d'aggregation update — vérifie que $convert est bien émis quelque part.
		const serialized = JSON.stringify(nat);
		expect(serialized).toContain("$convert");
		expect(serialized).toContain("string");
	});
});

describe("codegen mongodb — cast refusé en position prédicat", () => {
	it("cast top-level dans where → codegen_mongo_cast_predicate", () => {
		expectCode(
			() => mongo("get t where cast(x as bool)"),
			"codegen_mongo_cast_predicate"
		);
	});

	it("message adapté au target bool", () => {
		try {
			mongo("get t where cast(x as bool)");
			throw new Error("SnqlError attendu");
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.message).toContain("cast(x as bool) = true");
		}
	});

	it("message générique pour target non-bool", () => {
		try {
			mongo("get t where cast(x as int)");
			throw new Error("SnqlError attendu");
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.message).toContain("compare");
		}
	});
});

describe("cast dans filtre write Mongo via pipeline $expr+$convert", () => {
	it("update where cast(id as text) = '42' → filter {$expr: {$eq:[{$convert}, '42']}}", () => {
		const nat = mongoMutation(
			'update t where cast(id as text) = "42" set y = 1'
		);
		if (nat.kind !== "mongo-write" || nat.op !== "update") {
			throw new Error("update attendu");
		}
		expect(nat.filter).toEqual({
			$expr: {
				$eq: [
					{ $convert: { input: { $ifNull: ["$id", null] }, to: "string" } },
					"42"
				]
			}
		});
		expect(nat.update).toEqual({ $set: { y: 1 } });
	});

	it("remove where cast(x as int) = 42 → deleteMany filter {$expr}", () => {
		const nat = mongoMutation("remove from t where cast(x as int) = 42");
		if (nat.kind !== "mongo-write" || nat.op !== "delete") {
			throw new Error("delete attendu");
		}
		expect(nat.filter).toEqual({
			$expr: {
				$eq: [
					{ $convert: { input: { $ifNull: ["$x", null] }, to: "long" } },
					42
				]
			}
		});
	});

	it("update sans cast dans where → forme classique conservée (indexable)", () => {
		const nat = mongoMutation('update t where id = 1 set y = "z"');
		if (nat.kind !== "mongo-write" || nat.op !== "update") {
			throw new Error("update attendu");
		}
		expect(nat.filter).toEqual({ id: { $eq: 1 } });
	});

	it("update avec cast dans AND-combo : $expr wrappe tout le predicate", () => {
		const nat = mongoMutation(
			'update t where cast(id as text) = "42" and name = "x" set y = 1'
		);
		if (nat.kind !== "mongo-write" || nat.op !== "update") {
			throw new Error("update attendu");
		}
		expect(nat.filter).toEqual({
			$expr: {
				$and: [
					{
						$eq: [
							{ $convert: { input: { $ifNull: ["$id", null] }, to: "string" } },
							"42"
						]
					},
					{ $eq: ["$name", "x"] }
				]
			}
		});
	});
});

describe("refus planner casts coercitifs ambigus (bool/date/timestamp)", () => {
	it("update where cast(x as bool) = true → refus planner_mongo_write_cast_coercive_v3", () => {
		expectCode(
			() => mongoWrite("update t where cast(x as bool) = true set y = 1"),
			"planner_mongo_write_cast_coercive_v3"
		);
	});

	it("remove where cast(x as date) = ... → refus", () => {
		expectCode(
			() => mongoWrite('remove from t where cast(x as date) = "2024-01-01"'),
			"planner_mongo_write_cast_coercive_v3"
		);
	});

	it("update where cast(x as timestamp) = ... → refus", () => {
		expectCode(
			() =>
				mongoWrite(
					'update t where cast(x as timestamp) = "2024-01-01T00:00:00Z" set y = 1'
				),
			"planner_mongo_write_cast_coercive_v3"
		);
	});
});

describe("codegen mongodb — cast dans in refusé (v1)", () => {
	it("where x in [cast(1 as int)] → codegen_mongo_in_value", () => {
		expectCode(
			() => mongo("get t where x in [cast(1 as int)]"),
			"codegen_mongo_in_value"
		);
	});
});

describe("codegen mongodb — cast(_ as json) no-op (#7)", () => {
	it("via planFor() → accepté (json ajouté aux Mongo castTargets)", () => {
		expect(() =>
			planFor("get t pick cast(payload as json) as p", "mongodb")
		).not.toThrow();
	});

	it("via compile() → codegen produit un pipeline sans $convert (no-op)", () => {
		// L'operand `payload` est retourné tel quel — pas de wrap $convert.
		// Le $project pick le champ direct (path bare).
		const { pipeline } = mongo("get t pick cast(payload as json) as p");
		const project = pipeline.find((s) => "$project" in s) as {
			$project: Record<string, unknown>;
		};
		// Le field `payload` renommé en `p` — pas de $convert.
		expect(project.$project.p).toBe("$payload");
	});
});
