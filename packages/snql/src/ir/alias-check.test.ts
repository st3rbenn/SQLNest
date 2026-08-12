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
import { compile } from "../index";
import { SnqlError } from "../diagnostics";

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
