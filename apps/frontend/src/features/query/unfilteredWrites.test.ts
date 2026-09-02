import { parse, tokenize } from "@sqlnest/snql";
import { describe, expect, it } from "vitest";
import { collectUnfilteredWrites, hasAnyUnfilteredWrite } from "./unfilteredWrites";

/**
 * Tests exhaustifs du walker. Le walker est pur (Statement in, findings
 * out) — pas de mock, pas de fixture partagée, un parser réel via
 * @sqlnest/snql source-imported.
 */

function analyze(source: string) {
	return collectUnfilteredWrites(parse(tokenize(source)));
}

describe("collectUnfilteredWrites — cas de base D2", () => {
	it("remove sans predicate = unfiltered_delete", () => {
		const findings = analyze("remove from users");
		expect(findings).toHaveLength(1);
		expect(findings[0]?.kind).toBe("unfiltered_delete");
		expect(findings[0]?.verb).toBe("remove");
		expect(findings[0]?.target).toBe("users");
	});

	it("update sans predicate = unfiltered_update", () => {
		const findings = analyze("update users set active = false");
		expect(findings).toHaveLength(1);
		expect(findings[0]?.kind).toBe("unfiltered_update");
		expect(findings[0]?.target).toBe("users");
	});

	it("remove with predicate = 0 finding", () => {
		expect(analyze("remove from users where id = 42")).toHaveLength(0);
	});

	it("update with predicate = 0 finding", () => {
		// Ordre grammatical SNQL : with → where → set (rejeté sinon au parser
		// via rejectTrailingStage).
		expect(
			analyze("update users where id = 42 set active = false")
		).toHaveLength(0);
	});

	it("select find = 0 finding", () => {
		expect(analyze("find users pick email")).toHaveLength(0);
	});
});

describe("collectUnfilteredWrites — D1 raw_opaque systématique", () => {
	it("raw SQL = raw_opaque (même pour SELECT)", () => {
		const findings = analyze('raw "SELECT * FROM users"');
		expect(findings).toHaveLength(1);
		expect(findings[0]?.kind).toBe("raw_opaque");
		expect(findings[0]?.verb).toBe("raw");
	});

	it("raw SQL DELETE = raw_opaque (payload opaque, warn systématique)", () => {
		const findings = analyze('raw "DELETE FROM users"');
		expect(findings).toHaveLength(1);
		expect(findings[0]?.kind).toBe("raw_opaque");
	});

	it("raw Mongo = raw_opaque", () => {
		// Le keyword `delete` est réservé côté parser — on utilise un shape
		// Mongo réaliste avec key non-reserved (aggregate est le pattern usuel).
		const findings = analyze('raw {aggregate: "users", pipeline: []}');
		expect(findings).toHaveLength(1);
		expect(findings[0]?.kind).toBe("raw_opaque");
	});
});

describe("collectUnfilteredWrites — D3 on-conflict where IGNORÉ", () => {
	it("upsert basique sans where global = 0 finding (keys de conflit bornent)", () => {
		expect(
			analyze(
				"add {id: 1, x: 5} into t on conflict (id) edit set x = new.x"
			)
		).toHaveLength(0);
	});

	it("upsert avec ignore on conflict = 0 finding", () => {
		expect(
			analyze("add {id: 1, x: 5} into t on conflict (id) ignore")
		).toHaveLength(0);
	});

	it("upsert avec on-conflict where partiel = 0 finding (le where n'est PAS un signal unfiltered)", () => {
		expect(
			analyze(
				"add {id: 1, x: 5} into t on conflict (id) edit set x = new.x where t.x != new.x"
			)
		).toHaveLength(0);
	});
});

describe("collectUnfilteredWrites — D4 mutation-join sans predicate", () => {
	it("update mutation-join sans predicate = unfiltered_update (les joins ne comptent pas comme filter)", () => {
		const findings = analyze(
			"update orders with one users as u on user_id = u.id set discount = 0.1"
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.kind).toBe("unfiltered_update");
		expect(findings[0]?.target).toBe("orders");
	});

	it("update mutation-join AVEC predicate = 0 finding", () => {
		expect(
			analyze(
				"update orders with one users as u on user_id = u.id where u.premium = true set discount = 0.1"
			)
		).toHaveLength(0);
	});
});

describe("collectUnfilteredWrites — D6 bulk-copy insert-select", () => {
	it("insert-select sans where dans sourceQuery = bulk_copy_insert", () => {
		const findings = analyze("add (find users pick id, email) into archive");
		expect(findings).toHaveLength(1);
		expect(findings[0]?.kind).toBe("bulk_copy_insert");
		expect(findings[0]?.target).toBe("archive");
	});

	it("insert-select AVEC where dans sourceQuery = 0 finding", () => {
		expect(
			analyze(
				"add (find users where inactive = true pick id, email) into archive"
			)
		).toHaveLength(0);
	});

	it("insert-values (documents literal) sans sourceQuery = 0 finding (bornage par nb rows)", () => {
		expect(analyze('add {id: 1, x: 5} into t')).toHaveLength(0);
	});
});

describe("collectUnfilteredWrites — D2 récursion transaction/savepoint/let", () => {
	it("transaction wrappant 2 unfiltered = 2 findings distincts (pas 1 global)", () => {
		const findings = analyze(
			"transaction { remove from users; remove from orders; }"
		);
		expect(findings).toHaveLength(2);
		expect(findings.map((f) => f.kind)).toEqual([
			"unfiltered_delete",
			"unfiltered_delete"
		]);
		expect(findings.map((f) => f.target)).toEqual(["users", "orders"]);
	});

	it("transaction avec mix filtered + unfiltered = 1 finding sur l'unfiltered seul", () => {
		const findings = analyze(
			"transaction { remove from users where id = 42; remove from orders; }"
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.target).toBe("orders");
	});

	it("savepoint imbriqué dans savepoint dans transaction = walk deep récursif", () => {
		const findings = analyze(
			"transaction { savepoint sp1 { savepoint sp2 { remove from users; } } }"
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.kind).toBe("unfiltered_delete");
		expect(findings[0]?.target).toBe("users");
	});

	it("savepoint racine standalone = REFUSÉ au parse (D2-amendment sans objet)", () => {
		// CORRECTION du briefing panel : le parser REFUSE savepoint en racine
		// ("Une requête doit commencer par un verbe … ou 'transaction', trouvé
		// 'savepoint'" — parser.ts:89). Le D2-amendment adversarial supposait
		// que le parser acceptait — c'est faux. Le walker garde son case
		// 'savepoint' racine défensif (jamais atteint runtime), mais on
		// documente ici que ce n'est PAS un cas UX réel à tester.
		expect(() => analyze("savepoint sp1 { remove from users; }")).toThrow();
	});

	it("let x = ...; <body update unfiltered> = walk .body single (D2)", () => {
		const findings = analyze(
			"let recent = find events where day > '2026-01-01' pick user_id; update users set is_active = false"
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.kind).toBe("unfiltered_update");
		expect(findings[0]?.target).toBe("users");
	});

	it("let x = ...; <body find> = 0 finding (body select)", () => {
		expect(
			analyze("let x = find users pick id; find x pick id")
		).toHaveLength(0);
	});

	it("let bindings sont read-only par contrat, PAS walkés (le body seul est walké)", () => {
		// Un let dont le body est un insert-select AVEC where dans le CTE ne
		// doit produire aucun finding : le walker ne descend PAS dans les
		// bindings (read-only par contrat lower). Le body est un insert-select
		// dont le sourceQuery est `find dead pick id` sans stage where — donc
		// bulk_copy_insert warn attendu (règle D6 séparée).
		const findings = analyze(
			"let dead = find users where inactive = true pick id; add (find dead pick id) into archive"
		);
		// Le body est un insert-select sans where dans sourceQuery → bulk_copy.
		expect(findings).toHaveLength(1);
		expect(findings[0]?.kind).toBe("bulk_copy_insert");
	});
});

describe("collectUnfilteredWrites — limites documentées", () => {
	it("where 1 = 1 (predicate tautologique) = 0 finding (user assume)", () => {
		expect(analyze("remove from users where 1 = 1")).toHaveLength(0);
	});
});

describe("hasAnyUnfilteredWrite — utilitaire boolean", () => {
	it("true sur unfiltered", () => {
		expect(hasAnyUnfilteredWrite(parse(tokenize("remove from users")))).toBe(
			true
		);
	});

	it("false sur filtered", () => {
		expect(
			hasAnyUnfilteredWrite(parse(tokenize("remove from users where id = 1")))
		).toBe(false);
	});

	it("false sur select", () => {
		expect(
			hasAnyUnfilteredWrite(parse(tokenize("find users pick id")))
		).toBe(false);
	});

	it("true sur raw (D1)", () => {
		expect(
			hasAnyUnfilteredWrite(parse(tokenize('raw "select 1"')))
		).toBe(true);
	});

	it("true sur bulk-copy (D6)", () => {
		expect(
			hasAnyUnfilteredWrite(parse(tokenize("add (find users pick id) into archive")))
		).toBe(true);
	});
});

describe("collectUnfilteredWrites — DDL drop ref (ADR-031 FK/3, D7)", () => {
	it("drop ref = destructive_drop, target = nom de la FK (retapé au gate)", () => {
		const findings = analyze("drop ref fk_orders_user_id_users from orders");
		expect(findings).toHaveLength(1);
		expect(findings[0]?.kind).toBe("destructive_drop");
		expect(findings[0]?.verb).toBe("drop");
		expect(findings[0]?.target).toBe("fk_orders_user_id_users");
	});

	it("drop ref if exists reste gaté (le modifier n'exempte pas du D7)", () => {
		expect(
			analyze("drop ref fk_orders_user_id_users from orders if exists")
		).toHaveLength(1);
	});
});
