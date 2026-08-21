import { describe, expect, it } from "vitest";
import { SnqlError } from "../diagnostics";
import {
	compile,
	getMapper,
	lowerMutation,
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

describe("codegen mongodb — cast (T2 sprint 2)", () => {
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

	it("les 6 targets mappent vers les types BSON figés", () => {
		const cases: [string, string][] = [
			["int", "long"],
			["float", "double"],
			["text", "string"],
			["bool", "bool"],
			["date", "date"],
			["timestamp", "date"]
		];
		for (const [target, bson] of cases) {
			const { pipeline } = mongo(`get t pick cast(x as ${target}) as y`);
			const proj = pipeline[0] as { $project: { y: { $convert: { to: string } } } };
			expect(proj.$project.y.$convert.to).toBe(bson);
		}
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

	it("cast d'un call (operand call, pas de $ifNull)", () => {
		const { pipeline } = mongo("get t pick cast(now() as date) as today");
		const proj = pipeline[0] as {
			$project: { today: { $convert: { input: unknown; to: string } } };
		};
		expect(proj.$project.today.$convert.to).toBe("date");
		// L'input du convert n'est PAS un $ifNull — c'est directement le résultat now().
		expect(proj.$project.today.$convert.input).toEqual("$$NOW");
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

	it("cast en WHERE (READ) — passe par $expr", () => {
		const { pipeline } = mongo("get t where cast(x as int) > 30");
		expect(pipeline[0]).toEqual({
			$match: {
				$expr: {
					$gt: [
						{ $convert: { input: { $ifNull: ["$x", null] }, to: "long" } },
						30
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

describe("codegen mongodb — cast refusé dans filtre write", () => {
	it("update where cast(id as text) = ... → codegen_mongo_write_cast_predicate (message dédié)", () => {
		try {
			mongoMutation('update t where cast(id as text) = "42" set y = 1');
			throw new Error("SnqlError attendu");
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.code).toBe("codegen_mongo_write_cast_predicate");
			expect(e.message).toContain("matérialise");
			// NE PAS réutiliser le message champ↔champ trompeur.
			expect(e.message).not.toContain("champ↔champ");
		}
	});

	it("remove where cast(x as int) = 42 → refusé pareil", () => {
		expectCode(
			() => mongoMutation("remove from t where cast(x as int) = 42"),
			"codegen_mongo_write_cast_predicate"
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

describe("codegen mongodb — cast(_ as json) no-op (ADR-024 PM/6 #7)", () => {
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
