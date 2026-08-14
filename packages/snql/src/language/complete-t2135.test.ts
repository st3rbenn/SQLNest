/**
 * Sprint T2/13.5 — Schema-aware autocomplete dans `add {…}` / `update … set …`.
 *
 * Vérifie :
 *  - fields de la target proposés dans un doc (avec skip des déjà tapés)
 *  - detail = `<type>` + `required` / `optional` + `→ FK target`
 *  - enum values après `col:` quand col.type === "enum"
 *  - context set d'update symétrique
 */

import { describe, expect, it } from "vitest";
import type { SchemaModel } from "../schema/model";
import { completeSnql } from "./complete";

const SCHEMA: SchemaModel = {
	engine: "postgres",
	collections: [
		{
			name: "resource",
			source: "declared",
			primaryKey: ["id"],
			fields: [
				{ name: "id", type: "uuid", nullable: false, source: "declared", hasDefault: true },
				{ name: "first_name", type: "string", nullable: false, source: "declared" },
				{ name: "last_name", type: "string", nullable: true, source: "declared" },
				{ name: "role", type: "enum", nullable: false, source: "declared", enumValues: ["field_expert", "expert_assistant"] },
				{ name: "agency_id", type: "uuid", nullable: false, source: "declared" }
			]
		},
		{
			name: "agency",
			source: "declared",
			primaryKey: ["id"],
			fields: [{ name: "id", type: "uuid", nullable: false, source: "declared" }]
		}
	],
	relations: [
		{
			from: { collection: "resource", fields: ["agency_id"] },
			to: { collection: "agency", fields: ["id"] },
			kind: "many-to-one",
			origin: "foreign-key",
			confidence: 1
		}
	]
};

const at = (src: string, offset = src.length) => completeSnql(src, offset, SCHEMA);
const labels = (src: string, offset = src.length) =>
	at(src, offset).options.map((o) => o.label);
const detailOf = (src: string, label: string, offset = src.length) =>
	at(src, offset).options.find((o) => o.label === label)?.detail;

// ═══════════════════════════════════════════════════════════════════════════
// add {…} — position clé
// ═══════════════════════════════════════════════════════════════════════════

describe("add doc — position clé", () => {
	it("propose les fields de la target quand `into` est déjà tapé", () => {
		// L'user a tapé `into resource` puis revient dans le doc.
		const src = 'add {} into resource';
		// Curseur juste après le `{`.
		const options = labels(src, 5);
		expect(options).toContain("id");
		expect(options).toContain("first_name");
		expect(options).toContain("role");
	});

	it("propose les fields quand target est dans le suffixe (user tape doc avant into)", () => {
		const src = 'add {\n\n} into resource';
		// Curseur au milieu du doc, `into resource` dans le suffixe.
		const options = labels(src, 6);
		expect(options).toContain("first_name");
		expect(options).toContain("agency_id");
	});

	it("skip les fields déjà tapés dans le doc", () => {
		const src = 'add {first_name: "T", ,} into resource';
		// Curseur après la 2e virgule — on ne doit plus proposer first_name.
		const options = labels(src, 22);
		expect(options).not.toContain("first_name");
		expect(options).toContain("last_name");
		expect(options).toContain("role");
	});

	it("detail : required pour NOT NULL sans default", () => {
		const src = 'add {} into resource';
		expect(detailOf(src, "first_name", 5)).toBe("string · required");
	});

	it("detail : optional pour nullable", () => {
		const src = 'add {} into resource';
		expect(detailOf(src, "last_name", 5)).toBe("string · optional");
	});

	it("detail : id avec hasDefault n'est pas marqué required (a un default)", () => {
		const src = 'add {} into resource';
		// id est NOT NULL mais hasDefault=true → doit être ni required ni optional
		// (juste `uuid`).
		expect(detailOf(src, "id", 5)).toBe("uuid");
	});

	it("detail : FK arrow présent", () => {
		const src = 'add {} into resource';
		expect(detailOf(src, "agency_id", 5)).toBe("uuid · required · → agency.id");
	});

	it("insertKind : string pour uuid/enum/string", () => {
		const src = 'add {} into resource';
		const opts = at(src, 5).options;
		expect(opts.find((o) => o.label === "first_name")?.insertKind).toBe("string");
		expect(opts.find((o) => o.label === "role")?.insertKind).toBe("string");
		expect(opts.find((o) => o.label === "id")?.insertKind).toBe("string");
	});

	// NB: pas de champ number dans la schema T2/13.5 — on couvre via
	// insertKindOf, testé indirectement par le comportement enum/string ci-dessus.
});

// ═══════════════════════════════════════════════════════════════════════════
// add {col: |} — position valeur, col enum
// ═══════════════════════════════════════════════════════════════════════════

describe("add doc — position valeur (enum)", () => {
	it("propose les labels enum après `role:`", () => {
		const src = 'add {role: } into resource';
		const options = labels(src, 11);
		expect(options).toContain("field_expert");
		expect(options).toContain("expert_assistant");
	});

	it("apply wrappe entre guillemets par défaut", () => {
		const src = 'add {role: } into resource';
		const opt = at(src, 11).options.find((o) => o.label === "field_expert");
		expect(opt?.apply).toBe('"field_expert"');
	});

	it("apply nu si string déjà ouverte (curseur dans les guillemets)", () => {
		const src = 'add {role: "f"} into resource';
		const opt = at(src, 13).options.find((o) => o.label === "field_expert");
		expect(opt?.apply).toBeUndefined();
	});

	it("pas de suggestions enum sur une col non-enum", () => {
		const src = 'add {first_name: } into resource';
		const options = labels(src, 17);
		expect(options).not.toContain("field_expert");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// update t set c = v, c2 = |
// ═══════════════════════════════════════════════════════════════════════════

describe("update … set — position clé + valeur", () => {
	it("propose les fields après `set`", () => {
		const src = "update resource set ";
		const options = labels(src);
		expect(options).toContain("first_name");
		expect(options).toContain("role");
	});

	it("propose les enums après `col = ` sur col enum", () => {
		const src = "update resource set role = ";
		const options = labels(src);
		expect(options).toContain("field_expert");
	});

	it("skip la col déjà tapée dans le set", () => {
		const src = 'update resource set first_name = "T", ';
		const options = labels(src);
		expect(options).not.toContain("first_name");
		expect(options).toContain("last_name");
	});
});
