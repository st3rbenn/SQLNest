import {
	getMapper,
	lower,
	MONGODB_CAPABILITIES,
	parse,
	type Row,
	tokenize
} from "@sqlnest/snql";
import { describe, expect, it } from "vitest";
import type { Connection } from "../adapter";
import { EngineExecutionError } from "../errors";
import {
	DEFAULT_MATERIALIZE_MAX_ROWS,
	materializeSubplan,
	RUNTIME_MONGO_MATERIALIZE_OVERFLOW
} from "./materialize";

/**
 * Stub Connection pour tester `materializeSubplan` sans driver. On mock
 * uniquement `execute` — c'est la seule surface consommée par la fonction.
 */
function stubConnection(rowsToReturn: readonly Row[]): Connection {
	return {
		engine: "mongodb",
		async ping() {
			return { latencyMs: 0 };
		},
		async introspect() {
			throw new Error("not called");
		},
		async execute() {
			return {
				columns: [],
				rows: rowsToReturn,
				rowCount: rowsToReturn.length
			};
		},
		async fingerprint() {
			return "mongo:stub/test";
		},
		async close() {}
	};
}

describe("materializeSubplan (ADR-024 D1)", () => {
	const mongoMapper = getMapper("mongodb");

	it("exécute nativement et retourne les rows du connection", async () => {
		const source = "find users pick id, email";
		const subplan = lower(parse(tokenize(source)));
		const stubRows: Row[] = [
			{ id: 1, email: "a@x" },
			{ id: 2, email: "b@x" }
		];
		const rows = await materializeSubplan(
			subplan,
			stubConnection(stubRows),
			undefined,
			MONGODB_CAPABILITIES,
			mongoMapper
		);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toEqual({ id: 1, email: "a@x" });
	});

	it("court-circuit CTE : scan direct sur un CTE matérialisé → pas d'appel driver", async () => {
		const source = "find friends pick id, name";
		const subplan = lower(parse(tokenize(source)));
		const cteRows: Row[] = [
			{ id: 10, name: "alice" },
			{ id: 11, name: "bob" }
		];
		const materialized = new Map<string, readonly Row[]>([
			["friends", cteRows]
		]);
		// Connection qui throw si `execute` est appelé — vérifie le court-circuit.
		const trap: Connection = {
			engine: "mongodb",
			async ping() {
				return { latencyMs: 0 };
			},
			async introspect() {
				throw new Error("not called");
			},
			async execute() {
				throw new Error(
					"materializeSubplan devrait court-circuiter (CTE en RAM)"
				);
			},
			async fingerprint() {
				return "mongo:stub/test";
			},
			async close() {}
		};
		const rows = await materializeSubplan(
			subplan,
			trap,
			undefined,
			MONGODB_CAPABILITIES,
			mongoMapper,
			{ materialized }
		);
		expect(rows).toEqual(cteRows);
	});

	it("court-circuit CTE + compensation : applique les stages post-scan sur les rows RAM", async () => {
		const source = "find friends where id > 10 pick id";
		const subplan = lower(parse(tokenize(source)));
		const cteRows: Row[] = [
			{ id: 10, name: "a" },
			{ id: 11, name: "b" },
			{ id: 12, name: "c" }
		];
		const materialized = new Map<string, readonly Row[]>([
			["friends", cteRows]
		]);
		const rows = await materializeSubplan(
			subplan,
			stubConnection([]),
			undefined,
			MONGODB_CAPABILITIES,
			mongoMapper,
			{ materialized }
		);
		expect(rows.map((r) => r.id)).toEqual([11, 12]);
	});

	it("D4 — refuse au-dessus du cap avec code runtime_mongo_materialize_overflow", async () => {
		const source = "find users pick id";
		const subplan = lower(parse(tokenize(source)));
		const bigStub: Row[] = Array.from({ length: 20 }, (_, i) => ({ id: i }));
		try {
			await materializeSubplan(
				subplan,
				stubConnection(bigStub),
				undefined,
				MONGODB_CAPABILITIES,
				mongoMapper,
				{ maxRows: 10 }
			);
			expect.fail("expected overflow throw");
		} catch (e) {
			expect(e).toBeInstanceOf(EngineExecutionError);
			expect((e as Error).message).toContain(
				RUNTIME_MONGO_MATERIALIZE_OVERFLOW
			);
			expect((e as Error).message).toContain("20 rows");
			expect((e as Error).message).toContain("10");
		}
	});

	it("D4 — cap défaut = 1_000_000 (constante exportée)", () => {
		expect(DEFAULT_MATERIALIZE_MAX_ROWS).toBe(1_000_000);
	});

	it("D4 — sous le cap : passe silencieusement", async () => {
		const source = "find users pick id";
		const subplan = lower(parse(tokenize(source)));
		const smallStub: Row[] = [{ id: 1 }, { id: 2 }];
		const rows = await materializeSubplan(
			subplan,
			stubConnection(smallStub),
			undefined,
			MONGODB_CAPABILITIES,
			mongoMapper,
			{ maxRows: 100 }
		);
		expect(rows).toHaveLength(2);
	});

	it("D4 — le cap s'applique aussi au chemin CTE court-circuit", async () => {
		const source = "find big_cte pick id";
		const subplan = lower(parse(tokenize(source)));
		const cteRows: Row[] = Array.from({ length: 5 }, (_, i) => ({ id: i }));
		const materialized = new Map<string, readonly Row[]>([
			["big_cte", cteRows]
		]);
		try {
			await materializeSubplan(
				subplan,
				stubConnection([]),
				undefined,
				MONGODB_CAPABILITIES,
				mongoMapper,
				{ maxRows: 3, materialized }
			);
			expect.fail("expected overflow throw");
		} catch (e) {
			expect(e).toBeInstanceOf(EngineExecutionError);
			expect((e as Error).message).toContain(
				RUNTIME_MONGO_MATERIALIZE_OVERFLOW
			);
		}
	});
});
