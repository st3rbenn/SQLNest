/**
 * (MVP offline) — verrou de la parity au niveau codegen.
 *
 * Chaque case de PARITY_CASES est compilé pour tous les engines listés dans
 * `.engines`. Un `expectedRefusal` verrouille en plus qu'un engine spécifique
 * refuse au planner avec le code exact.
 *
 * Ce test ne vérifie PAS le rowset runtime (full est reporté quand
 * infrastructure Docker CI stabilisée). Il verrouille uniquement la surface
 * codegen — condition nécessaire mais pas suffisante à la parité totale.
 *
 * Toute PR qui casse la compilation d'un case fail CI ; toute PR qui ajoute
 * un case ici verrouille la parity pour ce case.
 */

import { describe, expect, it } from "vitest";
import { PARITY_CASES } from "./fixtures/parity-cases";
import {
	assertMongoRefused,
	mongoSql,
	pgSql,
	SnqlError
} from "./index";

// Adapter mongoSql/pgSql qui accepte tous les types de statement retournés
// par dispatchNative — pour on veut juste "compile OK" ou refus attendu,
// pas de check sur le shape (kind sql/mongo/transaction/mongo-write toléré).
function compileFor(engine: "postgres" | "mongodb", source: string): void {
	try {
		if (engine === "postgres") {
			pgSql(source);
		} else {
			mongoSql(source);
		}
	} catch (e) {
		// Kind assertion (transaction non-sql, let runtime-materialized) : compile OK.
		if (e instanceof Error && e.message.includes("'sql' attendu")) return;
		if (
			e instanceof SnqlError &&
			e.code === "parity_helper_runtime_materialized"
		) {
			return;
		}
		throw e;
	}
}

describe("parity-cases codegen check (MVP offline)", () => {
	for (const c of PARITY_CASES) {
		for (const engine of c.engines) {
			// Skip codegen check pour les engines runtime-materialized (subquery
			// uncorrelated Mongo résolu par materializeSubplan au runtime).
			if (c.runtimeMaterialized?.includes(engine)) continue;
			it(`[${engine}] ${c.id}`, () => {
				expect(() => compileFor(engine, c.source)).not.toThrow();
			});
		}
		if (c.expectedRefusal !== undefined) {
			const { engine, code } = c.expectedRefusal;
			it(`[${engine}] ${c.id} → refus attendu ${code}`, () => {
				if (engine === "postgres") {
					try {
						pgSql(c.source);
						expect.fail(`expected refusal ${code}, got compile OK`);
					} catch (e) {
						if (!(e instanceof SnqlError)) throw e;
						expect(e.code).toBe(code);
					}
				} else {
					const err = assertMongoRefused(c.source, code);
					expect(err.code).toBe(code);
				}
			});
		}
	}
});

describe("méta invariants", () => {
	it("chaque case a un id unique", () => {
		const ids = PARITY_CASES.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("expectedRefusal.engine n'est PAS dans.engines (mutuellement exclusif)", () => {
		for (const c of PARITY_CASES) {
			if (c.expectedRefusal !== undefined) {
				expect(c.engines).not.toContain(c.expectedRefusal.engine);
			}
		}
	});
});
