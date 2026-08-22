import { describe, expect, it } from "vitest";
import { compile } from "../index";

function mongo(source: string): {
	collection: string;
	pipeline: readonly Record<string, unknown>[];
} {
	const { native } = compile(source, { engine: "mongodb" });
	if (native.kind !== "mongo") {
		throw new Error("attendu une requête mongo");
	}
	return { collection: native.collection, pipeline: native.pipeline };
}

describe("codegen mongodb — pipeline de base", () => {
	it("compile la requête canonique (with→where→pick→sort→limit)", () => {
		// sort par colonne DROPPÉE par pick → auto-reorder $sort
		// avant $project pour préserver l'accès à la col source (aligné PG lax).
		const { collection, pipeline } = mongo(
			`get users where age > 30 and status = "active" pick name, email sort created_at desc limit 10 offset 20`
		);
		expect(collection).toBe("users");
		expect(pipeline).toEqual([
			{
				$match: { $and: [{ age: { $gt: 30 } }, { status: { $eq: "active" } }] }
			},
			{ $sort: { created_at: -1 } },
			{ $project: { name: 1, email: 1, _id: 0 } },
			{ $skip: 20 },
			{ $limit: 10 }
		]);
	});

	it("sans étape → pipeline vide", () => {
		expect(mongo("get users").pipeline).toEqual([]);
	});

	it("tri multi-clés", () => {
		expect(mongo("get users sort created_at desc, name asc").pipeline).toEqual([
			{ $sort: { created_at: -1, name: 1 } }
		]);
	});

	it("chemin pointé imbriqué conservé", () => {
		expect(mongo('get users where address.city = "Paris"').pipeline).toEqual([
			{ $match: { "address.city": { $eq: "Paris" } } }
		]);
	});
});

describe("codegen mongodb — ordre canonique", () => {
	it("where AVANT limit produit un pipeline dans cet ordre", () => {
		expect(mongo("get users where age > 30 limit 5").pipeline).toEqual([
			{ $match: { age: { $gt: 30 } } },
			{ $limit: 5 }
		]);
	});

	it("limit AVANT where refusé par la grammaire", () => {
		expect(() => mongo("get users limit 5 where age > 30")).toThrow(
			/hors ordre/i
		);
	});
});

describe("codegen mongodb — expressions", () => {
	it("like → $regex ancrée (échappement, dotall, fin \\z)", () => {
		expect(mongo(`get users where name like "bob.%"`).pipeline).toEqual([
			{ $match: { name: { $regex: "^bob\\.[\\s\\S]*\\z" } } }
		]);
	});

	it("in → $in", () => {
		expect(
			mongo(`get users where role in ["admin", "mod"]`).pipeline
		).toEqual([{ $match: { role: { $in: ["admin", "mod"] } } }]);
	});

	it("in [] → $in vide (ne matche rien)", () => {
		expect(mongo("get users where role in []").pipeline).toEqual([
			{ $match: { role: { $in: [] } } }
		]);
	});

	it("= null → { champ: null }", () => {
		expect(mongo("find users where deleted_at = null").pipeline).toEqual([
			{ $match: { deleted_at: null } }
		]);
	});

	it("!= null → { champ: { $ne: null } }", () => {
		expect(mongo("find users where deleted_at != null").pipeline).toEqual([
			{ $match: { deleted_at: { $ne: null } } }
		]);
	});

	it("not / nor", () => {
		expect(mongo(`get users where not status = "x"`).pipeline).toEqual([
			{ $match: { $nor: [{ status: { $eq: "x" } }] } }
		]);
	});

	it("littéral à gauche → normalisé (champ à gauche, forme idiomatique)", () => {
		expect(mongo("get users where 30 < age").pipeline).toEqual([
			{ $match: { age: { $gt: 30 } } }
		]);
	});

	it("champ ↔ champ → repli $expr", () => {
		expect(mongo("get users where age < max_age").pipeline).toEqual([
			{ $match: { $expr: { $lt: ["$age", "$max_age"] } } }
		]);
	});

	it("$expr : une chaîne littérale `$…` n'est pas prise pour un champ", () => {
		// Dans une expression d'agrégation, "$name" désignerait le champ `name`.
		expect(mongo('get users where "$name" = "$name"').pipeline).toEqual([
			{
				$match: {
					$expr: { $eq: [{ $literal: "$name" }, { $literal: "$name" }] }
				}
			}
		]);
	});

	it("préserve la précision bigint", () => {
		expect(mongo("get users where id = 9007199254740993").pipeline).toEqual([
			{ $match: { id: { $eq: 9007199254740993n } } }
		]);
	});

	it("un décimal dans un filtre de LECTURE est un double (matche les doubles stockés)", () => {
		// Contraste avec l'écriture de valeurs (Decimal128 exact) : un filtre reste
		// en double, sinon `where price = 1.5` ne matcherait plus les données double.
		expect(mongo("get products where price = 1.5").pipeline).toEqual([
			{ $match: { price: { $eq: 1.5 } } }
		]);
	});

	it("littéral négatif", () => {
		expect(mongo("get users where balance = -50").pipeline).toEqual([
			{ $match: { balance: { $eq: -50 } } }
		]);
	});
});

describe("codegen mongodb — alias de collection", () => {
	it("strippe l'alias (pas de sens en document)", () => {
		const { collection, pipeline } = mongo(
			"get users as u where u.age >= 18 pick u.name as name"
		);
		expect(collection).toBe("users");
		expect(pipeline).toEqual([
			{ $match: { age: { $gte: 18 } } },
			{ $project: { name: "$name", _id: 0 } }
		]);
	});
});
