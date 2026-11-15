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

	it("drop column : le code qui s'en sert casse, les valeurs sont perdues", () => {
		expect(hint("drop column phone from agency")?.message).toBe(
			"Les requêtes et le code qui utilisent 'agency.phone' échoueront ; ses valeurs seront perdues."
		);
	});

	it("drop ref : le code qui suit la relation casse, les valeurs ne sont plus contrôlées", () => {
		expect(hint("drop ref fk_orders_user from orders")?.message).toBe(
			"Le code qui suit la relation 'fk_orders_user' échouera ; plus rien ne contrôlera les valeurs de sa colonne."
		);
	});

	it("set type et set not null : rappellent l'effet sur le code et les écritures", () => {
		expect(hint("alter column agency.zip set type int")?.message).toBe(
			"Le code qui lit 'agency.zip' recevra des valeurs de type int."
		);
		expect(hint("alter column agency.zip set not null")?.message).toBe(
			"Les écritures qui laissent 'agency.zip' vide seront refusées."
		);
		expect(hint("alter column agency.zip set nullable")).toBeNull();
	});

	it("rien pour un DDL additif ni pour une lecture", () => {
		expect(hint("add column website text nullable into agency")).toBeNull();
		expect(hint("get agency")).toBeNull();
	});
});
