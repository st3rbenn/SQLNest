/**
 * PM/10 D8 — Tests unit du walker divergenceHints.
 *
 * Vérifie que collectDivergenceHints émet un hint pour chaque pattern
 * divergent PG↔Mongo listé dans le registre `divergences-mongo-vs-pg`.
 * Le hook `useLiveDiagnostics` filtre par engine (Mongo only) en amont —
 * ici on teste seulement l'extraction AST, pas le filtrage.
 */

import { describe, expect, it } from "vitest";
import { parse, tokenize } from "@sqlnest/snql";
import { collectDivergenceHints } from "./divergenceHints";

function hintsFor(source: string): readonly { code: string; message: string }[] {
	const stmt = parse(tokenize(source));
	return collectDivergenceHints(stmt).map((h) => ({
		code: h.code,
		message: h.message
	}));
}

describe("collectDivergenceHints — patterns divergents PG↔Mongo", () => {
	it("concat(a, b) → hint concat_null_parity", () => {
		const hints = hintsFor(`find users pick concat(first_name, " ", last_name) as full`);
		expect(hints).toHaveLength(1);
		expect(hints[0]?.code).toBe("concat_null_parity");
	});

	it("cast(x as bool) → hint cast_bool_truthy", () => {
		const hints = hintsFor(`find users pick cast(active as bool) as b`);
		expect(hints).toHaveLength(1);
		expect(hints[0]?.code).toBe("cast_bool_truthy");
	});

	it("cast(x as date) → hint cast_date_timestamp_collapse", () => {
		const hints = hintsFor(`find users pick cast(created_at as date) as d`);
		expect(hints).toHaveLength(1);
		expect(hints[0]?.code).toBe("cast_date_timestamp_collapse");
	});

	it("!= dans un compare → hint not_equal_null_aware", () => {
		const hints = hintsFor(`remove from users where email != "spam"`);
		expect(hints).toHaveLength(1);
		expect(hints[0]?.code).toBe("not_equal_null_aware");
	});

	it("json_contains(a, b) → hint json_contains_nested", () => {
		const hints = hintsFor(
			`find users where json_contains(meta, {archived: true}) = true pick id`
		);
		expect(hints[0]?.code).toBe("json_contains_nested");
	});

	it("aucun pattern → aucun hint", () => {
		const hints = hintsFor(`find users where id = 1 pick id, name`);
		expect(hints).toHaveLength(0);
	});

	it("cast(_ as int) : pas de divergence (pas de hint)", () => {
		const hints = hintsFor(`find users pick cast(age as int) as a`);
		expect(hints).toHaveLength(0);
	});

	it("plusieurs patterns : chaque construct produit son hint (ordre AST)", () => {
		const hints = hintsFor(
			`find users where email != "x" pick concat(first_name, " ", last_name) as full`
		);
		expect(hints.length).toBeGreaterThanOrEqual(2);
		const codes = hints.map((h) => h.code);
		expect(codes).toContain("not_equal_null_aware");
		expect(codes).toContain("concat_null_parity");
	});

	it("walker traverse le body transaction", () => {
		const hints = hintsFor(
			`transaction { update users where email != "x" set active = false }`
		);
		expect(hints.some((h) => h.code === "not_equal_null_aware")).toBe(true);
	});

	it("walker traverse le body savepoint", () => {
		const hints = hintsFor(
			`transaction { savepoint sp1 { update users where email != "x" set active = false } }`
		);
		expect(hints.some((h) => h.code === "not_equal_null_aware")).toBe(true);
	});

	it("walker traverse les bindings let", () => {
		const hints = hintsFor(
			`let active = find users where email != "x" pick id; find active pick id`
		);
		expect(hints.some((h) => h.code === "not_equal_null_aware")).toBe(true);
	});
});
