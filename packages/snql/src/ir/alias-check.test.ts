/**
 * Tests du garde `checkAliasDefined` — rejette au lowering un `path[0]` qui
 * n'est ni un alias déclaré (source ou `with`) ni une colonne de la source.
 *
 * Contrat :
 *  - Sans schéma : garde désactivé (permissif), le codegen émettra du SQL
 *    qui laissera pg produire son propre message d'erreur. Compat rétro
 *    avec les 200+ tests qui compilent sans schema.
 *  - Avec schéma : le garde fire et lève un `SnqlError` code
 *    `lower_unknown_alias` avec un message dynamique qui suggère la
 *    correction (déclarer `as`, retirer le préfixe, ou pointer vers un
 *    alias `with` existant).
 *  - Le `span` de la référence AST est propagé dans l'erreur pour permettre
 *    au frontend de souligner le token exact dans l'éditeur.
 */

import { describe, expect, it } from "vitest";
import type { SchemaModel } from "../schema/model";
import { compile, lowerMutation, parse, tokenize } from "../index";
import type { Statement } from "../parser/ast";
import { SnqlError } from "../diagnostics";

/** compile() est read-only ; pour tester lowerMutation on parse+lower direct. */
function lowerMut(source: string, schema?: SchemaModel): void {
	const stmt: Statement = parse(tokenize(source));
	if (stmt.operation === "select") throw new Error("attendu une mutation");
	lowerMutation(stmt, schema);
}

/** Deux collections simples : `users` (colonnes name, email, address jsonb)
 *  et `orders` (id, user_id, total). Aucune relation déclarée. */
const SCHEMA: SchemaModel = {
	engine: "postgres",
	collections: [
		{
			name: "users",
			source: "declared",
			primaryKey: ["id"],
			fields: [
				{ name: "id", type: "bigint", nullable: false, source: "declared" },
				{ name: "name", type: "string", nullable: false, source: "declared" },
				{ name: "email", type: "string", nullable: false, source: "declared" },
				// `address` est un jsonb — accès `address.city` doit rester valide.
				{ name: "address", type: "json", nullable: true, source: "declared" }
			]
		},
		{
			name: "orders",
			source: "declared",
			primaryKey: ["id"],
			fields: [
				{ name: "id", type: "bigint", nullable: false, source: "declared" },
				{
					name: "user_id",
					type: "bigint",
					nullable: false,
					source: "declared"
				},
				{ name: "total", type: "int", nullable: false, source: "declared" }
			]
		}
	],
	relations: []
};

describe("checkAliasDefined — avec schéma", () => {
	it("rejette 'r.field' quand 'r' n'est pas déclaré (bug d'UX historique)", () => {
		expect(() =>
			compile("find users where r.name = \"Alice\"", {
				engine: "postgres",
				schema: SCHEMA
			})
		).toThrow(SnqlError);
	});

	it("message d'erreur mentionne l'alias fautif ET suggère la correction", () => {
		try {
			compile("find users where r.name = \"Alice\"", {
				engine: "postgres",
				schema: SCHEMA
			});
			expect.fail("aurait dû throw");
		} catch (e) {
			expect(e).toBeInstanceOf(SnqlError);
			const msg = (e as SnqlError).message;
			// Message dynamique : contient l'ident fautif + suggestion
			// contextuelle (déclarer as, ou retirer le préfixe).
			expect(msg).toContain("'r'");
			expect(msg).toContain("r.name");
			expect(msg).toMatch(/as\s+r|retire le préfixe/i);
			expect((e as SnqlError).code).toBe("lower_unknown_alias");
		}
	});

	it("porte le span source dans le SnqlError (Phase 3 — jump-to)", () => {
		try {
			compile("find users where r.name = \"Alice\"", {
				engine: "postgres",
				schema: SCHEMA
			});
			expect.fail("aurait dû throw");
		} catch (e) {
			expect(e).toBeInstanceOf(SnqlError);
			const err = e as SnqlError;
			expect(err.span).toBeDefined();
			// Le span pointe sur `r.name` dans la source.
			const source = "find users where r.name = \"Alice\"";
			expect(source.slice(err.span?.start.offset, err.span?.end.offset)).toBe(
				"r.name"
			);
		}
	});

	it("accepte 'u.name' quand 'u' est l'alias source déclaré", () => {
		expect(() =>
			compile("find users as u where u.name = \"Alice\"", {
				engine: "postgres",
				schema: SCHEMA
			})
		).not.toThrow();
	});

	it("accepte 'address.city' (accès JSON à une colonne document)", () => {
		expect(() =>
			compile("find users pick address.city as city", {
				engine: "postgres",
				schema: SCHEMA
			})
		).not.toThrow();
	});

	it("rejette 'users.name' — nom de la collection nue comme préfixe", () => {
		try {
			compile("find users where users.name = \"Alice\"", {
				engine: "postgres",
				schema: SCHEMA
			});
			expect.fail("aurait dû throw");
		} catch (e) {
			expect(e).toBeInstanceOf(SnqlError);
			const msg = (e as SnqlError).message;
			// Suggestion spécifique : `find users as users`.
			expect(msg).toMatch(/find users as users/);
			expect(msg).toMatch(/retire le préfixe/);
		}
	});

	it("propose l'alias source dans le message quand un est déclaré", () => {
		try {
			compile("find users as u where usr.name = \"Alice\"", {
				engine: "postgres",
				schema: SCHEMA
			});
			expect.fail("aurait dû throw");
		} catch (e) {
			const msg = (e as SnqlError).message;
			// Suggère l'alias 'u' déjà déclaré comme correction probable.
			expect(msg).toMatch(/'u'/);
		}
	});

	it("path.length == 1 : jamais un alias, jamais rejeté", () => {
		// `find users where name = "Alice"` — pas de path composé.
		expect(() =>
			compile("find users where name = \"Alice\"", {
				engine: "postgres",
				schema: SCHEMA
			})
		).not.toThrow();
	});

	it("path profond sur un JSON (address.city.zip) — head reste column", () => {
		expect(() =>
			compile("find users pick address.city.zip as zip", {
				engine: "postgres",
				schema: SCHEMA
			})
		).not.toThrow();
	});
});

describe("checkAliasDefined — sans schéma (permissif)", () => {
	it("compile quand même 'r.field' sans as r (pg produira l'erreur)", () => {
		// Compat rétro : sans schéma le garde est désactivé, on laisse pg
		// remonter son message. Le frontend a maintenant identSpans pour
		// résoudre l'ident dans le message pg (Phase 3b-lite).
		expect(() =>
			compile("find users where r.name = \"Alice\"", { engine: "postgres" })
		).not.toThrow();
	});

	it("accepte 'address.city' aussi sans schema (peut être JSON access)", () => {
		expect(() =>
			compile("find users pick address.city as city", { engine: "postgres" })
		).not.toThrow();
	});
});

/** Schéma partiel : collection cible sans fields (Mongo pré-sampling). */
const SCHEMA_EMPTY_FIELDS: SchemaModel = {
	engine: "mongodb",
	collections: [{ name: "users", source: "inferred", fields: [] }],
	relations: []
};

/** Schéma qui ne connaît PAS la collection cible. */
const SCHEMA_MISSING_COLLECTION: SchemaModel = {
	engine: "postgres",
	collections: [
		{
			name: "other_table",
			source: "declared",
			primaryKey: ["id"],
			fields: [
				{ name: "id", type: "bigint", nullable: false, source: "declared" }
			]
		}
	],
	relations: []
};

describe("checkAliasDefined — schéma partiel = permissif (fix verify #1)", () => {
	it("collection présente mais fields=[] (Mongo pré-sampling) — JSON access accepté", () => {
		expect(() =>
			compile("find users pick profile.avatar as avatar", {
				engine: "mongodb",
				schema: SCHEMA_EMPTY_FIELDS
			})
		).not.toThrow();
	});

	it("source absente du schéma — JSON access accepté (pas de suggestion mensongère)", () => {
		expect(() =>
			compile('find users where address.city = "Paris"', {
				engine: "postgres",
				schema: SCHEMA_MISSING_COLLECTION
			})
		).not.toThrow();
	});
});

describe("lowerMutation — checkAliasDefined branché sur update/remove (fix verify #2)", () => {
	it("rejette 'update users where u.id = 1 set ...' avec schéma (u fantôme)", () => {
		expect(() =>
			lowerMut('update users where u.id = 1 set name = "foo"', SCHEMA)
		).toThrow(SnqlError);
	});

	it("rejette 'remove from users where x.email = ...' avec schéma", () => {
		expect(() =>
			lowerMut('remove from users where x.email = "a@b"', SCHEMA)
		).toThrow(SnqlError);
	});

	it("rejette une valeur SET avec préfixe fantôme (p.old_price)", () => {
		expect(() =>
			lowerMut("update users where id = 1 set name = p.old_price", SCHEMA)
		).toThrow(SnqlError);
	});

	it("accepte JSON access dans un update WHERE (address.city = 'Paris')", () => {
		expect(() =>
			lowerMut('update users where address.city = "Paris" set name = "x"', SCHEMA)
		).not.toThrow();
	});

	it("message d'erreur mutations précise 'pas d'alias' — indication contextuelle", () => {
		try {
			lowerMut('update users where u.id = 1 set name = "foo"', SCHEMA);
			expect.fail("aurait dû throw");
		} catch (e) {
			expect(e).toBeInstanceOf(SnqlError);
			const msg = (e as SnqlError).message;
			expect(msg).toMatch(/mutations ne portent pas d'alias/i);
			expect((e as SnqlError).code).toBe("lower_unknown_alias");
		}
	});

	it("sans schéma → permissif comme pour les reads (compat rétro)", () => {
		expect(() =>
			lowerMut('update users where u.id = 1 set name = "foo"')
		).not.toThrow();
	});
});

describe("with foreignField — check symétrique (fix verify #3)", () => {
	it("rejette un foreignField avec alias fantôme", () => {
		expect(() =>
			compile(
				"find users as u with orders as o on u.id = xyz.user_id",
				{ engine: "postgres", schema: SCHEMA }
			)
		).toThrow(/lower_unknown_alias|xyz/);
	});

	it("accepte le foreignField préfixé par l'alias joint 'o'", () => {
		expect(() =>
			compile(
				"find users as u with orders as o on u.id = o.user_id",
				{ engine: "postgres", schema: SCHEMA }
			)
		).not.toThrow();
	});

	it("accepte le foreignField préfixé par le nom de la collection jointe (sans as)", () => {
		// `with orders on ...` — pas d'alias, joinAlias = "orders".
		expect(() =>
			compile(
				"find users as u with orders on u.id = orders.user_id",
				{ engine: "postgres", schema: SCHEMA }
			)
		).not.toThrow();
	});

	it("message mentionne l'alias joint attendu comme correction", () => {
		try {
			compile(
				"find users as u with orders as o on u.id = xyz.user_id",
				{ engine: "postgres", schema: SCHEMA }
			);
			expect.fail("aurait dû throw");
		} catch (e) {
			const msg = (e as SnqlError).message;
			expect(msg).toMatch(/'o'/);
			expect(msg).toMatch(/foreignField/);
		}
	});
});
