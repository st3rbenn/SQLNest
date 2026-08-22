import { parse, tokenize } from "@sqlnest/snql";
import { describe, expect, it } from "vitest";
import { buildPreviewCountSource } from "./previewCountRewrite";

/**
 * Tests du rewrite `pick count(*) as _preview_count`. Chaque rewrite est
 * validé en le re-parsant — si le résultat n'est PAS un SNQL valide select
 * avec pick count(*) as _preview_count, le test échoue (garantit qu'aucun
 * rewrite ne produit une source cassée qui reviendrait comme parse error
 * du CLI).
 */

function rewrite(src: string) {
	return buildPreviewCountSource(src, parse(tokenize(src)));
}

/** Assure que le rewrite est du SNQL valide qui parse en un select et
 * termine bien par un stage pick count(*) as _preview_count. */
function assertValidSelect(source: string): void {
	const stmt = parse(tokenize(source));
	expect(stmt.operation).toBe("select");
	if (stmt.operation !== "select") return;
	const last = stmt.stages[stmt.stages.length - 1];
	expect(last?.type).toBe("pick");
	if (last?.type !== "pick") return;
	const first = last.fields[0];
	expect(first?.alias).toBe("_preview_count");
}

describe("buildPreviewCountSource — delete", () => {
	it("remove from t (unfiltered) → find t pick count(*) as _preview_count", () => {
		const r = rewrite("remove from users");
		expect(r?.source).toBe("find users pick count(*) as _preview_count");
		expect(r?.note).toBeUndefined();
		assertValidSelect(r!.source);
	});

	it("remove from t where P → find t where P pick count(*) as _preview_count", () => {
		const r = rewrite("remove from users where id = 42");
		expect(r?.source).toBe("find users where id = 42 pick count(*) as _preview_count");
		assertValidSelect(r!.source);
	});

	it("remove from t where <predicate complexe> préserve byte-perfect", () => {
		const r = rewrite("remove from orders where status = 'shipped' and total > 100");
		expect(r?.source).toBe(
			"find orders where status = 'shipped' and total > 100 pick count(*) as _preview_count"
		);
		assertValidSelect(r!.source);
	});
});

describe("buildPreviewCountSource — update", () => {
	it("update t set c = v (unfiltered) → find t pick count(*) as _preview_count", () => {
		const r = rewrite("update users set active = false");
		expect(r?.source).toBe("find users pick count(*) as _preview_count");
		expect(r?.note).toBeUndefined();
		assertValidSelect(r!.source);
	});

	it("update t where P set c = v → find t where P pick count(*) as _preview_count", () => {
		const r = rewrite("update users where id = 42 set active = false");
		expect(r?.source).toBe("find users where id = 42 pick count(*) as _preview_count");
		assertValidSelect(r!.source);
	});

	it("update t as a where P set c = v → find t as a where P pick count(*) as _preview_count", () => {
		const r = rewrite("update users as u where u.id = 42 set active = false");
		expect(r?.source).toBe("find users as u where u.id = 42 pick count(*) as _preview_count");
		assertValidSelect(r!.source);
	});

	it("update t with one X on l=f set c = v → find t with one X on l=f pick count(*) as _preview_count + note join", () => {
		const r = rewrite(
			"update orders with one users as u on user_id = u.id set discount = 0.1"
		);
		expect(r?.source).toBe(
			"find orders with one users as u on user_id = u.id pick count(*) as _preview_count"
		);
		expect(r?.note).toContain("join");
		assertValidSelect(r!.source);
	});

	it("update t as o with one X where P set c = v → préserve alias + joins + predicate", () => {
		const r = rewrite(
			"update orders as o with one users as u on o.user_id = u.id where u.premium = true set discount = 0.2"
		);
		expect(r?.source).toBe(
			"find orders as o with one users as u on o.user_id = u.id where u.premium = true pick count(*) as _preview_count"
		);
		expect(r?.note).toContain("join");
		assertValidSelect(r!.source);
	});
});

describe("buildPreviewCountSource — insert-select", () => {
	it("add (find X pick id) into t → find X pick count(*) as _preview_count", () => {
		const r = rewrite("add (find users pick id) into archive");
		expect(r?.source).toBe("find users pick count(*) as _preview_count");
		assertValidSelect(r!.source);
	});

	it("add (find X where P pick id) into t → find X where P pick count(*) as _preview_count", () => {
		const r = rewrite(
			"add (find users where inactive = true pick id, email) into archive"
		);
		expect(r?.source).toBe("find users where inactive = true pick count(*) as _preview_count");
		assertValidSelect(r!.source);
	});

	it("add (find X where P pick id sort id) into t → replace pick EN PLACE (préserve ordre where → pick → sort)", () => {
		// Ordre grammatical SNQL : where → pick → sort → limit. Le rewrite
		// remplace le pick EN PLACE pour préserver cet ordre — pas d'append à
		// la fin qui produirait `sort id pick count(*)` invalide.
		const r = rewrite(
			"add (find users where inactive = true pick id sort id) into archive"
		);
		expect(r?.source).toBe(
			"find users where inactive = true pick count(*) as _preview_count sort id"
		);
		// pick est bien présent mais pas en dernière position ici (sort suit) —
		// on doit chercher le stage `pick`, pas prendre le dernier.
		const stmt = parse(tokenize(r!.source));
		expect(stmt.operation).toBe("select");
		if (stmt.operation !== "select") return;
		const pickStage = stmt.stages.find((s) => s.type === "pick");
		expect(pickStage?.type).toBe("pick");
		if (pickStage?.type !== "pick") return;
		expect(pickStage.fields[0]?.alias).toBe("_preview_count");
	});
});

describe("buildPreviewCountSource — cas non-supportés (null)", () => {
	it("insert-values (documents literal) → null (count trivial hors rewrite)", () => {
		const r = rewrite("add {id: 1, name: 'x'} into t");
		expect(r).toBeNull();
	});

	it("upsert on conflict → null (imprévisible insert vs update)", () => {
		const r = rewrite(
			"add {id: 1, x: 5} into t on conflict (id) edit set x = new.x"
		);
		expect(r).toBeNull();
	});

	it("raw SQL → null (payload opaque)", () => {
		const r = rewrite('raw "DELETE FROM users"');
		expect(r).toBeNull();
	});

	it("raw Mongo → null", () => {
		const r = rewrite('raw {aggregate: "users", pipeline: []}');
		expect(r).toBeNull();
	});

	it("select → null (rien à prévisualiser, pas un write)", () => {
		const r = rewrite("find users pick id");
		expect(r).toBeNull();
	});

	it("transaction { ... } → null (v1 punt multi-stmt)", () => {
		const r = rewrite("transaction { remove from users; }");
		expect(r).toBeNull();
	});

	it("let x = ...; update = null (v1 punt let)", () => {
		const r = rewrite(
			"let x = find users pick id; update users set active = false"
		);
		expect(r).toBeNull();
	});
});
