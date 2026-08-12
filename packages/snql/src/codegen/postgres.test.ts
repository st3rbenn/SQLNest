import { describe, expect, it } from "vitest";
import {
	compile,
	getMapper,
	lowerMutation,
	parse,
	tokenize
} from "../index";
import type { SerializedSpan } from "./mapper";

function sql(source: string): { text: string; params: readonly unknown[] } {
	const { native } = compile(source, { engine: "postgres" });
	return { text: native.text, params: native.params };
}

/** Récupère `paramSpans` avec les autres champs — utilisé par les tests 3a. */
function sqlWithSpans(source: string): {
	text: string;
	params: readonly unknown[];
	paramSpans: readonly (SerializedSpan | undefined)[];
} {
	const { native } = compile(source, { engine: "postgres" });
	if (native.kind !== "sql") throw new Error("attendu du SQL");
	return {
		text: native.text,
		params: native.params,
		paramSpans: native.paramSpans ?? []
	};
}

describe("codegen postgres — clauses de base", () => {
	it("compile la requête canonique (with→where→sort→pick→limit)", () => {
		const { text, params } = sql(
			`get users where age > 30 and status = "active" sort created_at desc pick name, email limit 10 offset 20`
		);
		expect(text).toBe(
			`SELECT "name", "email" FROM "users" WHERE ("age" > $1 AND "status" = $2) ORDER BY "created_at" DESC LIMIT $3 OFFSET $4`
		);
		expect(params).toEqual([30, "active", 10, 20]);
	});

	it("SELECT * sans pick", () => {
		const { text, params } = sql("get users");
		expect(text).toBe(`SELECT * FROM "users"`);
		expect(params).toEqual([]);
	});

	it("alias + chemins pointés (ordre canonique where→pick)", () => {
		const { text, params } = sql(
			"get users as u where u.age >= 18 pick u.name as name"
		);
		expect(text).toBe(
			`SELECT "u"."name" AS "name" FROM "users" AS "u" WHERE "u"."age" >= $1`
		);
		expect(params).toEqual([18]);
	});

	it("tri multi-clés avec directions", () => {
		const { text } = sql("get users sort created_at desc, name asc");
		expect(text).toBe(
			`SELECT * FROM "users" ORDER BY "created_at" DESC, "name" ASC`
		);
	});

	it("direction desc explicite", () => {
		const { text } = sql("get users sort created_at desc");
		expect(text).toBe(`SELECT * FROM "users" ORDER BY "created_at" DESC`);
	});

	it("limit sans offset", () => {
		const { text, params } = sql("get users limit 3");
		expect(text).toBe(`SELECT * FROM "users" LIMIT $1`);
		expect(params).toEqual([3]);
	});

	it("like et not", () => {
		const { text, params } = sql(`get users where not name like "bob%"`);
		expect(text).toBe(`SELECT * FROM "users" WHERE (NOT "name" LIKE $1)`);
		expect(params).toEqual(["bob%"]);
	});

	it("liste IN paramétrée", () => {
		const { text, params } = sql(`get users where role in ["admin", "mod"]`);
		expect(text).toBe(`SELECT * FROM "users" WHERE "role" IN ($1, $2)`);
		expect(params).toEqual(["admin", "mod"]);
	});

	it("paramètre les valeurs, ne les concatène jamais (anti-injection)", () => {
		const { text, params } = sql(
			`get users where name = "'; DROP TABLE users; --"`
		);
		expect(text).toBe(`SELECT * FROM "users" WHERE "name" = $1`);
		expect(params).toEqual(["'; DROP TABLE users; --"]);
	});

	it("compile() est en lecture seule : refuse une mutation", () => {
		expect(() => sql("update users where id = 1 set x = 1")).toThrow(
			/lecture seule/i
		);
	});

	it("rejette une projection à colonnes dupliquées sans alias", () => {
		expect(() => sql("get users pick a.name, b.name")).toThrow(/dupliqu/i);
	});
});

describe("codegen postgres — null-aware (bug F)", () => {
	it("= null → IS NULL", () => {
		expect(sql("find users where deleted_at = null").text).toBe(
			`SELECT * FROM "users" WHERE "deleted_at" IS NULL`
		);
	});
	it("!= null → IS NOT NULL", () => {
		expect(sql("find users where deleted_at != null").text).toBe(
			`SELECT * FROM "users" WHERE "deleted_at" IS NOT NULL`
		);
	});
	it("null à GAUCHE aussi → IS NULL (symétrique)", () => {
		expect(sql("find users where null = deleted_at").text).toBe(
			`SELECT * FROM "users" WHERE "deleted_at" IS NULL`
		);
	});
});

describe("codegen postgres — littéraux numériques (bugs D, E)", () => {
	it("littéral négatif dans where (bug D)", () => {
		const { text, params } = sql("get users where balance = -50");
		expect(text).toBe(`SELECT * FROM "users" WHERE "balance" = $1`);
		expect(params).toEqual([-50]);
	});
	it("négatif après comparaison <", () => {
		expect(sql("get users where delta < -100").params).toEqual([-100]);
	});
	it("préserve la précision des entiers > 2^53 en bigint (bug E)", () => {
		const { params } = sql("get users where id = 9007199254740993");
		expect(params).toEqual([9007199254740993n]);
	});
	it("garde les petits entiers en number", () => {
		expect(sql("get users where age = 30").params).toEqual([30]);
	});
	it("préserve un décimal exact en prédicat (texte brut, pas un double)", () => {
		const { text, params } = sql("get t where balance = 19.999999999999999");
		// Pas de cast `::numeric` ici : dans un compare le param unknown est inféré
		// depuis le type de colonne (numeric OU text — les 2 marchent).
		expect(text).toBe(`SELECT * FROM "t" WHERE "balance" = $1`);
		expect(params).toEqual(["19.999999999999999"]);
	});
});

describe("codegen postgres — liste IN vide (bug B)", () => {
	it("in [] → FALSE (au lieu de IN () invalide)", () => {
		const { text, params } = sql("get users where role in []");
		expect(text).toBe(`SELECT * FROM "users" WHERE FALSE`);
		expect(params).toEqual([]);
	});
	it("not (in []) → NOT FALSE", () => {
		expect(sql("get users where not role in []").text).toBe(
			`SELECT * FROM "users" WHERE (NOT FALSE)`
		);
	});
});

describe("codegen postgres — paramSpans (Phase 3a, traçabilité $N → source)", () => {
	it("chaque littéral WHERE reçoit un span [start, length] pointant sur son token", () => {
		const source = `get users where age > 30 and name = "bob"`;
		const { params, paramSpans } = sqlWithSpans(source);
		expect(params).toEqual([30, "bob"]);
		// Vérifie que les spans pointent bien sur les valeurs source (source-truth,
		// pas d'offsets magiques à maintenir à la main).
		const [s1, s2] = paramSpans as [SerializedSpan, SerializedSpan];
		expect(source.slice(s1[0], s1[0] + s1[1])).toBe("30");
		expect(source.slice(s2[0], s2[0] + s2[1])).toBe(`"bob"`);
	});

	it("LIMIT/OFFSET (nombres nus, sans span dans le plan) → undefined en 3a", () => {
		const source = `get users where age > 18 limit 10 offset 20`;
		const { params, paramSpans } = sqlWithSpans(source);
		expect(params).toEqual([18, 10, 20]);
		// Seul le littéral WHERE porte un span ; limit/offset produisent undefined
		// jusqu'à 3b (span sur les stages sort/limit du plan).
		expect(paramSpans.length).toBe(3);
		expect(paramSpans[1]).toBeUndefined();
		expect(paramSpans[2]).toBeUndefined();
		const s0 = paramSpans[0] as SerializedSpan;
		expect(source.slice(s0[0], s0[0] + s0[1])).toBe("18");
	});

	it("liste IN — chaque valeur reçoit son span propre", () => {
		//                                    0         1         2
		//                                    01234567890123456789012345678901234
		const source = `get users where role in ["admin", "mod"]`;
		const { params, paramSpans } = sqlWithSpans(source);
		expect(params).toEqual(["admin", "mod"]);
		const [s1, s2] = paramSpans as [SerializedSpan, SerializedSpan];
		expect(source.slice(s1[0], s1[0] + s1[1])).toBe(`"admin"`);
		expect(source.slice(s2[0], s2[0] + s2[1])).toBe(`"mod"`);
	});

	it("null → jamais paramétré, jamais dans paramSpans (canonicalisé en IS NULL)", () => {
		const { text, params, paramSpans } = sqlWithSpans(
			`get users where display_name = null`
		);
		expect(text).toBe(`SELECT * FROM "users" WHERE "display_name" IS NULL`);
		expect(params).toEqual([]);
		expect(paramSpans).toEqual([]);
	});

	it("SqlDecimal exact — span présent et pointe sur le raw source", () => {
		//                                       0         1         2         3
		//                                       012345678901234567890123456789012345
		const source = `get accounts where balance > 1.123456789012345678`;
		const { params, paramSpans } = sqlWithSpans(source);
		expect(params).toEqual(["1.123456789012345678"]);
		const [s] = paramSpans as [SerializedSpan];
		expect(source.slice(s[0], s[0] + s[1])).toBe("1.123456789012345678");
	});
});

describe("codegen postgres — ordre canonique refuse les inversions", () => {
	it("limit AVANT sort refusé par la grammaire", () => {
		expect(() => sql("get users limit 5 sort created_at desc")).toThrow(
			/hors ordre/i
		);
	});

	it("limit AVANT where refusé par la grammaire", () => {
		expect(() => sql("get users limit 5 where age > 30")).toThrow(
			/hors ordre/i
		);
	});

	it("pick AVANT sort refusé par la grammaire", () => {
		expect(() => sql("get users pick name sort age")).toThrow(/hors ordre/i);
	});

	it("limit répété refusé par la grammaire", () => {
		expect(() => sql("get users limit 5 limit 10")).toThrow(/hors ordre/i);
	});

	it("sort répété refusé par la grammaire", () => {
		expect(() => sql("get users sort a sort b")).toThrow(/hors ordre/i);
	});
});

describe("codegen postgres — décimaux et cast contextuel", () => {
	it("décimal dans arith → cast `::numeric` local (typer face à un int)", () => {
		// `int_col * 0.1` sans cast → PG essaie de caster "0.1" en int → 22P02.
		expect(sql("get t pick len * 0.1 as x").text).toBe(
			`SELECT ("len" * $1::numeric) AS "x" FROM "t"`
		);
	});

	it("décimal dans INSERT vers colonne text → pas de cast (assign via colonne)", () => {
		// Régression trouvée par l'adversarial : `::numeric` global cassait
		// l'INSERT dans une colonne text (PG 42804 : no assignment cast).
		const stmt = parse(tokenize("add {name: 1.5} into t"));
		if (stmt.operation !== "insert") throw new Error("attendu insert");
		const nat = getMapper("postgres").mapMutation(lowerMutation(stmt));
		if (nat.kind !== "sql") throw new Error("attendu sql");
		expect(nat.text).toBe(
			`INSERT INTO "t" ("name") VALUES ($1) RETURNING *`
		);
		expect(nat.params).toEqual(["1.5"]);
	});

	it("décimal dans UPDATE vers colonne jsonb → pas de cast", () => {
		const stmt = parse(tokenize("update accounts where id = 1 set meta = 1.5"));
		if (stmt.operation !== "update") throw new Error("attendu update");
		const nat = getMapper("postgres").mapMutation(lowerMutation(stmt));
		if (nat.kind !== "sql") throw new Error("attendu sql");
		expect(nat.text).toBe(
			`UPDATE "accounts" SET "meta" = $1 WHERE "id" = $2 RETURNING *`
		);
	});

	it("décimal dans WHERE compare varchar → pas de cast (assign via colonne)", () => {
		// `where varchar_col = 1.5` doit rester `= $1` — sinon PG rejette
		// `character varying = numeric` (opérateur inexistant).
		expect(sql("get products where sku = 1.5").text).toBe(
			`SELECT * FROM "products" WHERE "sku" = $1`
		);
	});

	it("décimal dans LIKE → pas de cast", () => {
		// `LIKE $1::numeric` déclencherait 42883 côté PG. On laisse `$1` unknown.
		expect(sql("get t where name like 1.5").text).toBe(
			`SELECT * FROM "t" WHERE "name" LIKE $1`
		);
	});
});

describe("codegen postgres — arithmétique scalaire (T1)", () => {
	it("+ et * dans WHERE avec parens défensives", () => {
		const { text, params } = sql("get users where age * 2 > 30");
		expect(text).toBe(
			`SELECT * FROM "users" WHERE ("age" * $1) > $2`
		);
		expect(params).toEqual([2, 30]);
	});

	it("précédence : * lie plus fort que + (bp 6 > 5)", () => {
		const { text } = sql("get t where a + b * c > 0");
		expect(text).toBe(
			`SELECT * FROM "t" WHERE ("a" + ("b" * "c")) > $1`
		);
	});

	it("expression calculée dans pick avec alias", () => {
		const { text } = sql("get items pick price * qty as total");
		expect(text).toBe(
			`SELECT ("price" * "qty") AS "total" FROM "items"`
		);
	});

	it("expression pick sans alias → erreur du parseur", () => {
		expect(() => sql("get items pick price * qty")).toThrow(
			/exige un alias/i
		);
	});

	it("- dans set (update via mutation path)", () => {
		// `compile()` est read-only ; les mutations passent par parse+lowerMutation+mapMutation.
		const stmt = parse(tokenize("update stock where id = 1 set qty = qty - 1"));
		if (stmt.operation !== "update") throw new Error("attendu update");
		const nat = getMapper("postgres").mapMutation(lowerMutation(stmt));
		if (nat.kind !== "sql") throw new Error("attendu sql");
		expect(nat.text).toBe(
			`UPDATE "stock" SET "qty" = ("qty" - $1) WHERE "id" = $2 RETURNING *`
		);
		expect(nat.params).toEqual([1, 1]);
	});

	it("modulo dans WHERE", () => {
		const { text } = sql("get t where balance % 2 = 0");
		expect(text).toBe(
			`SELECT * FROM "t" WHERE ("balance" % $1) = $2`
		);
	});

	it("expressions combinées : where + pick + limit", () => {
		// Note : `sort` en T1 reste sur chemin simple ; sort par expression est
		// prévu en T2 (dépend du call node pour être cohérent).
		const { text } = sql(
			"get orders where price + tax > 100 sort id desc pick id, price * qty as total limit 10"
		);
		expect(text).toBe(
			`SELECT "id", ("price" * "qty") AS "total" FROM "orders" WHERE ("price" + "tax") > $1 ORDER BY "id" DESC LIMIT $2`
		);
	});
});
