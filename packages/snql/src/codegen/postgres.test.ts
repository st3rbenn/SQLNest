import { describe, expect, it } from "vitest";
import { compile } from "../index";

function sql(source: string): { text: string; params: readonly unknown[] } {
	const { native } = compile(source, { engine: "postgres" });
	return { text: native.text, params: native.params };
}

describe("codegen postgres — clauses de base", () => {
	it("compile le pipeline de lecture canonique (pick en dernier)", () => {
		const { text, params } = sql(
			`get users | where age > 30 and status = "active" | sort -created_at | limit 10 offset 20 | pick name, email`
		);
		expect(text).toBe(
			`SELECT "name", "email" FROM "users" WHERE ("age" > $1 AND "status" = $2) ORDER BY "created_at" DESC LIMIT $3 OFFSET $4`
		);
		expect(params).toEqual([30, "active", 10, 20]);
	});

	it("pipeline strict : sort sur une colonne retirée par pick → erreur", () => {
		expect(() => sql("get users | pick name | sort age")).toThrow(/pick/i);
	});

	it("SELECT * sans pick", () => {
		const { text, params } = sql("get users");
		expect(text).toBe(`SELECT * FROM "users"`);
		expect(params).toEqual([]);
	});

	it("alias + chemins pointés (ordre canonique where→pick)", () => {
		const { text, params } = sql(
			"get users as u | where u.age >= 18 | pick u.name as name"
		);
		expect(text).toBe(
			`SELECT "u"."name" AS "name" FROM "users" AS "u" WHERE "u"."age" >= $1`
		);
		expect(params).toEqual([18]);
	});

	it("tri multi-clés avec directions", () => {
		const { text } = sql("get users | sort -created_at, +name");
		expect(text).toBe(
			`SELECT * FROM "users" ORDER BY "created_at" DESC, "name" ASC`
		);
	});

	it("mot-clé desc équivaut au signe -", () => {
		const { text } = sql("get users | sort created_at desc");
		expect(text).toBe(`SELECT * FROM "users" ORDER BY "created_at" DESC`);
	});

	it("limit sans offset", () => {
		const { text, params } = sql("get users | limit 3");
		expect(text).toBe(`SELECT * FROM "users" LIMIT $1`);
		expect(params).toEqual([3]);
	});

	it("like et not", () => {
		const { text, params } = sql(`get users | where not name like "bob%"`);
		expect(text).toBe(`SELECT * FROM "users" WHERE (NOT "name" LIKE $1)`);
		expect(params).toEqual(["bob%"]);
	});

	it("liste IN paramétrée", () => {
		const { text, params } = sql(`get users | where role in ["admin", "mod"]`);
		expect(text).toBe(`SELECT * FROM "users" WHERE "role" IN ($1, $2)`);
		expect(params).toEqual(["admin", "mod"]);
	});

	it("paramètre les valeurs, ne les concatène jamais (anti-injection)", () => {
		const { text, params } = sql(
			`get users | where name = "'; DROP TABLE users; --"`
		);
		expect(text).toBe(`SELECT * FROM "users" WHERE "name" = $1`);
		expect(params).toEqual(["'; DROP TABLE users; --"]);
	});

	it("compile() est en lecture seule : refuse une mutation", () => {
		expect(() => sql("update users | where id = 1 | set x = 1")).toThrow(
			/lecture seule/i
		);
	});

	it("rejette une projection à colonnes dupliquées sans alias", () => {
		expect(() => sql("get users | pick a.name, b.name")).toThrow(/dupliqu/i);
	});
});

describe("codegen postgres — null-aware (bug F)", () => {
	it("= null → IS NULL", () => {
		expect(sql("find users | where deleted_at = null").text).toBe(
			`SELECT * FROM "users" WHERE "deleted_at" IS NULL`
		);
	});
	it("!= null → IS NOT NULL", () => {
		expect(sql("find users | where deleted_at != null").text).toBe(
			`SELECT * FROM "users" WHERE "deleted_at" IS NOT NULL`
		);
	});
	it("null à GAUCHE aussi → IS NULL (symétrique)", () => {
		expect(sql("find users | where null = deleted_at").text).toBe(
			`SELECT * FROM "users" WHERE "deleted_at" IS NULL`
		);
	});
});

describe("codegen postgres — littéraux numériques (bugs D, E)", () => {
	it("littéral négatif dans where (bug D)", () => {
		const { text, params } = sql("get users | where balance = -50");
		expect(text).toBe(`SELECT * FROM "users" WHERE "balance" = $1`);
		expect(params).toEqual([-50]);
	});
	it("négatif après comparaison <", () => {
		expect(sql("get users | where delta < -100").params).toEqual([-100]);
	});
	it("préserve la précision des entiers > 2^53 en bigint (bug E)", () => {
		const { params } = sql("get users | where id = 9007199254740993");
		expect(params).toEqual([9007199254740993n]);
	});
	it("garde les petits entiers en number", () => {
		expect(sql("get users | where age = 30").params).toEqual([30]);
	});
	it("préserve un décimal exact en prédicat (texte brut, pas un double)", () => {
		const { text, params } = sql("get t | where balance = 19.999999999999999");
		expect(text).toBe(`SELECT * FROM "t" WHERE "balance" = $1`);
		expect(params).toEqual(["19.999999999999999"]);
	});
});

describe("codegen postgres — liste IN vide (bug B)", () => {
	it("in [] → FALSE (au lieu de IN () invalide)", () => {
		const { text, params } = sql("get users | where role in []");
		expect(text).toBe(`SELECT * FROM "users" WHERE FALSE`);
		expect(params).toEqual([]);
	});
	it("not (in []) → NOT FALSE", () => {
		expect(sql("get users | where not role in []").text).toBe(
			`SELECT * FROM "users" WHERE (NOT FALSE)`
		);
	});
});

describe("codegen postgres — ordre du pipeline préservé (bugs A, C)", () => {
	it("limit AVANT where → sous-requête (take-then-filter, PAS l'inverse)", () => {
		const { text, params } = sql("get users | limit 5 | where age > 30");
		expect(text).toBe(
			`SELECT * FROM (SELECT * FROM "users" LIMIT $1) AS "t0" WHERE "age" > $2`
		);
		expect(params).toEqual([5, 30]);
	});

	it("les deux ordres ne produisent PLUS le même SQL", () => {
		const a = sql("get users | limit 5 | where age > 30").text;
		const b = sql("get users | where age > 30 | limit 5").text;
		expect(a).not.toBe(b);
		expect(b).toBe(`SELECT * FROM "users" WHERE "age" > $1 LIMIT $2`);
	});

	it("limit AVANT sort → sous-requête", () => {
		expect(sql("get users | limit 5 | sort -created_at").text).toBe(
			`SELECT * FROM (SELECT * FROM "users" LIMIT $1) AS "t0" ORDER BY "created_at" DESC`
		);
	});

	it("limits répétés composent au lieu d'écraser (bug C)", () => {
		const { text, params } = sql("get users | limit 5 | limit 10");
		expect(text).toBe(
			`SELECT * FROM (SELECT * FROM "users" LIMIT $1) AS "t0" LIMIT $2`
		);
		expect(params).toEqual([5, 10]);
	});

	it("offset antérieur n'est plus silencieusement perdu", () => {
		const { text, params } = sql("get users | limit 10 offset 5 | limit 3");
		expect(text).toBe(
			`SELECT * FROM (SELECT * FROM "users" LIMIT $1 OFFSET $2) AS "t0" LIMIT $3`
		);
		expect(params).toEqual([10, 5, 3]);
	});

	it("sorts répétés s'imbriquent (chaque sort re-trie)", () => {
		expect(sql("get users | sort a | sort b").text).toBe(
			`SELECT * FROM (SELECT * FROM "users" ORDER BY "a" ASC) AS "t0" ORDER BY "b" ASC`
		);
	});
});
