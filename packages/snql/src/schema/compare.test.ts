import { describe, expect, it } from "vitest";
import type { DDLStatement } from "../index";
import { lowerDDL, parse, tokenize } from "../index";
import { compareSchemas, ddlScope } from "./compare";
import type { Collection, Field, SchemaModel } from "./model";

const field = (name: string, extra: Partial<Field> = {}): Field => ({
	name,
	type: "int",
	nullable: false,
	source: "declared",
	...extra
});

function schema(
	collection: Partial<Collection> & { readonly fields: readonly Field[] },
	extra: Partial<SchemaModel> = {}
): SchemaModel {
	return {
		engine: "postgres",
		collections: [{ name: "t", source: "declared", ...collection }],
		relations: [],
		...extra
	};
}

describe("compareSchemas", () => {
	it("identiques → conforme", () => {
		const s = schema({ fields: [field("id")], primaryKey: ["id"] });
		expect(compareSchemas(s, s)).toEqual([]);
	});

	it("colonne absente, type, nullabilité, défaut, valeurs d'enum : chacun signalé", () => {
		const expected = schema({
			fields: [
				field("a"),
				field("b", { type: "bigint" }),
				field("c", { nullable: true }),
				field("d", { hasDefault: true }),
				field("e", { type: "enum", enumValues: ["x", "y"] })
			]
		});
		const actual = schema({
			fields: [
				field("b"),
				field("c"),
				field("d"),
				field("e", { type: "enum", enumValues: ["x"] }),
				field("z")
			]
		});
		expect(compareSchemas(expected, actual)).toEqual([
			{
				target: "t",
				subject: "column",
				name: "a",
				expected: "int, non nul",
				actual: "absente"
			},
			{
				target: "t",
				subject: "column",
				name: "b",
				expected: "bigint, non nul",
				actual: "int, non nul"
			},
			{
				target: "t",
				subject: "column",
				name: "c",
				expected: "int, nullable",
				actual: "int, non nul"
			},
			{
				target: "t",
				subject: "column",
				name: "d",
				expected: "int, non nul, avec défaut",
				actual: "int, non nul"
			},
			{
				target: "t",
				subject: "column",
				name: "e",
				expected: "enum, non nul, [x, y]",
				actual: "enum, non nul, [x]"
			},
			{
				target: "t",
				subject: "column",
				name: "z",
				expected: "absente",
				actual: "int, non nul"
			}
		]);
	});

	it("index : par nom, ou par colonnes quand le moteur a choisi le nom ; index en trop signalé", () => {
		const expected = schema({
			fields: [field("a"), field("b")],
			indexes: [
				{ name: "idx_t_a", columns: ["a"], unique: false },
				{ name: "", columns: ["b"], unique: true }
			]
		});
		const actual = schema({
			fields: [field("a"), field("b")],
			indexes: [
				{ name: "UQ__t__3213E83F", columns: ["b"], unique: true },
				{ name: "idx_t_a", columns: ["a", "b"], unique: false },
				{ name: "stray", columns: ["a"], unique: false }
			]
		});
		expect(compareSchemas(expected, actual)).toEqual([
			{
				target: "t",
				subject: "index",
				name: "idx_t_a",
				expected: "(a)",
				actual: "(a, b)"
			},
			{
				target: "t",
				subject: "index",
				name: "stray",
				expected: "absent",
				actual: "(a)"
			}
		]);
	});

	it("index invalide : différent de l'index attendu, et signalé comme tel en trop (ADR-029 D18)", () => {
		const unique = { columns: ["a"], unique: true };
		const expected = schema({
			fields: [field("a")],
			indexes: [{ name: "t_a_key", ...unique }]
		});
		const invalid = schema({
			fields: [field("a")],
			indexes: [{ name: "t_a_key", ...unique, valid: false }]
		});
		expect(compareSchemas(expected, invalid)).toEqual([
			{
				target: "t",
				subject: "index",
				name: "t_a_key",
				expected: "unique (a)",
				actual: "unique (a), invalide"
			}
		]);
		expect(compareSchemas(schema({ fields: [field("a")] }), invalid)).toEqual([
			{
				target: "t",
				subject: "index",
				name: "t_a_key",
				expected: "absent",
				actual: "unique (a), invalide"
			}
		]);
	});

	it("FK : cible et actions", () => {
		const ref = {
			name: "fk",
			fromCollection: "t",
			fromColumn: "a",
			toCollection: "u",
			toColumn: "id",
			onDelete: "cascade" as const,
			onUpdate: "restrict" as const,
			source: "declared" as const
		};
		const expected = schema({ fields: [field("a")] }, { refs: [ref] });
		const actual = schema(
			{ fields: [field("a")] },
			{ refs: [{ ...ref, onDelete: "restrict" }] }
		);
		expect(compareSchemas(expected, actual)).toEqual([
			{
				target: "t",
				subject: "foreign-key",
				name: "fk",
				expected: "(a) → u.id, on delete cascade, on update restrict",
				actual: "(a) → u.id, on delete restrict, on update restrict"
			}
		]);
	});

	it("Mongo : `_id` implicite et clé `_id` ignorés ; champ inféré comparé sur sa présence", () => {
		const expected = { ...schema({ fields: [field("a")] }), engine: "mongodb" };
		const actual = {
			...schema({
				fields: [
					field("_id", { source: "inferred" }),
					field("a", { type: "float", source: "inferred" })
				],
				primaryKey: ["_id"]
			}),
			engine: "mongodb"
		};
		expect(compareSchemas(expected, actual)).toEqual([]);
	});

	it("représentation d'un moteur sans type natif : json rendu en texte sous SQL Server", () => {
		const expected = {
			...schema({ fields: [field("j", { type: "json" })] }),
			engine: "mssql"
		};
		const actual = {
			...schema({ fields: [field("j", { type: "string" })] }),
			engine: "mssql"
		};
		expect(compareSchemas(expected, actual)).toEqual([]);
		expect(
			compareSchemas(
				{ ...expected, engine: "postgres" },
				{ ...actual, engine: "postgres" }
			)
		).toHaveLength(1);
	});

	it("périmètre : seules les tables touchées ; enum et tables qui l'utilisent", () => {
		const before = schema(
			{ fields: [field("plan", { type: "enum", enumTypeName: "tier" })] },
			{
				enums: [{ name: "tier", members: ["free"], source: "declared" }]
			}
		);
		const plan = lowerDDL(
			parse(tokenize('add enum member tier "pro"')) as DDLStatement,
			before
		);
		expect(ddlScope(plan, before)).toEqual({
			collections: ["t"],
			enums: ["tier"]
		});
		const addColumn = lowerDDL(
			parse(tokenize("add column x int into t")) as DDLStatement,
			before
		);
		expect(ddlScope(addColumn, before)).toEqual({
			collections: ["t"],
			enums: []
		});
		// Hors périmètre, un écart n'est pas jugé.
		const other = {
			...before,
			collections: [
				...before.collections,
				{ name: "o", fields: [], source: "declared" as const }
			]
		};
		expect(
			compareSchemas(before, other, { collections: ["t"], enums: [] })
		).toEqual([]);
	});
});
