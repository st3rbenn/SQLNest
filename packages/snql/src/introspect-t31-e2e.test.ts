/**
 * Sprint T3/1+T3/2 — Introspection tier-1 : `list tables` + `describe <t>`.
 *
 * Couvre :
 *  - parser  : `list tables` / `describe t` détectés avant check verb,
 *              refus sous-commande inconnue, refus describe sans target
 *  - lower   : IntrospectPlan {kind, target?}
 *  - codegen : PG SqlQuery via information_schema (namespace + table bindés),
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

// ═══════════════════════════════════════════════════════════════════════════
// T3/2 — describe <table>
// ═══════════════════════════════════════════════════════════════════════════

describe("parser — describe <table>", () => {
	it("parse `describe users` en IntrospectStatement", () => {
		const stmt = parse(tokenize("describe users"));
		if (stmt.operation !== "introspect") throw new Error("attendu introspect");
		expect(stmt.kind).toBe("describe-table");
		expect(stmt.target).toBe("users");
	});

	it("refus `describe` sans target", () => {
		expectCode(
			() => parse(tokenize("describe")),
			"parse_introspect_describe_missing_target"
		);
	});

	it("refus `describe` dans transaction", () => {
		expectCode(
			() => parse(tokenize("transaction { describe users }")),
			"parse_introspect_in_transaction"
		);
	});

	it("`describe` reste utilisable comme col (soft-keyword)", () => {
		// Régression : `describe` en position ident (col/alias) doit passer.
		// Ex: pick x as describe. Parse verb `find`, pas `describe`.
		const stmt = parse(tokenize("find t pick x as describe"));
		if (stmt.operation !== "select") throw new Error("select attendu");
	});
});

describe("codegen PG — describe <table>", () => {
	it("produit SELECT information_schema avec namespace + table bindés", () => {
		const stmt = parse(tokenize("describe users"));
		if (stmt.operation !== "introspect") throw new Error();
		const planned = lowerIntrospect(stmt);
		const mapper = getMapper("postgres");
		if (mapper.mapIntrospect === undefined) throw new Error("no mapIntrospect");
		const native = mapper.mapIntrospect(planned, { namespace: "apollon_schema" });
		if (native.kind !== "sql") throw new Error("kind sql attendu");
		expect(native.text).toContain("information_schema.columns");
		expect(native.text).toContain("PRIMARY KEY");
		expect(native.text).toContain("FOREIGN KEY");
		// T3/2.1 : enum PG (USER-DEFINED) → udt_name lisible ('RESOURCE_STATUS').
		expect(native.text).toContain("USER-DEFINED");
		expect(native.text).toContain("udt_name");
		// T3/2.2 : column_default nettoyé des `::TYPE` casts (typename quoted
		// OU unquoted) — l'UI voit `'synced'` au lieu de `'synced'::"NOMADIA…"`.
		expect(native.text).toContain("regexp_replace(c.column_default");
		expect(native.text).toContain("$1");
		expect(native.text).toContain("$2");
		expect(native.params).toEqual(["apollon_schema", "users"]);
	});

	it("regex `::TYPE` cleanup — patterns attendus", () => {
		// Auto-doc du contrat de nettoyage. Le pattern PG est POSIX ERE — on
		// vérifie ici le comportement JS équivalent (les 2 dialectes acceptent
		// le pattern tel quel).
		const strip = (s: string): string =>
			s.replace(/::(?:"[^"]+"|[a-z][a-z0-9_ ]*)/g, "");
		expect(strip(`'synced'::"NOMADIA_SYNC_STATUS"`)).toBe(`'synced'`);
		expect(strip(`'N/A'::character varying`)).toBe(`'N/A'`);
		expect(strip(`nextval('users_id_seq'::regclass)`)).toBe(
			`nextval('users_id_seq')`
		);
		expect(strip(`NULL::text`)).toBe(`NULL`);
		expect(strip(`gen_random_uuid()`)).toBe(`gen_random_uuid()`);
		expect(strip(`now()`)).toBe(`now()`);
	});

	it("fallback namespace = 'public'", () => {
		const stmt = parse(tokenize("describe users"));
		if (stmt.operation !== "introspect") throw new Error();
		const planned = lowerIntrospect(stmt);
		const mapper = getMapper("postgres");
		const native = mapper.mapIntrospect!(planned);
		if (native.kind !== "sql") throw new Error();
		expect(native.params).toEqual(["public", "users"]);
	});
});

describe("codegen Mongo — describe <table>", () => {
	it("produit mongo-introspect avec plan.target", () => {
		const stmt = parse(tokenize("describe users"));
		if (stmt.operation !== "introspect") throw new Error();
		const planned = lowerIntrospect(stmt);
		const mapper = getMapper("mongodb");
		if (mapper.mapIntrospect === undefined) throw new Error();
		const native = mapper.mapIntrospect(planned);
		expect(native.kind).toBe("mongo-introspect");
		if (native.kind !== "mongo-introspect") throw new Error();
		expect(native.plan.kind).toBe("describe-table");
		expect(native.plan.target).toBe("users");
	});
});
