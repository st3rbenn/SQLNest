/**
 * Sprint T2/13 : full upsert + `pick count`.
 *
 * Couvre :
 *  - parser  : on conflict (keys) [ignore | edit set ... [where ...]] + pick count
 *  - lower   : validations keys/cols, refus new hors context, refus dup
 *  - IR      : PlanExpr.upsertNew, MutationPlan.onConflict, returnRowCount
 *  - planner : capability `upsert` (PG only)
 *  - codegen : `ON CONFLICT (…) DO {NOTHING|UPDATE SET … [WHERE …]}`, drop
 *              `RETURNING *` sous `pick count`, `EXCLUDED."col"` sur upsertNew.
 */

import { describe, expect, it } from "vitest";
import { SnqlError } from "./diagnostics";
import {
	assertMutationUpsertSupported,
	getMapper,
	KV_CAPABILITIES,
	lowerMutation,
	MONGODB_CAPABILITIES,
	parse,
	tokenize
} from "./index";
import type { SchemaModel } from "./schema/model";

const SCHEMA: SchemaModel = {
	engine: "postgres",
	collections: [
		{
			name: "users",
			source: "declared",
			fields: [
				{ name: "id", type: "bigint", nullable: false, source: "declared" },
				{ name: "email", type: "string", nullable: false, source: "declared" },
				{ name: "display_name", type: "string", nullable: true, source: "declared" },
				{ name: "updated_at", type: "timestamp", nullable: true, source: "declared" }
			]
		}
	],
	relations: []
};

function pgSql(source: string, schema?: SchemaModel): { text: string; params: readonly unknown[] } {
	const statement = parse(tokenize(source));
	if (statement.operation === "select") throw new Error("mutation attendue");
	const mutation = lowerMutation(statement, schema);
	const native = getMapper("postgres").mapMutation(mutation);
	if (native.kind !== "sql") throw new Error("kind sql attendu");
	return { text: native.text, params: native.params };
}

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
// Parser : shape acceptée
// ═══════════════════════════════════════════════════════════════════════════

describe("parser — on conflict + pick count", () => {
	it("add + on conflict ignore", () => {
		const stmt = parse(tokenize('add {email: "a@b.c"} into users on conflict (email) ignore'));
		expect(stmt.operation).toBe("insert");
		if (stmt.operation !== "insert") return;
		expect(stmt.onConflict?.keys).toEqual(["email"]);
		expect(stmt.onConflict?.action.kind).toBe("ignore");
	});

	it("add + on conflict edit set", () => {
		const stmt = parse(
			tokenize('add {email: "a@b.c", display_name: "Bob"} into users on conflict (email) edit set display_name = new.display_name')
		);
		if (stmt.operation !== "insert") throw new Error();
		expect(stmt.onConflict?.action.kind).toBe("update");
		if (stmt.onConflict?.action.kind !== "update") return;
		expect(stmt.onConflict.action.assignments).toHaveLength(1);
		expect(stmt.onConflict.action.assignments[0]?.column).toBe("display_name");
	});

	it("add + on conflict edit set where", () => {
		const stmt = parse(
			tokenize(
				'add {email: "a@b.c", display_name: "Bob", updated_at: "2026-08-14"} into users on conflict (email) edit set display_name = new.display_name where updated_at < new.updated_at'
			)
		);
		if (stmt.operation !== "insert") throw new Error();
		if (stmt.onConflict?.action.kind !== "update") throw new Error();
		expect(stmt.onConflict.action.where).toBeDefined();
	});

	it("add + on conflict multi-keys", () => {
		const stmt = parse(tokenize('add {email: "a@b.c", id: 1} into users on conflict (email, id) ignore'));
		if (stmt.operation !== "insert") throw new Error();
		expect(stmt.onConflict?.keys).toEqual(["email", "id"]);
	});

	it("add + pick count sans on conflict", () => {
		const stmt = parse(tokenize('add {email: "a@b.c"} into users pick count'));
		if (stmt.operation !== "insert") throw new Error();
		expect(stmt.returnRowCount).toBe(true);
		expect(stmt.onConflict).toBeUndefined();
	});

	it("add + on conflict ignore + pick count", () => {
		const stmt = parse(
			tokenize('add {email: "a@b.c"} into users on conflict (email) ignore pick count')
		);
		if (stmt.operation !== "insert") throw new Error();
		expect(stmt.returnRowCount).toBe(true);
		expect(stmt.onConflict?.action.kind).toBe("ignore");
	});

	it("update + pick count", () => {
		const stmt = parse(tokenize('update users where id = 1 set display_name = "x" pick count'));
		if (stmt.operation !== "update") throw new Error();
		expect(stmt.returnRowCount).toBe(true);
	});

	it("remove + pick count", () => {
		const stmt = parse(tokenize("remove from users where id = 1 pick count"));
		if (stmt.operation !== "delete") throw new Error();
		expect(stmt.returnRowCount).toBe(true);
	});

	it("erreur : `on` sans `conflict` reste ignoré (on n'est pas dans un select)", () => {
		// Sans le peek(1) 'conflict', `on` n'est pas consommé — le parser s'attend
		// à eof ou pick count. Le token 'on' laissé au curseur remonte comme
		// erreur parse_unexpected (via cursor.expect en fin).
		expect(() =>
			parse(tokenize("add {email: \"x\"} into users on (email) ignore"))
		).toThrow();
	});

	it("erreur : `on conflict` sans `(`", () => {
		expect(() =>
			parse(tokenize('add {email: "x"} into users on conflict email ignore'))
		).toThrow(/'\('/);
	});

	it("erreur : `on conflict (email)` sans action", () => {
		expectCode(
			() => parse(tokenize('add {email: "x"} into users on conflict (email)')),
			"parse_on_conflict_action"
		);
	});

	it("erreur : `on conflict (email) edit` sans `set`", () => {
		expectCode(
			() => parse(tokenize('add {email: "x"} into users on conflict (email) edit display_name = "y"')),
			"parse_on_conflict_edit_set"
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Lower : validations
// ═══════════════════════════════════════════════════════════════════════════

describe("lower — on conflict validations", () => {
	it("keys dupliquées refusées", () => {
		expectCode(
			() =>
				pgSql(
					'add {email: "a"} into users on conflict (email, email) ignore'
				),
			"lower_on_conflict_duplicate_key"
		);
	});

	it("key inconnue (schema présent) refusée", () => {
		expectCode(
			() =>
				pgSql(
					'add {email: "a"} into users on conflict (zzz) ignore',
					SCHEMA
				),
			"lower_on_conflict_unknown_key"
		);
	});

	it("edit set col inconnue (schema présent) refusée", () => {
		expectCode(
			() =>
				pgSql(
					'add {email: "a", display_name: "b"} into users on conflict (email) edit set zzz = new.display_name',
					SCHEMA
				),
			"lower_on_conflict_unknown_set_column"
		);
	});

	it("new.<col> où col pas dans insert doc refusé", () => {
		expectCode(
			() =>
				pgSql(
					'add {email: "a"} into users on conflict (email) edit set display_name = new.display_name'
				),
			"lower_upsert_new_column_missing"
		);
	});

	it("new.a.b (path > 2) refusé", () => {
		expectCode(
			() =>
				pgSql(
					'add {email: "a", display_name: "b"} into users on conflict (email) edit set display_name = new.display_name.foo'
				),
			"lower_upsert_new_path_shape"
		);
	});

	it("alias fantôme dans set refusé (schema présent)", () => {
		expectCode(
			() =>
				pgSql(
					'add {email: "a", display_name: "b"} into users on conflict (email) edit set display_name = zzz.display_name',
					SCHEMA
				),
			"lower_unknown_alias"
		);
	});

	it("edit set dup assignments refusé", () => {
		expectCode(
			() =>
				pgSql(
					'add {email: "a", display_name: "b"} into users on conflict (email) edit set display_name = new.display_name, display_name = "z"'
				),
			"lower_duplicate_assignment"
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Codegen PG : ON CONFLICT natif
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen PG — ON CONFLICT + returning drop", () => {
	it("add sans on conflict garde RETURNING *", () => {
		const { text } = pgSql('add {email: "a@b.c"} into users');
		expect(text).toBe(
			'INSERT INTO "users" ("email") VALUES ($1) RETURNING *'
		);
	});

	it("add + on conflict ignore → DO NOTHING", () => {
		const { text } = pgSql('add {email: "a@b.c"} into users on conflict (email) ignore');
		expect(text).toBe(
			'INSERT INTO "users" ("email") VALUES ($1) ON CONFLICT ("email") DO NOTHING RETURNING *'
		);
	});

	it("add + on conflict edit set new.col → EXCLUDED", () => {
		const { text } = pgSql(
			'add {email: "a@b.c", display_name: "Bob"} into users on conflict (email) edit set display_name = new.display_name'
		);
		expect(text).toBe(
			'INSERT INTO "users" ("email", "display_name") VALUES ($1, $2) ON CONFLICT ("email") DO UPDATE SET "display_name" = EXCLUDED."display_name" RETURNING *'
		);
	});

	it("add + on conflict edit set where (bare col = existing row)", () => {
		const { text } = pgSql(
			'add {email: "a@b.c", display_name: "Bob", updated_at: "2026-08-14"} into users on conflict (email) edit set display_name = new.display_name where updated_at < new.updated_at'
		);
		expect(text).toBe(
			'INSERT INTO "users" ("email", "display_name", "updated_at") VALUES ($1, $2, $3) ON CONFLICT ("email") DO UPDATE SET "display_name" = EXCLUDED."display_name" WHERE "updated_at" < EXCLUDED."updated_at" RETURNING *'
		);
	});

	it("add + on conflict multi-keys", () => {
		const { text } = pgSql(
			'add {email: "a", id: 1} into users on conflict (email, id) ignore'
		);
		expect(text).toBe(
			'INSERT INTO "users" ("email", "id") VALUES ($1, $2) ON CONFLICT ("email", "id") DO NOTHING RETURNING *'
		);
	});

	it("pick count droppe RETURNING sur INSERT", () => {
		const { text } = pgSql('add {email: "a@b.c"} into users pick count');
		expect(text).toBe('INSERT INTO "users" ("email") VALUES ($1)');
	});

	it("pick count droppe RETURNING sur INSERT + ON CONFLICT", () => {
		const { text } = pgSql(
			'add {email: "a@b.c"} into users on conflict (email) ignore pick count'
		);
		expect(text).toBe(
			'INSERT INTO "users" ("email") VALUES ($1) ON CONFLICT ("email") DO NOTHING'
		);
	});

	it("pick count droppe RETURNING sur UPDATE", () => {
		const { text } = pgSql('update users where id = 1 set display_name = "x" pick count');
		expect(text).toBe('UPDATE "users" SET "display_name" = $1 WHERE "id" = $2');
	});

	it("pick count droppe RETURNING sur DELETE", () => {
		const { text } = pgSql("remove from users where id = 1 pick count");
		expect(text).toBe('DELETE FROM "users" WHERE "id" = $1');
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Planner : capability upsert
// ═══════════════════════════════════════════════════════════════════════════

describe("planner — capability 'upsert' PG only", () => {
	it("Mongo refuse `on conflict`", () => {
		const stmt = parse(tokenize('add {email: "a"} into users on conflict (email) ignore'));
		if (stmt.operation !== "insert") throw new Error();
		const mutation = lowerMutation(stmt);
		expectCode(
			() => assertMutationUpsertSupported(mutation, MONGODB_CAPABILITIES),
			"planner_upsert_unsupported"
		);
	});

	it("KV refuse `on conflict`", () => {
		const stmt = parse(tokenize('add {email: "a"} into users on conflict (email) ignore'));
		if (stmt.operation !== "insert") throw new Error();
		const mutation = lowerMutation(stmt);
		expectCode(
			() => assertMutationUpsertSupported(mutation, KV_CAPABILITIES),
			"planner_upsert_unsupported"
		);
	});

	it("add sans on conflict passe partout", () => {
		const stmt = parse(tokenize('add {email: "a"} into users'));
		if (stmt.operation !== "insert") throw new Error();
		const mutation = lowerMutation(stmt);
		expect(() => assertMutationUpsertSupported(mutation, MONGODB_CAPABILITIES)).not.toThrow();
		expect(() => assertMutationUpsertSupported(mutation, KV_CAPABILITIES)).not.toThrow();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// `new.<col>` hors context on-conflict
// ═══════════════════════════════════════════════════════════════════════════

describe("new.<col> hors on-conflict — reste ident ordinaire", () => {
	it("update classique avec `new` = alias inconnu → lower_unknown_alias (schema requis)", () => {
		// Sans schema, `new.display_name` passe le lower — le garde
		// `checkExprPathsAgainstColumns` n'est actif que si le schema fournit
		// sourceColumns. Avec schema, l'alias `new` est rejeté comme fantôme.
		expectCode(
			() => pgSql("update users set display_name = new.display_name", SCHEMA),
			"lower_unknown_alias"
		);
	});

	it("select avec `new` = alias inconnu → lower_unknown_alias", () => {
		const stmt = parse(tokenize("find users where new.email = \"x\""));
		expect(stmt.operation).toBe("select");
		// L'erreur sortira via `compile()` / `lower()` — pas via pgSql (mutation only).
		// On teste juste que le parser accepte (new est un ident, pas un keyword).
	});
});
