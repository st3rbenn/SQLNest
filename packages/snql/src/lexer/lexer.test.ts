import { describe, expect, it } from "vitest";
import { tokenize } from "./lexer";

describe("lexer", () => {
	it("tokenise une requête simple sans séparateur", () => {
		const kinds = tokenize("get users limit 10").map((t) => t.kind);
		expect(kinds).toEqual(["verb", "ident", "keyword", "number", "eof"]);
	});

	it("rejette le pipe '|' avec un message de migration", () => {
		expect(() => tokenize("get users | limit 10")).toThrow(
			/ne sépare plus/i
		);
	});

	it("normalise `take` en `limit` (alias)", () => {
		const toks = tokenize("get users take 5");
		expect(toks[2]).toMatchObject({ kind: "keyword", value: "limit" });
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
			"get users # ceci est un commentaire\nlimit 1"
		).map((t) => t.kind);
		expect(kinds).toEqual(["verb", "ident", "keyword", "number", "eof"]);
	});
});
