/**
 * PM/10 D9 — Tests unit du walker perfHints.
 *
 * Vérifie que collectPerfHints émet un hint pour chaque pattern SNQL non-
 * indexable côté Mongo. Le hook `useLiveDiagnostics` filtre par engine
 * (Mongo only) en amont — ici on teste seulement l'extraction AST.
 */

import { describe, expect, it } from "vitest";
import { parse, tokenize } from "@sqlnest/snql";
import { collectPerfHints } from "./perfHints";

function hintsFor(source: string): readonly { code: string; message: string }[] {
	const stmt = parse(tokenize(source));
	return collectPerfHints(stmt).map((h) => ({
		code: h.code,
		message: h.message
	}));
}

describe("collectPerfHints — patterns non-indexables Mongo", () => {
	it("cast dans predicate update → hint perf_non_indexable_cast_write", () => {
		const hints = hintsFor(
			`update track where cast(track_id as text) = "42" set milliseconds = 0`
		);
		expect(hints).toHaveLength(1);
		expect(hints[0]?.code).toBe("planner_mongo_perf_non_indexable_cast_write");
		expect(hints[0]?.message).toMatch(/perf/i);
	});

	it("cast dans predicate remove → même hint", () => {
		const hints = hintsFor(
			`remove from track where cast(track_id as text) = "42"`
		);
		expect(hints[0]?.code).toBe("planner_mongo_perf_non_indexable_cast_write");
	});

	it("update sans cast dans where → aucun hint", () => {
		const hints = hintsFor(
			`update track where track_id = 1 set milliseconds = 0`
		);
		expect(hints).toHaveLength(0);
	});

	it("cast dans set assignment (pas predicate) → aucun hint", () => {
		// Cast dans set = pipeline update stage, indexation non pertinente (write op).
		const hints = hintsFor(
			`update track where track_id = 1 set milliseconds = cast(0 as int)`
		);
		expect(hints).toHaveLength(0);
	});

	it("exists corrélée → hint perf_non_indexable_correlated", () => {
		const hints = hintsFor(
			`find users as u where exists (find orders as o where o.user_id = u.id) pick u.id`
		);
		expect(hints[0]?.code).toBe(
			"planner_mongo_perf_non_indexable_correlated"
		);
		expect(hints[0]?.message).toMatch(/lookup|scan per outer/i);
	});

	it("exists uncorrelated → aucun hint", () => {
		const hints = hintsFor(
			`find users where exists (find orders) pick id`
		);
		expect(hints).toHaveLength(0);
	});

	it("in (subquery correlated) → hint correlated", () => {
		const hints = hintsFor(
			`find users as u where u.id in (find orders as o where o.total > u.age pick o.user_id) pick u.id`
		);
		expect(hints.some((h) => h.code === "planner_mongo_perf_non_indexable_correlated")).toBe(true);
	});

	it("select simple sans pattern perf → aucun hint", () => {
		const hints = hintsFor(`find users where id = 1 pick id, name`);
		expect(hints).toHaveLength(0);
	});
});
