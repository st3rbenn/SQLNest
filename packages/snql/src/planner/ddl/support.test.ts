import { describe, expect, it } from "vitest";
import type { DDLKind } from "../../parser/ast";
import {
	KV_CAPABILITIES,
	MONGODB_CAPABILITIES,
	POSTGRES_CAPABILITIES,
	type Capabilities
} from "../capabilities";
import { assertDDLSupported } from "../planner";
import {
	DDL_ERROR_CODES,
	DDL_SUPPORT,
	ddlSupportCell,
	isDDLSupported
} from "./support";

const KINDS: readonly DDLKind[] = [
	"create-table",
	"drop-table",
	"add-column",
	"drop-column",
	"add-index",
	"add-unique-index",
	"drop-index"
];

const ENGINES: readonly {
	readonly name: "postgres" | "mongodb" | "kv";
	readonly caps: Capabilities;
}[] = [
	{ name: "postgres", caps: POSTGRES_CAPABILITIES },
	{ name: "mongodb", caps: MONGODB_CAPABILITIES },
	{ name: "kv", caps: KV_CAPABILITIES }
];

describe("DDL_SUPPORT matrix (ADR-029)", () => {
	it("chaque kind × engine a une cellule native ou compensated (jamais refused)", () => {
		for (const kind of KINDS) {
			for (const { name } of ENGINES) {
				const cell = DDL_SUPPORT[kind][name];
				expect(cell).toBeDefined();
				expect(["native", "compensated"]).toContain(cell.mode);
			}
		}
	});

	it("un engine inconnu refuse tout kind (isDDLSupported)", () => {
		for (const kind of KINDS) {
			expect(isDDLSupported(kind, "cassandra")).toBe(false);
		}
	});

	it("ddlSupportCell renvoie null pour un engine inconnu", () => {
		expect(ddlSupportCell("create-table", "cassandra")).toBeNull();
	});
});

describe("assertDDLSupported (ADR-029 D5)", () => {
	it("passe pour create-table sur les 3 engines (matrice tout native/compensated)", () => {
		for (const { caps } of ENGINES) {
			expect(() =>
				assertDDLSupported(
					{
						op: "ddl",
						kind: "create-table",
						target: "t",
						ifNotExists: false,
						fields: [{ name: "id", type: "uuid", nullable: false, unique: false }]
					},
					caps
				)
			).not.toThrow();
		}
	});

	it("refuse si capability 'ddl' absente (code planner_ddl_unsupported)", () => {
		const fakeCaps: Capabilities = {
			engine: "sqlite",
			supports: new Set(),
			functions: new Set(),
			castTargets: new Set()
		};
		try {
			assertDDLSupported(
				{
					op: "ddl",
					kind: "create-table",
					target: "t",
					ifNotExists: false,
					fields: [{ name: "id", type: "uuid", nullable: false, unique: false }]
				},
				fakeCaps
			);
			throw new Error("expected throw");
		} catch (e) {
			expect((e as { code?: string }).code).toBe("planner_ddl_unsupported");
		}
	});

	it("refuse si engine connu mais matrice ne connaît pas ce kind (code par kind)", () => {
		const fakeMongoOnlyCreate: Capabilities = {
			engine: "myengine",
			supports: new Set(["ddl"]),
			functions: new Set(),
			castTargets: new Set()
		};
		try {
			assertDDLSupported(
				{
					op: "ddl",
					kind: "create-table",
					target: "t",
					ifNotExists: false,
					fields: [{ name: "id", type: "uuid", nullable: false, unique: false }]
				},
				fakeMongoOnlyCreate
			);
			throw new Error("expected throw");
		} catch (e) {
			expect((e as { code?: string }).code).toBe(
				DDL_ERROR_CODES["create-table"]
			);
		}
	});

	it("DDL_ERROR_CODES a exactement une entrée par kind", () => {
		for (const kind of KINDS) {
			expect(DDL_ERROR_CODES[kind]).toMatch(/^planner_ddl_.*_unsupported$/);
		}
	});
});
