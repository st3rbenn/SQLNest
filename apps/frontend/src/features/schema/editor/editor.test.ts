import type { SchemaModel as SnqlSchemaModel } from "@sqlnest/snql";
import { describe, expect, it } from "vitest";
import type { SchemaModel } from "../schema-model";
import { typedNames } from "./applyChange";
import { defaultRefRules, previewChange } from "./changePreview";
import {
	addColumnSnql,
	addEnumMemberSnql,
	addIndexSnql,
	addRefSnql,
	createEnumSnql,
	createTableSnql,
	dropRefSnql,
	dropTableSnql,
	dropColumnSnql,
	dropDefaultSnql,
	dropIndexSnql,
	renameColumnSnql,
	setDefaultSnql,
	setNullabilitySnql,
	setTypeSnql
} from "./changeSnql";
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

describe("gestes de colonne (ADR-039 D2)", () => {
	it("renommer, type, nullabilité, défaut, suppression, dans la syntaxe du parseur", () => {
		expect(renameColumnSnql("agency", "label", " name ")).toBe(
			"rename column agency.label to name"
		);
		expect(setTypeSnql("agency", "label", "int")).toBe(
			"alter column agency.label set type int"
		);
		expect(setNullabilitySnql("agency", "label", true)).toBe(
			"alter column agency.label set nullable"
		);
		expect(setNullabilitySnql("agency", "label", false)).toBe(
			"alter column agency.label set not null"
		);
		expect(setDefaultSnql("agency", "label", ' "y" ')).toBe(
			'alter column agency.label set default "y"'
		);
		expect(dropDefaultSnql("agency", "label")).toBe(
			"alter column agency.label drop default"
		);
		expect(dropColumnSnql("agency", "label")).toBe(
			"drop column label from agency"
		);
	});
});

describe("gestes de relation (ADR-039 D2)", () => {
	const ref = {
		table: "pet",
		column: "owner_id",
		targetTable: "owner",
		targetColumn: "id"
	};

	it("relier : la règle par défaut ne s'écrit pas ; supprimer : par le nom de la contrainte", () => {
		expect(
			addRefSnql({ ...ref, onDelete: "restrict", onUpdate: "restrict" })
		).toBe("add ref (owner_id) references owner.id into pet");
		expect(
			addRefSnql({ ...ref, onDelete: "set null", onUpdate: "cascade" })
		).toBe(
			"add ref (owner_id) references owner.id on delete set null on update cascade into pet"
		);
		expect(dropRefSnql("pet", "pet_owner_id_fkey")).toBe(
			"drop ref pet_owner_id_fkey from pet"
		);
	});

	it("aperçu : FK au nom du profil ; suppression : nom de la contrainte à retaper", () => {
		const pets = {
			engine: "postgres",
			collections: [
				collection("owner"),
				{
					...collection("pet"),
					fields: [
						...collection("pet").fields,
						{
							name: "owner_id",
							type: "int",
							nullable: false,
							source: "declared"
						}
					]
				}
			],
			relations: [],
			refs: [
				{
					name: "pet_owner_id_fkey",
					fromCollection: "pet",
					fromColumn: "owner_id",
					toCollection: "owner",
					toColumn: "id",
					onDelete: "restrict",
					onUpdate: "restrict",
					source: "declared"
				}
			]
		} as unknown as SnqlSchemaModel;
		const added = previewChange(
			addRefSnql({ ...ref, onDelete: "cascade", onUpdate: "restrict" }),
			{ ...pets, refs: [] },
			{ kind: "migrations", orm: "prisma", apply: true }
		);
		expect(added.error).toBeUndefined();
		expect(added.statements.join("\n")).toContain(
			'CONSTRAINT "pet_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owner" ("id") ON DELETE CASCADE'
		);
		const dropped = previewChange(
			dropRefSnql("pet", "pet_owner_id_fkey"),
			pets,
			{ kind: "direct" }
		);
		expect(dropped.confirm).toBe("DROP pet_owner_id_fkey");
		expect(dropped.warnings).toEqual([
			"Le code qui suit la relation 'pet_owner_id_fkey' échouera ; plus rien ne contrôlera les valeurs de sa colonne."
		]);
	});

	it("table : créée avec sa clé primaire ; supprimée après saisie de son nom", () => {
		const schema = {
			engine: "postgres",
			collections: [collection("owner")],
			relations: []
		} as unknown as SnqlSchemaModel;
		const created = createTableSnql({
			name: " visit ",
			keyName: " id ",
			keyType: "uuid"
		});
		expect(created).toBe("create table visit { id: uuid, primary key (id) }");
		const preview = previewChange(created, schema, { kind: "direct" });
		expect(preview.error).toBeUndefined();
		expect(preview.statements.join("\n")).toContain('CREATE TABLE "visit"');
		expect(preview.confirm).toBeUndefined();

		const dropped = previewChange(dropTableSnql("owner"), schema, {
			kind: "direct"
		});
		expect(dropped.error).toBeUndefined();
		expect(dropped.confirm).toBe("DROP owner");
		expect(dropped.warnings).toEqual([
			"Les requêtes et le code qui utilisent 'owner' échoueront ; ses lignes seront perdues."
		]);
	});

	it("index : colonnes dans l'ordre choisi, nom du profil ; supprimé par son nom", () => {
		const schema = {
			engine: "postgres",
			collections: [
				{
					...collection("pet"),
					fields: [
						...collection("pet").fields,
						{ name: "owner_id", type: "int", nullable: true, source: "declared" }
					],
					indexes: [
						{ name: "pet_owner_id_idx", columns: ["owner_id"], unique: false }
					]
				}
			],
			relations: []
		} as unknown as SnqlSchemaModel;
		const prisma = { kind: "migrations", orm: "prisma", apply: true } as const;

		const plain = addIndexSnql({
			table: "pet",
			columns: ["owner_id", "id"],
			unique: false
		});
		expect(plain).toBe("add index (owner_id, id) into pet");
		expect(previewChange(plain, schema, prisma).statements.join("\n")).toContain(
			'"pet_owner_id_id_idx"'
		);
		const unique = addIndexSnql({ table: "pet", columns: ["id"], unique: true });
		expect(unique).toBe("add unique index (id) into pet");
		expect(previewChange(unique, schema, prisma).statements.join("\n")).toContain(
			'"pet_id_key"'
		);

		const dropped = previewChange(
			dropIndexSnql("pet", "pet_owner_id_idx"),
			schema,
			prisma
		);
		expect(dropped.error).toBeUndefined();
		expect(dropped.confirm).toBe("DROP pet_owner_id_idx");
	});

	it("enum : une valeur par ligne ; une valeur ajoutée est annoncée irréversible", () => {
		const schema = {
			engine: "postgres",
			collections: [collection("pet")],
			relations: [],
			enums: [{ name: "mood", members: ["calm"], source: "declared" }]
		} as unknown as SnqlSchemaModel;

		const created = createEnumSnql(" status ", "draft\n\n  published \n");
		expect(created).toBe('create enum status { "draft", "published" }');
		const preview = previewChange(created, schema, { kind: "direct" });
		expect(preview.error).toBeUndefined();
		expect(preview.statements.join("\n")).toContain("CREATE TYPE");

		const added = addEnumMemberSnql("mood", ' "wild" ');
		expect(added).toBe('add enum member mood "\\"wild\\""');
		const plain = previewChange(addEnumMemberSnql("mood", "wild"), schema, {
			kind: "direct"
		});
		expect(plain.error).toBeUndefined();
		expect(plain.warnings).toEqual([
			"Une valeur ajoutée à 'mood' ne se retire plus."
		]);
	});

	it("règles d'une relation : le formulaire part de celles du mode, et écrit les autres", () => {
		const schema = {
			engine: "postgres",
			collections: [
				collection("owner"),
				{
					...collection("pet"),
					fields: [
						...collection("pet").fields,
						{ name: "owner_id", type: "int", nullable: true, source: "declared" }
					]
				}
			],
			relations: [],
			refs: []
		} as unknown as SnqlSchemaModel;
		const prisma = { kind: "migrations", orm: "prisma", apply: true } as const;

		// Sans rien écrire, Prisma met `cascade` à la mise à jour ; le langage, `restrict`.
		expect(defaultRefRules(ref, schema, { kind: "direct" })).toEqual({
			onDelete: "restrict",
			onUpdate: "restrict"
		});
		const defaults = defaultRefRules(ref, schema, prisma);
		expect(defaults).toEqual({ onDelete: "restrict", onUpdate: "cascade" });

		// Le défaut du mode ne s'écrit pas, et donne bien ce que le formulaire affiche.
		const asShown = addRefSnql({ ...ref, ...defaults }, defaults);
		expect(asShown).toBe("add ref (owner_id) references owner.id into pet");
		expect(previewChange(asShown, schema, prisma).statements.join("\n")).toContain(
			"ON DELETE RESTRICT ON UPDATE CASCADE"
		);

		// `restrict` à la mise à jour, choisi sous Prisma : écrit, et appliqué.
		const restrict = addRefSnql(
			{ ...ref, onDelete: "restrict", onUpdate: "restrict" },
			defaults
		);
		expect(restrict).toBe(
			"add ref (owner_id) references owner.id on update restrict into pet"
		);
		expect(previewChange(restrict, schema, prisma).statements.join("\n")).toContain(
			"ON DELETE RESTRICT ON UPDATE RESTRICT"
		);
	});

	it("noms saisis : seuls les champs remplis partent, la proposition du CLI garde les autres", () => {
		expect(typedNames({})).toBeUndefined();
		expect(
			typedNames({
				model: " ",
				relations: { "pet.owner_id": { field: "", back: " pets " } }
			})
		).toEqual({ relations: { "pet.owner_id": { back: "pets" } } });
		expect(
			typedNames({ relations: { "pet.owner_id": { field: "", back: "" } } })
		).toBeUndefined();
	});
});

describe("previewChange (ADR-039 D3)", () => {
	const pg = schema("agency") as unknown as SnqlSchemaModel;
	const withLabel = {
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
		expect(
			previewChange("rename column agency.label to name", withLabel, {
				kind: "direct"
			}).warnings
		).toEqual([
			"Les requêtes et le code qui utilisent 'agency.label' devront passer à 'name'."
		]);
		expect(
			previewChange(setNullabilitySnql("agency", "label", true), withLabel, {
				kind: "direct"
			})
		).toMatchObject({
			statements: ['ALTER TABLE "agency" ALTER COLUMN "label" DROP NOT NULL'],
			warnings: []
		});
	});

	it("suppression de colonne : casse applicative, valeurs perdues, saisie de la console à retaper", () => {
		const preview = previewChange(
			dropColumnSnql("agency", "label"),
			withLabel,
			{ kind: "direct" }
		);
		expect(preview.statements).toEqual([
			'ALTER TABLE "agency" DROP COLUMN "label" RESTRICT'
		]);
		expect(preview.warnings).toEqual([
			"Les requêtes et le code qui utilisent 'agency.label' échoueront ; ses valeurs seront perdues."
		]);
		expect(preview.confirm).toBe("DROP agency");
		expect(
			previewChange(renameColumnSnql("agency", "label", "name"), withLabel, {
				kind: "direct"
			}).confirm
		).toBeUndefined();
	});
});
