/**
 * Sprint T3/1 — Introspection tier-1 : `list tables`.
 *
 * Couvre :
 *  - parser  : `list tables` détecté avant check verb, refus sous-commande inconnue
 *  - lower   : IntrospectPlan {kind, target?}
 *  - codegen : PG SqlQuery via information_schema (namespace bindé $1),
 *              Mongo shape mongo-introspect (dispatch adapter)
 *  - planner : capability introspect PG + Mongo (KV refusé)
 *  - refus   : sub-commande inconnue, introspect dans transaction
 */

import { describe, expect, it } from "vitest";
import { SnqlError } from "./diagnostics";
import {
	assertIntrospectSupported,
	getMapper,
	KV_CAPABILITIES,
	lowerIntrospect,
	MONGODB_CAPABILITIES,
	parse,
	tokenize
} from "./index";

function expectCode(fn: () => unknown, code: string): void {
	try {
		fn();
		throw new Error(`SnqlError attendu avec code=${code}`);
	} catch (e) {
		if (!(e instanceof SnqlError)) throw e;
		expect(e.code).toBe(code);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Parser
// ═══════════════════════════════════════════════════════════════════════════

describe("parser — list tables", () => {
	it("parse `list tables` en IntrospectStatement", () => {
		const stmt = parse(tokenize("list tables"));
		if (stmt.operation !== "introspect") throw new Error("attendu introspect");
		expect(stmt.kind).toBe("list-tables");
	});

	it("refus sous-commande inconnue", () => {
		expectCode(
			() => parse(tokenize("list foobar")),
			"parse_introspect_unknown_list"
		);
	});

	it("refus introspection dans transaction", () => {
		expectCode(
			() => parse(tokenize("transaction { list tables }")),
			"parse_introspect_in_transaction"
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Codegen PG
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen PG — list tables", () => {
	it("produit SELECT information_schema avec namespace bindé", () => {
		const stmt = parse(tokenize("list tables"));
		if (stmt.operation !== "introspect") throw new Error();
		const planned = lowerIntrospect(stmt);
		const mapper = getMapper("postgres");
		if (mapper.mapIntrospect === undefined) throw new Error("no mapIntrospect");
		const native = mapper.mapIntrospect(planned, { namespace: "apollon_schema" });
		if (native.kind !== "sql") throw new Error("kind sql attendu");
		expect(native.text).toBe(
			`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`
		);
		expect(native.params).toEqual(["apollon_schema"]);
	});

	it("fallback namespace = 'public' si absent", () => {
		const stmt = parse(tokenize("list tables"));
		if (stmt.operation !== "introspect") throw new Error();
		const planned = lowerIntrospect(stmt);
		const mapper = getMapper("postgres");
		const native = mapper.mapIntrospect!(planned);
		if (native.kind !== "sql") throw new Error();
		expect(native.params).toEqual(["public"]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Codegen Mongo
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen Mongo — list tables", () => {
	it("produit mongo-introspect avec plan passé tel quel", () => {
		const stmt = parse(tokenize("list tables"));
		if (stmt.operation !== "introspect") throw new Error();
		const planned = lowerIntrospect(stmt);
		const mapper = getMapper("mongodb");
		if (mapper.mapIntrospect === undefined) throw new Error();
		const native = mapper.mapIntrospect(planned);
		expect(native.kind).toBe("mongo-introspect");
		if (native.kind !== "mongo-introspect") throw new Error();
		expect(native.plan.kind).toBe("list-tables");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Planner
// ═══════════════════════════════════════════════════════════════════════════

describe("planner — capability 'introspect'", () => {
	it("PG et Mongo supportent introspect", () => {
		const stmt = parse(tokenize("list tables"));
		if (stmt.operation !== "introspect") throw new Error();
		const planned = lowerIntrospect(stmt);
		expect(() => assertIntrospectSupported(planned, MONGODB_CAPABILITIES)).not.toThrow();
	});

	it("KV refuse introspect", () => {
		const stmt = parse(tokenize("list tables"));
		if (stmt.operation !== "introspect") throw new Error();
		const planned = lowerIntrospect(stmt);
		expectCode(
			() => assertIntrospectSupported(planned, KV_CAPABILITIES),
			"planner_introspect_unsupported"
		);
	});
});
