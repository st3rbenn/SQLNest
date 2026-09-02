/**
 * +Introspection tier-1 : `list tables` + `describe <t>`.
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
	lower,
	lowerIntrospect,
	lowerMutation,
	MONGODB_CAPABILITIES,
	parse,
	POSTGRES_CAPABILITIES,
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
// describe <table>
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
		// enum PG (USER-DEFINED) → udt_name lisible ('RESOURCE_STATUS').
		expect(native.text).toContain("USER-DEFINED");
		expect(native.text).toContain("udt_name");
		// column_default nettoyé des `::TYPE` casts (typename quoted
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

// ═══════════════════════════════════════════════════════════════════════════
// pipeline stages après introspection
// ═══════════════════════════════════════════════════════════════════════════

describe("parser — stages après introspection", () => {
	it("`describe users pick name, type`", () => {
		const stmt = parse(tokenize("describe users pick name, type"));
		if (stmt.operation !== "introspect") throw new Error();
		expect(stmt.stages).toBeDefined();
		expect(stmt.stages).toHaveLength(1);
		expect(stmt.stages![0]!.type).toBe("pick");
	});

	it("`list tables where name like \"%users%\" sort name limit 5`", () => {
		const stmt = parse(
			tokenize('list tables where name like "%users%" sort name limit 5')
		);
		if (stmt.operation !== "introspect") throw new Error();
		expect(stmt.stages).toHaveLength(3);
		expect(stmt.stages!.map((s) => s.type)).toEqual(["where", "sort", "limit"]);
	});

	it("refus `describe users with X on...`", () => {
		expectCode(
			() => parse(tokenize("describe users with orders on id = user_id")),
			"parse_introspect_stage_unsupported"
		);
	});

	it("refus `describe users group by name`", () => {
		expectCode(
			() => parse(tokenize("describe users group by name")),
			"parse_introspect_stage_unsupported"
		);
	});

	it("refus ordre stage violé", () => {
		expectCode(
			() => parse(tokenize("describe users sort name where nullable = true")),
			"parse_stage_out_of_order"
		);
	});
});

describe("codegen PG — stages après introspection", () => {
	it("`describe users pick name` wrap la baseQuery en subquery", () => {
		const stmt = parse(tokenize("describe users pick name"));
		if (stmt.operation !== "introspect") throw new Error();
		const planned = lowerIntrospect(stmt);
		expect(planned.postOps).toBeDefined();
		expect(planned.postOps).toHaveLength(1);
		const mapper = getMapper("postgres");
		const native = mapper.mapIntrospect!(planned, { namespace: "public" });
		if (native.kind !== "sql") throw new Error();
		expect(native.text).toContain("SELECT ");
		expect(native.text).toContain(`FROM (`);
		expect(native.text).toContain(`) AS "t"`);
		expect(native.text).toContain(`"name"`);
	});

	it("`list tables where name like \"%usr%\" limit 3` binde les params", () => {
		const stmt = parse(
			tokenize('list tables where name like "%usr%" limit 3')
		);
		if (stmt.operation !== "introspect") throw new Error();
		const planned = lowerIntrospect(stmt);
		const mapper = getMapper("postgres");
		const native = mapper.mapIntrospect!(planned, { namespace: "apollon" });
		if (native.kind !== "sql") throw new Error();
		// namespace + like pattern bindés séquentiellement.
		expect(native.params).toEqual(["apollon", "%usr%"]);
		expect(native.text).toContain("LIKE");
		expect(native.text).toContain("LIMIT 3");
	});
});

describe("Mongo compensate — postOps sur listCollections", () => {
	it("plan porte postOps lowered", () => {
		const stmt = parse(tokenize("list tables where name = \"users\""));
		if (stmt.operation !== "introspect") throw new Error();
		const planned = lowerIntrospect(stmt);
		expect(planned.postOps).toBeDefined();
		expect(planned.postOps).toHaveLength(1);
		expect(planned.postOps![0]!.op).toBe("filter");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// `for` filter shortcut
// ═══════════════════════════════════════════════════════════════════════════

describe("parser — `for` shortcut", () => {
	it("`describe agency for id` désucre en where name in [\"id\"]", () => {
		const stmt = parse(tokenize("describe agency for id"));
		if (stmt.operation !== "introspect") throw new Error();
		expect(stmt.stages).toHaveLength(1);
		const s = stmt.stages![0]!;
		if (s.type !== "where") throw new Error("where attendu");
		if (s.predicate.type !== "in") throw new Error("in attendu");
		expect(s.predicate.target.type).toBe("field");
		if (s.predicate.target.type !== "field") throw new Error();
		expect(s.predicate.target.path).toEqual(["name"]);
		expect(s.predicate.values).toHaveLength(1);
	});

	it("`describe agency for id, name, email` → in avec 3 values", () => {
		const stmt = parse(tokenize("describe agency for id, name, email"));
		if (stmt.operation !== "introspect") throw new Error();
		const s = stmt.stages![0]!;
		if (s.type !== "where" || s.predicate.type !== "in") throw new Error();
		expect(s.predicate.values).toHaveLength(3);
	});

	it("`for` + `where` combinables (2 stages where séparés)", () => {
		const stmt = parse(
			tokenize("describe agency for id, name where nullable = true")
		);
		if (stmt.operation !== "introspect") throw new Error();
		expect(stmt.stages).toHaveLength(2);
		expect(stmt.stages!.map((s) => s.type)).toEqual(["where", "where"]);
	});

	it("refus `for` sans ident", () => {
		expectCode(
			() => parse(tokenize("describe agency for")),
			"parse_introspect_for_missing_name"
		);
	});

	it("refus `for` après where (ordre canonique)", () => {
		expectCode(
			() => parse(tokenize("describe agency where nullable = true for id")),
			"parse_introspect_for_out_of_order"
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// list schemas + list indexes
// ═══════════════════════════════════════════════════════════════════════════

describe("parser — `list schemas` / `list indexes`", () => {
	it("parse `list schemas`", () => {
		const stmt = parse(tokenize("list schemas"));
		if (stmt.operation !== "introspect") throw new Error();
		expect(stmt.kind).toBe("list-schemas");
		expect(stmt.target).toBeUndefined();
	});

	it("parse `list indexes` (sans target)", () => {
		const stmt = parse(tokenize("list indexes"));
		if (stmt.operation !== "introspect") throw new Error();
		expect(stmt.kind).toBe("list-indexes");
		expect(stmt.target).toBeUndefined();
	});

	it("parse `list indexes on agency`", () => {
		const stmt = parse(tokenize("list indexes on agency"));
		if (stmt.operation !== "introspect") throw new Error();
		expect(stmt.kind).toBe("list-indexes");
		expect(stmt.target).toBe("agency");
	});

	it("refus `list indexes on` sans table", () => {
		expectCode(
			() => parse(tokenize("list indexes on")),
			"parse_introspect_indexes_missing_target"
		);
	});

	it("refus sous-commande list inconnue", () => {
		expectCode(
			() => parse(tokenize("list foobar")),
			"parse_introspect_unknown_list"
		);
	});

	it("`list schemas where name like \"apollon%\"` — stages pipeline", () => {
		const stmt = parse(tokenize('list schemas where name like "apollon%"'));
		if (stmt.operation !== "introspect") throw new Error();
		expect(stmt.stages).toHaveLength(1);
	});

	it("`list indexes on agency for agency_pkey` — for shortcut", () => {
		const stmt = parse(tokenize("list indexes on agency for agency_pkey"));
		if (stmt.operation !== "introspect") throw new Error();
		expect(stmt.target).toBe("agency");
		expect(stmt.stages).toHaveLength(1);
	});
});

describe("codegen PG — list schemas / list indexes", () => {
	it("`list schemas` — exclut pg_* et information_schema", () => {
		const stmt = parse(tokenize("list schemas"));
		if (stmt.operation !== "introspect") throw new Error();
		const planned = lowerIntrospect(stmt);
		const mapper = getMapper("postgres");
		const native = mapper.mapIntrospect!(planned);
		if (native.kind !== "sql") throw new Error();
		expect(native.text).toContain("information_schema.schemata");
		expect(native.text).toContain("pg\\_%");
		expect(native.text).toContain("information_schema");
		// list-schemas ne prend PAS de namespace — pas de $1 pour ns.
		expect(native.params).toEqual([]);
	});

	it("`list indexes` — pg_index join sans target filter", () => {
		const stmt = parse(tokenize("list indexes"));
		if (stmt.operation !== "introspect") throw new Error();
		const planned = lowerIntrospect(stmt);
		const mapper = getMapper("postgres");
		const native = mapper.mapIntrospect!(planned, { namespace: "apollon" });
		if (native.kind !== "sql") throw new Error();
		expect(native.text).toContain("pg_index");
		expect(native.text).toContain("indisunique");
		expect(native.text).not.toContain("t.relname = $2");
		expect(native.params).toEqual(["apollon"]);
	});

	it("`list indexes on agency` — filter table bindé $2", () => {
		const stmt = parse(tokenize("list indexes on agency"));
		if (stmt.operation !== "introspect") throw new Error();
		const planned = lowerIntrospect(stmt);
		const mapper = getMapper("postgres");
		const native = mapper.mapIntrospect!(planned, { namespace: "apollon" });
		if (native.kind !== "sql") throw new Error();
		expect(native.text).toContain("t.relname = $2");
		expect(native.params).toEqual(["apollon", "agency"]);
	});
});

describe("codegen Mongo — list schemas / list indexes", () => {
	it("`list schemas` produit mongo-introspect kind list-schemas", () => {
		const stmt = parse(tokenize("list schemas"));
		if (stmt.operation !== "introspect") throw new Error();
		const planned = lowerIntrospect(stmt);
		const mapper = getMapper("mongodb");
		const native = mapper.mapIntrospect!(planned);
		if (native.kind !== "mongo-introspect") throw new Error();
		expect(native.plan.kind).toBe("list-schemas");
	});

	it("`list indexes on users` produit plan avec target", () => {
		const stmt = parse(tokenize("list indexes on users"));
		if (stmt.operation !== "introspect") throw new Error();
		const planned = lowerIntrospect(stmt);
		const mapper = getMapper("mongodb");
		const native = mapper.mapIntrospect!(planned);
		if (native.kind !== "mongo-introspect") throw new Error();
		expect(native.plan.kind).toBe("list-indexes");
		expect(native.plan.target).toBe("users");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// list databases (Mongo-first, refus PG)
// ═══════════════════════════════════════════════════════════════════════════

describe("parser — `list databases`", () => {
	it("parse `list databases`", () => {
		const stmt = parse(tokenize("list databases"));
		if (stmt.operation !== "introspect") throw new Error();
		expect(stmt.kind).toBe("list-databases");
		expect(stmt.target).toBeUndefined();
	});

	it("`list databases where name like \"prod%\"` — stages pipeline", () => {
		const stmt = parse(tokenize('list databases where name like "prod%"'));
		if (stmt.operation !== "introspect") throw new Error();
		expect(stmt.stages).toHaveLength(1);
	});
});

describe("codegen PG — list databases refus typé", () => {
	it("refus au codegen avec hint actionable", () => {
		const stmt = parse(tokenize("list databases"));
		if (stmt.operation !== "introspect") throw new Error();
		const planned = lowerIntrospect(stmt);
		const mapper = getMapper("postgres");
		expectCode(
			() => mapper.mapIntrospect!(planned),
			"codegen_introspect_unsupported"
		);
	});
});

describe("codegen Mongo — list databases", () => {
	it("produit mongo-introspect kind list-databases", () => {
		const stmt = parse(tokenize("list databases"));
		if (stmt.operation !== "introspect") throw new Error();
		const planned = lowerIntrospect(stmt);
		const mapper = getMapper("mongodb");
		const native = mapper.mapIntrospect!(planned);
		if (native.kind !== "mongo-introspect") throw new Error();
		expect(native.plan.kind).toBe("list-databases");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// list schema_events (SQLNest system, cross-engine via SqlnestIntrospectQuery)
// ═══════════════════════════════════════════════════════════════════════════

describe("parser — `list schema_events`", () => {
	it("parse `list schema_events`", () => {
		const stmt = parse(tokenize("list schema_events"));
		if (stmt.operation !== "introspect") throw new Error();
		expect(stmt.kind).toBe("list-schema-events");
		expect(stmt.target).toBeUndefined();
	});

	it("`list schema_events limit 20 sort seen_at desc` — pipeline stages", () => {
		const stmt = parse(tokenize("list schema_events sort seen_at desc limit 20"));
		if (stmt.operation !== "introspect") throw new Error();
		expect(stmt.stages).toHaveLength(2);
		expect(stmt.stages!.map((s) => s.type)).toEqual(["sort", "limit"]);
	});

	it("`list schema_events pick checksum` — projection pipeline", () => {
		const stmt = parse(tokenize("list schema_events pick checksum, seen_at"));
		if (stmt.operation !== "introspect") throw new Error();
		expect(stmt.stages).toHaveLength(1);
		expect(stmt.stages![0]!.type).toBe("pick");
	});
});

describe("codegen — list schema_events produit sqlnest-introspect", () => {
	it("PG mapper → sqlnest-introspect target schema-events", () => {
		const stmt = parse(tokenize("list schema_events"));
		if (stmt.operation !== "introspect") throw new Error();
		const planned = lowerIntrospect(stmt);
		const mapper = getMapper("postgres");
		const native = mapper.mapIntrospect!(planned);
		if (native.kind !== "sqlnest-introspect") throw new Error();
		expect(native.target).toBe("schema-events");
		expect(native.postOps).toBeUndefined();
	});

	it("Mongo mapper → sqlnest-introspect target schema-events", () => {
		const stmt = parse(tokenize("list schema_events"));
		if (stmt.operation !== "introspect") throw new Error();
		const planned = lowerIntrospect(stmt);
		const mapper = getMapper("mongodb");
		const native = mapper.mapIntrospect!(planned);
		if (native.kind !== "sqlnest-introspect") throw new Error();
		expect(native.target).toBe("schema-events");
	});

	it("stages lowered en postOps sur le shape sqlnest-introspect", () => {
		const stmt = parse(tokenize("list schema_events sort seen_at desc limit 20"));
		if (stmt.operation !== "introspect") throw new Error();
		const planned = lowerIntrospect(stmt);
		const mapper = getMapper("postgres");
		const native = mapper.mapIntrospect!(planned);
		if (native.kind !== "sqlnest-introspect") throw new Error();
		expect(native.postOps).toBeDefined();
		expect(native.postOps).toHaveLength(2);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Refus matrice au planner
// ═══════════════════════════════════════════════════════════════════════════

describe("planner — matrice INTROSPECT_SUPPORT", () => {
	it("list databases refuse au planner sur Postgres avec hint list schemas", () => {
		const stmt = parse(tokenize("list databases"));
		if (stmt.operation !== "introspect") throw new Error();
		const planned = lowerIntrospect(stmt);
		try {
			assertIntrospectSupported(planned, POSTGRES_CAPABILITIES);
			throw new Error("attendu SnqlError");
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.code).toBe("planner_introspect_databases_unsupported");
			expect(e.message).toContain("list schemas");
		}
	});

	it("list schema_events refuse au planner sur tous engines (routé client)", () => {
		const stmt = parse(tokenize("list schema_events"));
		if (stmt.operation !== "introspect") throw new Error();
		const planned = lowerIntrospect(stmt);
		try {
			assertIntrospectSupported(planned, POSTGRES_CAPABILITIES);
			throw new Error("attendu SnqlError");
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.code).toBe("planner_introspect_schema_events_unsupported");
			expect(e.message).toContain("SQLNest");
		}
		try {
			assertIntrospectSupported(planned, MONGODB_CAPABILITIES);
			throw new Error("attendu SnqlError");
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.code).toBe("planner_introspect_schema_events_unsupported");
		}
	});

	it("list tables accepté PG et Mongo", () => {
		const stmt = parse(tokenize("list tables"));
		if (stmt.operation !== "introspect") throw new Error();
		const planned = lowerIntrospect(stmt);
		expect(() =>
			assertIntrospectSupported(planned, POSTGRES_CAPABILITIES)
		).not.toThrow();
		expect(() =>
			assertIntrospectSupported(planned, MONGODB_CAPABILITIES)
		).not.toThrow();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Break net find/add/update/remove sur schema_events (table système)
// ═══════════════════════════════════════════════════════════════════════════

describe("lower — table système schema_events break net", () => {
	it("find schema_events → refus avec hint vers list schema_events", () => {
		expectCode(
			() => lower(parse(tokenize("find schema_events pick id")) as never),
			"planner_unknown_target_use_introspect"
		);
	});

	it("get schema_events → même refus", () => {
		expectCode(
			() => lower(parse(tokenize("get schema_events")) as never),
			"planner_unknown_target_use_introspect"
		);
	});

	it("add {checksum: 'x'} into schema_events → refus readonly", () => {
		expectCode(
			() =>
				lowerMutation(
					parse(tokenize('add {checksum: "x"} into schema_events')) as never
				),
			"planner_readonly_system_target"
		);
	});

	it("remove from schema_events where id = 'x' → refus readonly", () => {
		expectCode(
			() =>
				lowerMutation(
					parse(tokenize("remove from schema_events where id = \"x\"")) as never
				),
			"planner_readonly_system_target"
		);
	});

	it("update schema_events set checksum = 'x' → refus readonly", () => {
		expectCode(
			() =>
				lowerMutation(
					parse(
						tokenize("update schema_events set checksum = \"x\"")
					) as never
				),
			"planner_readonly_system_target"
		);
	});

	it("find schema_events_v2 (préfixe strict) → passe (pas match strict)", () => {
		// Un ident qui commence par `schema_events` mais avec suffixe ne
		// déclenche pas le refus — cohérent avec l'ancienne classification
		// regex (préfixe strict, pas préfixe lâche).
		expect(() =>
			lower(parse(tokenize("find schema_events_v2 pick id")) as never)
		).not.toThrow();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Sprint EN — list enums + describe enum (ferme la lecture raw-only, ADR-019)
// ═══════════════════════════════════════════════════════════════════════════

describe("parser — list enums / describe enum", () => {
	it("parse `list enums` en IntrospectStatement", () => {
		const stmt = parse(tokenize("list enums"));
		if (stmt.operation !== "introspect") throw new Error("attendu introspect");
		expect(stmt.kind).toBe("list-enums");
	});

	it("parse `describe enum DISASTER_QUALIFICATION` (nom + casse préservés)", () => {
		const stmt = parse(tokenize("describe enum DISASTER_QUALIFICATION"));
		if (stmt.operation !== "introspect") throw new Error("attendu introspect");
		expect(stmt.kind).toBe("describe-enum");
		expect(stmt.target).toBe("DISASTER_QUALIFICATION");
	});

	it("`describe enum` SEUL reste un describe-table d'une table nommée enum (edge préservé)", () => {
		const stmt = parse(tokenize("describe enum"));
		if (stmt.operation !== "introspect") throw new Error("attendu introspect");
		expect(stmt.kind).toBe("describe-table");
		expect(stmt.target).toBe("enum");
	});

	it("le message sous-commande inconnue liste `enums`", () => {
		try {
			parse(tokenize("list foobar"));
			throw new Error("SnqlError attendu");
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.message).toContain("enums");
		}
	});
});

describe("codegen PG — list enums / describe enum", () => {
	function pgIntrospect(source: string) {
		const stmt = parse(tokenize(source));
		if (stmt.operation !== "introspect") throw new Error();
		const planned = lowerIntrospect(stmt);
		const mapper = getMapper("postgres");
		if (mapper.mapIntrospect === undefined) throw new Error("no mapIntrospect");
		return mapper.mapIntrospect(planned, { namespace: "public" });
	}

	it("list enums → pg_type + pg_enum scopé namespace, count membres", () => {
		const native = pgIntrospect("list enums");
		if (native.kind !== "sql") throw new Error("kind sql attendu");
		expect(native.text).toBe(
			`SELECT t.typname AS name, count(e.enumlabel)::int AS members_count FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 GROUP BY t.typname ORDER BY t.typname`
		);
		expect(native.params).toEqual(["public"]);
	});

	it("describe enum → membres ordonnés enumsortorder, ns + nom bindés", () => {
		const native = pgIntrospect("describe enum DISASTER_QUALIFICATION");
		if (native.kind !== "sql") throw new Error("kind sql attendu");
		expect(native.text).toBe(
			`SELECT e.enumlabel AS member, (row_number() OVER (ORDER BY e.enumsortorder))::int AS position FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = $2 ORDER BY e.enumsortorder`
		);
		expect(native.params).toEqual(["public", "DISASTER_QUALIFICATION"]);
	});
});

describe("codegen Mongo + planner — enums", () => {
	it("Mongo passe-plat mongo-introspect (dispatch adapter _snql_enums)", () => {
		for (const src of ["list enums", "describe enum role_type"]) {
			const stmt = parse(tokenize(src));
			if (stmt.operation !== "introspect") throw new Error();
			const planned = lowerIntrospect(stmt);
			const mapper = getMapper("mongodb");
			if (mapper.mapIntrospect === undefined) throw new Error("no mapIntrospect");
			const native = mapper.mapIntrospect(planned);
			expect(native.kind).toBe("mongo-introspect");
		}
	});

	it("planner : list-enums + describe-enum supportés PG et Mongo", () => {
		for (const src of ["list enums", "describe enum role_type"]) {
			const stmt = parse(tokenize(src));
			if (stmt.operation !== "introspect") throw new Error();
			const planned = lowerIntrospect(stmt);
			expect(() =>
				assertIntrospectSupported(planned, POSTGRES_CAPABILITIES, "postgres")
			).not.toThrow();
			expect(() =>
				assertIntrospectSupported(planned, MONGODB_CAPABILITIES, "mongodb")
			).not.toThrow();
		}
	});
});
