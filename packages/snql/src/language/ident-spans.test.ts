import { describe, expect, it } from "vitest";
import { parse } from "../parser/parser";
import { tokenize } from "../lexer/lexer";
import { collectIdentSpans } from "./ident-spans";
import type { SerializedSpan } from "../codegen/mapper";

function spansOf(source: string): Record<string, readonly SerializedSpan[]> {
	return collectIdentSpans(parse(tokenize(source)));
}

function textOf(source: string, span: SerializedSpan): string {
	return source.slice(span[0], span[0] + span[1]);
}

describe("collectIdentSpans", () => {
	it("SELECT — collecte collection, colonnes projetées, colonnes WHERE", () => {
		const source = `get users where age > 18 pick name, email`;
		const spans = spansOf(source);
		// La table `users`
		expect(spans.users).toBeDefined();
		expect(textOf(source, spans.users?.[0] as SerializedSpan)).toBe("users");
		// Colonnes
		expect(spans.age).toBeDefined();
		expect(spans.name).toBeDefined();
		expect(spans.email).toBeDefined();
	});

	it("alias + path — chaque segment est collecté sous son propre nom", () => {
		const source = `get users as u where u.age >= 18 pick u.name`;
		const spans = spansOf(source);
		// L'alias `u` apparaît 3 fois (source.alias + 2 dans les paths)
		expect(spans.u?.length).toBe(3);
		// La colonne `name` apparaît une fois via `pick u.name`
		expect(spans.name?.length).toBe(1);
		// Chaque span pointe bien sur son path source
		const nameSpan = spans.name?.[0] as SerializedSpan;
		expect(textOf(source, nameSpan)).toBe("u.name");
	});

	it("liste IN — collecte toutes les valeurs référencées comme champs", () => {
		const source = `get t where role in ["a", "b"]`;
		const spans = spansOf(source);
		expect(spans.role).toBeDefined();
		expect(spans.t).toBeDefined();
	});

	it("occurrences multiples — collecte tous les spans sous le même nom", () => {
		const source = `get t where a > 10 and a < 20 pick a`;
		const spans = spansOf(source);
		expect(spans.a?.length).toBe(3);
	});

	it("INSERT — collecte table + colonnes du batch", () => {
		const source = `add [{a: 1, b: 2}, {a: 3, b: 4}] into t`;
		const spans = spansOf(source);
		expect(spans.t).toBeDefined();
		expect(spans.a?.length).toBe(2);
		expect(spans.b?.length).toBe(2);
	});

	it("UPDATE — collecte table + colonnes SET + colonnes WHERE", () => {
		const source = `update users where id = 7 set status = "x", is_active = false`;
		const spans = spansOf(source);
		expect(spans.users).toBeDefined();
		expect(spans.id).toBeDefined();
		expect(spans.status).toBeDefined();
		expect(spans.is_active).toBeDefined();
	});

	it("DELETE — collecte table + colonnes WHERE", () => {
		const source = `remove from users where age < 18`;
		const spans = spansOf(source);
		expect(spans.users).toBeDefined();
		expect(spans.age).toBeDefined();
	});

	it("statement sans idents référencables — map vide", () => {
		const source = `get t`;
		const spans = spansOf(source);
		// Seule `t` est collectée
		expect(Object.keys(spans)).toEqual(["t"]);
	});
});
