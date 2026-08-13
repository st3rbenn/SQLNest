import { describe, expect, it } from "vitest";
import { SnqlError } from "../diagnostics";
import { lower, lowerMutation, tokenize } from "../index";
import { parse } from "../parser/parser";
import {
	KV_CAPABILITIES,
	MONGODB_CAPABILITIES,
	POSTGRES_CAPABILITIES
} from "./capabilities";
import { assertMutationCastTargetsSupported, plan } from "./planner";

function planFor(source: string, engine: "postgres" | "mongodb" | "kv") {
	const stmt = parse(tokenize(source));
	if (stmt.operation !== "select") throw new Error("select attendu");
	const caps =
		engine === "postgres"
			? POSTGRES_CAPABILITIES
			: engine === "mongodb"
				? MONGODB_CAPABILITIES
				: KV_CAPABILITIES;
	return plan(lower(stmt), caps);
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

describe("planner cast — capability check castTargets", () => {
	for (const t of [
		"int",
		"float",
		"text",
		"bool",
		"date",
		"timestamp",
		"json"
	]) {
		it(`cast(_ as ${t}) OK sur postgres`, () => {
			expect(() =>
				planFor(`get t pick cast(x as ${t}) as y`, "postgres")
			).not.toThrow();
		});
	}

	it("cast(_ as json) sur mongodb → planner_cast_target_unsupported (message dédié)", () => {
		try {
			planFor("get t pick cast(x as json) as y", "mongodb");
			throw new Error("SnqlError attendu");
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.code).toBe("planner_cast_target_unsupported");
			expect(e.message).toContain("BSON");
		}
	});

	it("cast(_ as date) sur kv → planner_cast_target_unsupported", () => {
		expectCode(
			() => planFor("get t pick cast(x as date) as y", "kv"),
			"planner_cast_target_unsupported"
		);
	});

	it("cast(_ as int) sur kv → OK (scalaires primitifs supportés)", () => {
		expect(() =>
			planFor("get t pick cast(x as int) as y", "kv")
		).not.toThrow();
	});

	it("cast profondément imbriqué visite chaque target", () => {
		// cast(_ as json) est profond, doit remonter la première erreur
		expectCode(
			() =>
				planFor(
					"get t pick cast(cast(x as text) as json) as y",
					"mongodb"
				),
			"planner_cast_target_unsupported"
		);
	});

	it("cast qui contient un call visite aussi les fonctions", () => {
		// upper() supporté partout — pas d'erreur.
		expect(() =>
			planFor("get t pick cast(upper(x) as text) as y", "mongodb")
		).not.toThrow();
	});
});

describe("planner cast — mutations", () => {
	it("update SET value = cast(_ as json) sur mongodb → planner_cast_target_unsupported", () => {
		const stmt = parse(
			tokenize("update t where id = 1 set y = cast(x as json)")
		);
		if (stmt.operation !== "update") throw new Error("update attendu");
		expectCode(
			() =>
				assertMutationCastTargetsSupported(
					lowerMutation(stmt),
					MONGODB_CAPABILITIES
				),
			"planner_cast_target_unsupported"
		);
	});

	it("update WHERE cast(_ as timestamp) sur kv → refusé (kv sans timestamp)", () => {
		const stmt = parse(
			tokenize("update t where cast(ts as timestamp) > 0 set y = 1")
		);
		if (stmt.operation !== "update") throw new Error("update attendu");
		expectCode(
			() =>
				assertMutationCastTargetsSupported(
					lowerMutation(stmt),
					KV_CAPABILITIES
				),
			"planner_cast_target_unsupported"
		);
	});

	it("delete WHERE cast(_ as text) sur postgres → OK", () => {
		const stmt = parse(tokenize("remove from t where cast(x as text) = \"foo\""));
		if (stmt.operation !== "delete") throw new Error("delete attendu");
		expect(() =>
			assertMutationCastTargetsSupported(
				lowerMutation(stmt),
				POSTGRES_CAPABILITIES
			)
		).not.toThrow();
	});
});
