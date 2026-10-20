import { parse, tokenize } from "@sqlnest/snql";
import { describe, expect, it } from "vitest";
import { ddlImpactHint } from "./ddlImpactHints";

const hint = (source: string) => ddlImpactHint(parse(tokenize(source)));

describe("ddlImpactHint (ADR-036 D7)", () => {
	it("rename column : rappelle l'ancien et le nouveau nom, sur tout le statement", () => {
		const source = "rename column agency.phone to mobile";
		expect(hint(source)).toEqual({
			span: [0, source.length],
			code: "ddl_rename_column_impact",
			message:
				"Les requêtes et le code qui utilisent 'agency.phone' devront passer à 'mobile'."
		});
	});

	it("rien pour un DDL additif ni pour une lecture", () => {
		expect(hint("add column website text nullable into agency")).toBeNull();
		expect(hint("get agency")).toBeNull();
	});
});
