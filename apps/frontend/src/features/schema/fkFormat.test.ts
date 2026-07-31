import { describe, expect, it } from "vitest";
import {
	formatColumns,
	formatHeader,
	formatKind,
	formatOrigin,
	humanFooter,
	humanOrigin,
	humanRelation,
	joinPreview
} from "./fkFormat";
import type { Relation } from "./schema-model";

describe("formatColumns", () => {
	it("single field → collection.field", () => {
		expect(
			formatColumns({ collection: "orders", fields: ["user_id"] })
		).toBe("orders.user_id");
	});

	it("composite fields → tous listés séparés par virgule", () => {
		expect(
			formatColumns({ collection: "membership", fields: ["user_id", "team_id"] })
		).toBe("membership.user_id, membership.team_id");
	});
});

describe("formatKind", () => {
	it("many-to-one → N:1", () => {
		expect(formatKind("many-to-one")).toBe("N:1");
	});
	it("one-to-many → 1:N", () => {
		expect(formatKind("one-to-many")).toBe("1:N");
	});
	it("one-to-one → 1:1", () => {
		expect(formatKind("one-to-one")).toBe("1:1");
	});
});

describe("formatOrigin", () => {
	it("foreign-key → FK déclarée", () => {
		expect(formatOrigin("foreign-key")).toBe("FK déclarée");
	});
	it("naming-heuristic → inférée (nommage)", () => {
		expect(formatOrigin("naming-heuristic")).toBe("inférée (nommage)");
	});
	it("ai → inférée (IA)", () => {
		expect(formatOrigin("ai")).toBe("inférée (IA)");
	});
	it("user → user", () => {
		expect(formatOrigin("user")).toBe("user");
	});
});

describe("joinPreview", () => {
	it("single field → JOIN target ON from.a = target.b", () => {
		const sql = joinPreview(
			{ collection: "orders", fields: ["user_id"] },
			{ collection: "users", fields: ["id"] }
		);
		expect(sql).toBe("JOIN users ON orders.user_id = users.id");
	});

	it("composite fields → conditions ANDées", () => {
		const sql = joinPreview(
			{ collection: "membership", fields: ["user_id", "team_id"] },
			{ collection: "roles", fields: ["uid", "tid"] }
		);
		expect(sql).toBe(
			"JOIN roles ON membership.user_id = roles.uid AND membership.team_id = roles.tid"
		);
	});

	it("mismatch de longueur : tombe sur to.fields[0] (fallback tolérant)", () => {
		const sql = joinPreview(
			{ collection: "a", fields: ["x", "y"] },
			{ collection: "b", fields: ["id"] }
		);
		expect(sql).toBe("JOIN b ON a.x = b.id AND a.y = b.id");
	});
});

describe("formatHeader", () => {
	const base: Omit<Relation, "kind" | "origin" | "confidence"> = {
		from: { collection: "orders", fields: ["user_id"] },
		to: { collection: "users", fields: ["id"] }
	};

	it("FK déclarée (confidence 1) → kind · origine, sans %", () => {
		expect(
			formatHeader({
				...base,
				kind: "many-to-one",
				origin: "foreign-key",
				confidence: 1
			})
		).toBe("N:1 · FK déclarée");
	});

	it("inférée nommage confidence 0.6 → montre le %", () => {
		expect(
			formatHeader({
				...base,
				kind: "many-to-one",
				origin: "naming-heuristic",
				confidence: 0.6
			})
		).toBe("N:1 · inférée (nommage) · 60%");
	});

	it("inférée confidence 1 → pas de % (trivial)", () => {
		expect(
			formatHeader({
				...base,
				kind: "one-to-many",
				origin: "ai",
				confidence: 1
			})
		).toBe("1:N · inférée (IA)");
	});
});

describe("humanRelation", () => {
	const base = {
		from: { collection: "order_items", fields: ["order_id"] },
		to: { collection: "orders", fields: ["id"] },
		origin: "foreign-key" as const,
		confidence: 1
	};

	it("many-to-one → « Chaque {from} appartient à un {to} »", () => {
		expect(humanRelation({ ...base, kind: "many-to-one" })).toEqual({
			prefix: "Chaque ",
			from: "order_items",
			middle: " appartient à un ",
			to: "orders"
		});
	});

	it("one-to-many → « Un {from} a plusieurs {to} »", () => {
		expect(humanRelation({ ...base, kind: "one-to-many" })).toEqual({
			prefix: "Un ",
			from: "order_items",
			middle: " a plusieurs ",
			to: "orders"
		});
	});

	it("one-to-one → « Un {from} correspond à un {to} »", () => {
		expect(humanRelation({ ...base, kind: "one-to-one" })).toEqual({
			prefix: "Un ",
			from: "order_items",
			middle: " correspond à un ",
			to: "orders"
		});
	});
});

describe("humanOrigin", () => {
	it("foreign-key → relation déclarée", () => {
		expect(humanOrigin("foreign-key")).toBe("relation déclarée");
	});
	it("naming-heuristic → détectée par nommage", () => {
		expect(humanOrigin("naming-heuristic")).toBe("détectée par nommage");
	});
	it("ai → détectée par IA", () => {
		expect(humanOrigin("ai")).toBe("détectée par IA");
	});
	it("user → définie manuellement", () => {
		expect(humanOrigin("user")).toBe("définie manuellement");
	});
});

describe("humanFooter", () => {
	const base = {
		from: { collection: "orders", fields: ["user_id"] },
		to: { collection: "users", fields: ["id"] },
		kind: "many-to-one" as const
	};

	it("FK déclarée → « via {col} · relation déclarée » (pas de %)", () => {
		expect(
			humanFooter({ ...base, origin: "foreign-key", confidence: 1 })
		).toBe("via user_id · relation déclarée");
	});

	it("inférée nommage confidence 0.6 → ajoute « certitude 60% »", () => {
		expect(
			humanFooter({ ...base, origin: "naming-heuristic", confidence: 0.6 })
		).toBe("via user_id · détectée par nommage · certitude 60%");
	});

	it("composite : liste les colonnes séparées par virgule", () => {
		expect(
			humanFooter({
				from: { collection: "membership", fields: ["user_id", "team_id"] },
				to: { collection: "roles", fields: ["uid", "tid"] },
				kind: "many-to-one",
				origin: "foreign-key",
				confidence: 1
			})
		).toBe("via user_id, team_id · relation déclarée");
	});

	it("inférée confidence 1 → pas de certitude (trivial)", () => {
		expect(
			humanFooter({ ...base, origin: "ai", confidence: 1 })
		).toBe("via user_id · détectée par IA");
	});
});
