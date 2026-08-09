import { describe, expect, it } from "vitest";
import { tokenize } from "../lexer/lexer";
import type { Query } from "./ast";
import { parse } from "./parser";

function ast(source: string): Query {
	return parse(tokenize(source));
}

describe("parser", () => {
	it("parse verbe + source + étapes", () => {
		const q = ast("get users where age > 30 limit 5");
		expect(q).toMatchObject({
			operation: "select",
			verb: "get",
			source: { collection: "users" },
			stages: [{ type: "where" }, { type: "limit", count: 5 }]
		});
	});

	it("collapse l'alias `find` vers 'select'", () => {
		expect(ast("find users").operation).toBe("select");
	});

	it("'and' lie plus fort que 'or'", () => {
		const q = ast("get u where a = 1 or b = 2 and c = 3");
		expect(q.stages[0]).toMatchObject({
			type: "where",
			predicate: {
				type: "logical",
				operator: "or",
				left: { type: "compare" },
				right: { type: "logical", operator: "and" }
			}
		});
	});

	it("parenthèses forcent la précédence", () => {
		const q = ast("get u where (a = 1 or b = 2) and c = 3");
		expect(q.stages[0]).toMatchObject({
			type: "where",
			predicate: {
				type: "logical",
				operator: "and",
				left: { type: "logical", operator: "or" }
			}
		});
	});

	it("parse alias, chemins pointés et 'in'", () => {
		const q = ast(
			`get users as u where u.role in ["admin", "mod"] pick u.name as n`
		);
		expect(q.source).toMatchObject({ collection: "users", alias: "u" });
		expect(q.stages[0]).toMatchObject({
			type: "where",
			predicate: { type: "in", target: { type: "field", path: ["u", "role"] } }
		});
		expect(q.stages[1]).toMatchObject({
			type: "pick",
			fields: [{ path: ["u", "name"], alias: "n" }]
		});
	});

	it("rejette une requête sans verbe", () => {
		expect(() => ast("users limit 1")).toThrow(/verbe/i);
	});

	it("rejette un mot inattendu après la source", () => {
		expect(() => ast("get users frobnicate 1")).toThrow();
	});

	it("rejette un stage hors ordre canonique (limit avant sort)", () => {
		expect(() => ast("get users limit 5 sort age")).toThrow(/hors ordre/i);
	});

	it("parse plusieurs joins chaînés par `and`", () => {
		const q = ast(
			"get users with addresses on id = user_id and orders on id = user_id"
		);
		expect(q.stages).toHaveLength(2);
		expect(q.stages[0]).toMatchObject({
			type: "with",
			collection: "addresses"
		});
		expect(q.stages[1]).toMatchObject({ type: "with", collection: "orders" });
	});

	it("accepte 'constructor'/'__proto__' comme identifiants (bug G, prototype)", () => {
		expect(ast("get constructor").source).toMatchObject({
			collection: "constructor"
		});
		expect(ast("get __proto__").source).toMatchObject({
			collection: "__proto__"
		});
	});

	it("parse un littéral numérique négatif (bug D)", () => {
		const q = ast("get users where balance = -50");
		expect(q.stages[0]).toMatchObject({
			type: "where",
			predicate: {
				type: "compare",
				operator: "=",
				right: { type: "literal", value: { kind: "number", raw: "-50" } }
			}
		});
	});

	it("parse un join 'with … on … = …'", () => {
		const q = ast("get users with orders on id = user_id");
		expect(q.stages[0]).toMatchObject({
			type: "with",
			collection: "orders",
			localField: ["id"],
			foreignField: ["user_id"]
		});
	});

	it("parse un join avec alias", () => {
		expect(
			ast("get users with orders as cmds on id = user_id").stages[0]
		).toMatchObject({ type: "with", collection: "orders", alias: "cmds" });
	});

	it("rejette un 'with' sans 'on'", () => {
		expect(() => ast("get users with orders")).toThrow(/on/i);
	});
});
