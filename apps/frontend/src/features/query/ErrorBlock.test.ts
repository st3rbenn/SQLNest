import { describe, expect, it } from "vitest";
import { parseErrorMessage } from "./ErrorBlock";

// L'em dash (U+2014) est notre séparateur canonique côté backend (helpers
// describePgExecutionError / describeMongoExecutionError). Le transformer de
// vitest refuse le glyphe littéral dans un .ts — on le construit via —.
const DASH = " — ";

describe("parseErrorMessage", () => {
	it("parse la forme canonique Postgres avec SQLSTATE + hint", () => {
		const raw = `Erreur côté CLI: operator does not exist: character varying = bigint${DASH}SQLSTATE 42883${DASH}hint: No operator matches the given name and argument types.`;
		expect(parseErrorMessage(raw)).toEqual({
			message: "operator does not exist: character varying = bigint",
			sqlstate: "42883",
			hint: "No operator matches the given name and argument types.",
			details: []
		});
	});

	it("parse la forme Postgres avec detail au milieu", () => {
		const raw = `Erreur côté CLI: duplicate key value violates unique constraint "users_email_key"${DASH}SQLSTATE 23505${DASH}Key (email)=(a@b.c) already exists.`;
		const parsed = parseErrorMessage(raw);
		expect(parsed.sqlstate).toBe("23505");
		expect(parsed.details).toEqual(["Key (email)=(a@b.c) already exists."]);
	});

	it("parse la forme MongoDB avec codeName", () => {
		const raw = `Erreur côté CLI: Exécution MongoDB échouée${DASH}unknown operator: $frobnicate${DASH}CommandFailed`;
		const parsed = parseErrorMessage(raw);
		expect(parsed.message).toBe("Exécution MongoDB échouée");
		expect(parsed.codeName).toBe("CommandFailed");
		expect(parsed.details).toEqual(["unknown operator: $frobnicate"]);
	});

	it("retombe sur le message brut si le format ne matche pas", () => {
		expect(parseErrorMessage("Timeout")).toEqual({
			message: "Timeout",
			details: []
		});
	});

	it("strip le préfixe 'Erreur côté serveur:' aussi", () => {
		expect(parseErrorMessage("Erreur côté serveur: Internal")).toEqual({
			message: "Internal",
			details: []
		});
	});

	it("SQLSTATE seul (sans hint) est capturé", () => {
		const parsed = parseErrorMessage(
			`Erreur côté CLI: relation "foo" does not exist${DASH}SQLSTATE 42P01`
		);
		expect(parsed.sqlstate).toBe("42P01");
		expect(parsed.hint).toBeUndefined();
		expect(parsed.details).toEqual([]);
	});

	it("un segment avec des espaces n'est pas confondu avec un codeName", () => {
		const parsed = parseErrorMessage(
			`Erreur côté CLI: something${DASH}Foo Bar Baz`
		);
		expect(parsed.codeName).toBeUndefined();
		expect(parsed.details).toEqual(["Foo Bar Baz"]);
	});

	it("input vide → message brut, pas d'undefined ni de crash", () => {
		expect(parseErrorMessage("")).toEqual({ message: "", details: [] });
	});
});
