import { describe, expect, it } from "vitest";
import { planFor } from "../index";

describe("planner — pushdown vs compensation", () => {
	it("moteur complet (postgres) : tout est poussé", () => {
		const p = planFor(
			"get users where age > 30 sort created_at desc limit 5",
			"postgres"
		);
		expect(p.fullyPushed).toBe(true);
		expect(p.compensation).toEqual([]);
		expect(p.pushdown.op).toBe("limit");
	});

	it("KV (scan+filter) : sort et limit sont compensés", () => {
		const p = planFor(`get things where k = "x" sort v limit 5`, "kv");
		expect(p.fullyPushed).toBe(false);
		expect(p.pushdown.op).toBe("filter"); // scan + filter poussés
		expect(p.compensation.map((o) => o.op)).toEqual(["sort", "limit"]);
	});

	it("mode reject : lève une erreur typée au lieu de compenser", () => {
		expect(() =>
			planFor("get things sort v", "kv", { onUnsupported: "reject" })
		).toThrow(/reject|poussable/i);
	});

	it("scan seul sur KV : entièrement poussé", () => {
		const p = planFor("get things", "kv");
		expect(p.fullyPushed).toBe(true);
		expect(p.pushdown.op).toBe("scan");
	});

	it("moteur inconnu → erreur", () => {
		expect(() => planFor("get things", "redis-cluster-9000")).toThrow(
			/inconnu/i
		);
	});
});
