import { describe, expect, it } from "vitest";
import type { IntrospectKind } from "../../parser/ast";
import {
	INTROSPECT_ERROR_CODES,
	INTROSPECT_HINTS,
	INTROSPECT_SUPPORT,
	READONLY_SYSTEM_TARGETS,
	RESERVED_SYSTEM_TARGETS,
	introspectHintFor,
	isIntrospectSupported
} from "./support";

const ALL_KINDS: readonly IntrospectKind[] = [
	"list-tables",
	"describe-table",
	"list-schemas",
	"list-indexes",
	"list-databases",
	"list-schema-events"
];

describe("INTROSPECT_SUPPORT matrice", () => {
	it("chaque kind du corpus a une entrée (matrice exhaustive)", () => {
		for (const kind of ALL_KINDS) {
			expect(INTROSPECT_SUPPORT[kind]).toBeDefined();
		}
	});

	it("chaque kind non-SQLNest supporte au moins un engine adapter", () => {
		// `list-schema-events` a un Set vide par design (routé côté client
		// SQLNest, jamais exécuté par un engine). Les 5 autres kinds doivent
		// avoir ≥ 1 engine — sinon le kind est mort.
		for (const kind of ALL_KINDS) {
			if (kind === "list-schema-events") continue;
			expect(INTROSPECT_SUPPORT[kind].size).toBeGreaterThan(0);
		}
	});

	it("list-schema-events a un support engine adapter vide (routé client)", () => {
		expect(INTROSPECT_SUPPORT["list-schema-events"].size).toBe(0);
	});

	it("list-databases est Mongo-first (Postgres refuse)", () => {
		expect(isIntrospectSupported("list-databases", "postgres")).toBe(false);
		expect(isIntrospectSupported("list-databases", "mongodb")).toBe(true);
	});

	it("les 4 kinds classiques supportent PG + Mongo", () => {
		const classic: readonly IntrospectKind[] = [
			"list-tables",
			"describe-table",
			"list-schemas",
			"list-indexes"
		];
		for (const kind of classic) {
			expect(isIntrospectSupported(kind, "postgres")).toBe(true);
			expect(isIntrospectSupported(kind, "mongodb")).toBe(true);
		}
	});

	it("engine inconnu refuse par défaut (fail-safe)", () => {
		expect(isIntrospectSupported("list-tables", "cassandra")).toBe(false);
	});
});

describe("INTROSPECT_HINTS", () => {
	it("chaque kind a une entrée hints (peut être vide)", () => {
		for (const kind of ALL_KINDS) {
			expect(INTROSPECT_HINTS[kind]).toBeDefined();
		}
	});

	it("list-databases refuse PG avec hint vers list schemas", () => {
		expect(introspectHintFor("list-databases", "postgres")).toContain(
			"list schemas"
		);
	});

	it("list-schema-events refuse tous engines avec hint SQLNest client", () => {
		expect(introspectHintFor("list-schema-events", "postgres")).toContain(
			"SQLNest"
		);
		expect(introspectHintFor("list-schema-events", "mongodb")).toContain(
			"SQLNest"
		);
	});

	it("engine inconnu → hint vide (pas de crash)", () => {
		expect(introspectHintFor("list-tables", "cassandra")).toBe("");
	});
});

describe("INTROSPECT_ERROR_CODES", () => {
	it("un code par kind, aligné sur la registry", () => {
		for (const kind of ALL_KINDS) {
			const code = INTROSPECT_ERROR_CODES[kind];
			expect(code).toMatch(/^planner_introspect_.+_unsupported$/);
		}
	});
});

describe("RESERVED / READONLY system targets", () => {
	it("schema_events est réservé (find refusé)", () => {
		expect(RESERVED_SYSTEM_TARGETS.has("schema_events")).toBe(true);
	});

	it("schema_events est readonly (add/update/remove refusés)", () => {
		expect(READONLY_SYSTEM_TARGETS.has("schema_events")).toBe(true);
	});

	it("les tables user classiques ne sont ni réservées ni readonly", () => {
		expect(RESERVED_SYSTEM_TARGETS.has("users")).toBe(false);
		expect(READONLY_SYSTEM_TARGETS.has("orders")).toBe(false);
	});
});
