import { describe, expect, it } from "vitest";
import { tokenize } from "./lexer";

describe("lexer", () => {
	it("tokenise un pipeline simple", () => {
		const kinds = tokenize("get users | limit 10").map((t) => t.kind);
		expect(kinds).toEqual([
			"verb",
			"ident",
			"pipe",
			"keyword",
			"number",
			"eof"
		]);
	});

	it("reconnaît opérateurs et chaînes", () => {
		const toks = tokenize(`where name = "bob"`).map((t) => [t.kind, t.value]);
		expect(toks).toEqual([
			["keyword", "where"],
			["ident", "name"],
			["op", "="],
			["string", "bob"],
			["eof", ""]
		]);
	});

	it("garde la casse des identifiants mais normalise verbes/mots-clés", () => {
		const toks = tokenize("GET Users");
		expect(toks[0]).toMatchObject({ kind: "verb", value: "get" });
		expect(toks[1]).toMatchObject({ kind: "ident", value: "Users" });
	});

	it("distingue le point de chemin du point décimal", () => {
		expect(tokenize("a.b").map((t) => t.kind)).toEqual([
			"ident",
			"dot",
			"ident",
			"eof"
		]);
		expect(tokenize("3.14").map((t) => [t.kind, t.value])).toEqual([
			["number", "3.14"],
			["eof", ""]
		]);
	});

	it("gère les opérateurs à deux caractères", () => {
		expect(tokenize("a >= b != c <= d").map((t) => t.value)).toEqual([
			"a",
			">=",
			"b",
			"!=",
			"c",
			"<=",
			"d",
			""
		]);
	});

	it("ignore les commentaires '#'", () => {
		const kinds = tokenize(
			"get users # ceci est un commentaire\n| limit 1"
		).map((t) => t.kind);
		expect(kinds).toEqual([
			"verb",
			"ident",
			"pipe",
			"keyword",
			"number",
			"eof"
		]);
	});
});
