import type { SchemaModel as SnqlSchemaModel } from "@sqlnest/snql";
import { describe, expect, it } from "vitest";
import type { SchemaModel } from "../schema-model";
import { previewChange } from "./changePreview";
import { addColumnSnql } from "./changeSnql";
import { canApply, editModeOf, managingOrm } from "./editMode";

const collection = (name: string) => ({
	name,
	source: "declared" as const,
	primaryKey: ["id"],
	fields: [
		{
			name: "id",
			type: "int" as const,
			nullable: false,
			source: "declared" as const
		}
	]
});

const schema = (...names: string[]): SchemaModel => ({
	engine: "postgres",
	collections: names.map(collection),
	relations: []
});

describe("editModeOf (ADR-039 D1)", () => {
	it("projet relié : migrations, même sans table d'historique (Prisma sous MongoDB)", () => {
		expect(
			editModeOf(schema("agency"), {
				data: {
					linked: true,
					orm: "prisma",
					apply: true,
					projectFound: true,
					migrations: false
				}
			})
		).toEqual({ kind: "migrations", orm: "prisma", apply: true });
		expect(
			editModeOf(schema("agency"), {
				data: { linked: true, orm: "prisma", apply: false, projectFound: true }
			})
		).toEqual({ kind: "migrations", orm: "prisma", apply: false });
	});

	it("historique d'un ORM sans projet relié : bloqué ; dossier du projet disparu : bloqué", () => {
		expect(
			editModeOf(schema("agency", "_prisma_migrations"), {
				data: { linked: false }
			})
		).toEqual({
			kind: "blocked",
			orm: "prisma",
			reason: "unlinked"
		});
		// Le nom de la connexion côté CLI, celui de la commande qui relie le projet.
		expect(
			editModeOf(schema("agency", "_prisma_migrations"), {
				data: { connection: "e2x_legacy", linked: false }
			})
		).toMatchObject({ kind: "blocked", connection: "e2x_legacy" });
		expect(managingOrm(schema("SequelizeMeta"))).toBe("sequelize");
		expect(managingOrm(schema("sequelizemeta"))).toBe("sequelize");
		expect(
			editModeOf(schema("agency"), {
				data: { linked: true, orm: "prisma", apply: true, projectFound: false }
			})
		).toEqual({ kind: "blocked", orm: "prisma", reason: "project-missing" });
	});

	it("ni projet ni historique : direct ; statut pas encore lu ou illisible : rien ne part", () => {
		const direct = editModeOf(schema("agency"), { data: { linked: false } });
		expect(direct).toEqual({ kind: "direct" });
		expect(canApply(direct)).toBe(true);
		expect(canApply(editModeOf(schema("agency"), undefined))).toBe(false);
		expect(
			editModeOf(schema("agency"), { error: "Aucun tunnel disponible" })
		).toEqual({
			kind: "unavailable",
			message: "Aucun tunnel disponible"
		});
	});
});

describe("addColumnSnql (ADR-039 D2)", () => {
	it("nom, type, nullable et défaut, dans la syntaxe du parseur", () => {
		expect(
			addColumnSnql({
				table: "agency",
				name: " nickname ",
				type: "string",
				nullable: true,
				defaultExpr: ""
			})
		).toBe("add column nickname string nullable into agency");
		expect(
			addColumnSnql({
				table: "agency",
				name: "fee",
				type: "decimal",
				nullable: false,
				defaultExpr: " 1.5 "
			})
		).toBe("add column fee decimal default 1.5 into agency");
	});
});

describe("previewChange (ADR-039 D3)", () => {
	const pg = schema("agency") as unknown as SnqlSchemaModel;

	it("direct : le DDL du moteur ; migrations Prisma : le DDL du profil", () => {
		const src = "add column code string unique into agency";
		expect(previewChange(src, pg, { kind: "direct" }).statements).toEqual([
			'ALTER TABLE "agency" ADD COLUMN "code" text NOT NULL UNIQUE'
		]);
		expect(
			previewChange(src, pg, { kind: "migrations", orm: "prisma", apply: true })
				.statements
		).toEqual([
			'ALTER TABLE "agency" ADD COLUMN "code" text NOT NULL CONSTRAINT "agency_code_key" UNIQUE'
		]);
	});

	it("Mongo : l'opération ; SNQL invalide ou non DDL : l'erreur, rien à appliquer", () => {
		const mongo = { ...pg, engine: "mongodb" } as SnqlSchemaModel;
		const [op] = previewChange(
			"add column note string nullable into agency",
			mongo,
			{
				kind: "direct"
			}
		).statements;
		expect(JSON.parse(op ?? "{}")).toMatchObject({
			operation: "add-column",
			collection: "agency"
		});
		expect(
			previewChange("add column x nosuchtype into agency", pg, {
				kind: "direct"
			}).error
		).toMatch(/nosuchtype/);
		expect(previewChange("get agency", pg, { kind: "direct" }).error).toBe(
			"Un changement de schéma attend une instruction DDL"
		);
	});

	it("avertissement de casse applicative (ADR-036 D7)", () => {
		const withName = {
			...pg,
			collections: [
				{
					...collection("agency"),
					fields: [
						...collection("agency").fields,
						{
							name: "label",
							type: "string",
							nullable: false,
							source: "declared"
						}
					]
				}
			]
		} as SnqlSchemaModel;
		expect(
			previewChange("rename column agency.label to name", withName, {
				kind: "direct"
			}).warnings
		).toEqual([
			"Les requêtes et le code qui utilisent 'agency.label' devront passer à 'name'."
		]);
	});
});
