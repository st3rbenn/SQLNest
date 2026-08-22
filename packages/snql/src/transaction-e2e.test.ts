/**
 * Transaction bloc atomique (`transaction [isolation …] { stmt; stmt }`).
 *
 * Couvre :
 *  - lexer   : ; = semicolon token
 *  - parser  : transaction body avec ; obligatoire, isolation levels, savepoint blocks
 *  - lower   : TransactionPlan + items {read|write|savepoint}
 *  - codegen : SqlTransaction avec steps flat (statement + savepoint-begin/release)
 *  - planner : capability `transaction` PG only
 *  - refus   : txn imbriquées, ; manquant, body vide, isolation invalide
 */

import { describe, expect, it } from "vitest";
import { SnqlError } from "./diagnostics";
import {
	assertTransactionSupported,
	getMapper,
	KV_CAPABILITIES,
	lowerTransaction,
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
			primaryKey: ["id"],
			fields: [
				{ name: "id", type: "bigint", nullable: false, source: "declared" },
				{ name: "email", type: "string", nullable: false, source: "declared" },
				{ name: "is_active", type: "bool", nullable: false, source: "declared" }
			]
		}
	],
	relations: []
};

function pgTx(source: string, schema?: SchemaModel): {
	kind: "transaction";
	isolation?: string;
	steps: readonly unknown[];
} {
	const stmt = parse(tokenize(source));
	if (stmt.operation !== "transaction") throw new Error("transaction attendue");
	const planned = lowerTransaction(stmt, schema);
	const mapper = getMapper("postgres");
	if (mapper.mapTransaction === undefined) throw new Error("no mapTransaction");
	const native = mapper.mapTransaction(planned);
	return {
		kind: native.kind,
		...(native.isolation !== undefined ? { isolation: native.isolation } : {}),
		steps: native.steps
	};
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
// Lexer : semicolon
// ═══════════════════════════════════════════════════════════════════════════

describe("lexer — semicolon", () => {
	it("`;` tokenisé comme kind='semicolon'", () => {
		const toks = tokenize(";").filter((t) => t.kind !== "eof");
		expect(toks).toHaveLength(1);
		expect(toks[0]?.kind).toBe("semicolon");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Parser
// ═══════════════════════════════════════════════════════════════════════════

describe("parser — transaction bloc", () => {
	it("transaction { stmt } single", () => {
		const stmt = parse(tokenize("transaction { find users pick id }"));
		if (stmt.operation !== "transaction") throw new Error();
		expect(stmt.body).toHaveLength(1);
	});

	it("transaction { stmt; stmt; stmt } multi avec; obligatoire", () => {
		const stmt = parse(
			tokenize(
				'transaction { find users pick id; update users set is_active = true; remove from users where id = 999 }'
			)
		);
		if (stmt.operation !== "transaction") throw new Error();
		expect(stmt.body).toHaveLength(3);
	});

	it("trailing; toléré", () => {
		const stmt = parse(
			tokenize("transaction { find users pick id; find users pick email; }")
		);
		if (stmt.operation !== "transaction") throw new Error();
		expect(stmt.body).toHaveLength(2);
	});

	it("isolation read committed", () => {
		const stmt = parse(
			tokenize("transaction isolation read committed { find users pick id }")
		);
		if (stmt.operation !== "transaction") throw new Error();
		expect(stmt.isolation).toBe("read_committed");
	});

	it("isolation repeatable read", () => {
		const stmt = parse(
			tokenize("transaction isolation repeatable read { find users pick id }")
		);
		if (stmt.operation !== "transaction") throw new Error();
		expect(stmt.isolation).toBe("repeatable_read");
	});

	it("isolation serializable", () => {
		const stmt = parse(
			tokenize("transaction isolation serializable { find users pick id }")
		);
		if (stmt.operation !== "transaction") throw new Error();
		expect(stmt.isolation).toBe("serializable");
	});

	it("savepoint bloc dans transaction", () => {
		const stmt = parse(
			tokenize(
				'transaction { find users pick id; savepoint sp1 { update users set is_active = true } }'
			)
		);
		if (stmt.operation !== "transaction") throw new Error();
		expect(stmt.body).toHaveLength(2);
		const sp = stmt.body[1];
		if (sp?.operation !== "savepoint") throw new Error();
		expect(sp.name).toBe("sp1");
	});

	it("refus body vide", () => {
		expectCode(
			() => parse(tokenize("transaction { }")),
			"parse_transaction_empty"
		);
	});

	it("refus; manquant entre stmts", () => {
		expectCode(
			() => parse(tokenize("transaction { find users pick id find users pick email }")),
			"parse_transaction_missing_semicolon"
		);
	});

	it("refus transaction imbriquée", () => {
		expectCode(
			() =>
				parse(
					tokenize("transaction { transaction { find users pick id } }")
				),
			"parse_transaction_nested"
		);
	});

	it("refus isolation level invalide", () => {
		expectCode(
			() =>
				parse(
					tokenize("transaction isolation snapshot { find users pick id }")
				),
			"parse_isolation_level"
		);
	});

	it("refus savepoint body vide", () => {
		expectCode(
			() =>
				parse(
					tokenize("transaction { savepoint sp1 { } }")
				),
			"parse_savepoint_empty"
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Codegen PG : SqlTransaction shape
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen PG — SqlTransaction steps", () => {
	it("simple : 2 statements → 2 steps", () => {
		const tx = pgTx(
			'transaction { find users pick id; update users set is_active = true }'
		);
		expect(tx.kind).toBe("transaction");
		expect(tx.isolation).toBeUndefined();
		expect(tx.steps).toHaveLength(2);
		const step0 = tx.steps[0] as { kind: string; query: { text: string } };
		const step1 = tx.steps[1] as { kind: string; query: { text: string } };
		expect(step0.kind).toBe("statement");
		expect(step0.query.text).toContain('SELECT "id" FROM "users"');
		expect(step1.kind).toBe("statement");
		expect(step1.query.text).toContain('UPDATE "users" SET "is_active"');
	});

	it("isolation propagée sur SqlTransaction", () => {
		const tx = pgTx(
			'transaction isolation serializable { find users pick id }'
		);
		expect(tx.isolation).toBe("serializable");
	});

	it("savepoint → steps sp-begin / statements / sp-release", () => {
		const tx = pgTx(
			'transaction { find users pick id; savepoint sp1 { update users set is_active = true } }'
		);
		expect(tx.steps).toHaveLength(4);
		expect((tx.steps[0] as { kind: string }).kind).toBe("statement");
		expect(tx.steps[1]).toEqual({ kind: "savepoint-begin", name: "sp1" });
		expect((tx.steps[2] as { kind: string }).kind).toBe("statement");
		expect(tx.steps[3]).toEqual({ kind: "savepoint-release", name: "sp1" });
	});

	it("params scopés par statement — pas d'accumulation cross-step", () => {
		const tx = pgTx(
			'transaction { find users where id = 1 pick id; update users where id = 2 set is_active = false }'
		);
		const step0 = tx.steps[0] as { query: { text: string; params: readonly unknown[] } };
		const step1 = tx.steps[1] as { query: { text: string; params: readonly unknown[] } };
		// Chaque statement redémarre à $1 (params par step).
		expect(step0.query.text).toContain("$1");
		expect(step0.query.params).toEqual([1]);
		expect(step1.query.text).toContain("$1");
		expect(step1.query.params).toEqual([false, 2]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Planner : capability transaction
// ═══════════════════════════════════════════════════════════════════════════

describe("planner — capability 'transaction'", () => {
	// TxMongo : Mongo a la capability 'transaction' (via replica set côté serveur),
	// donc la vérification passe — plus de refus au planner.
	it("Mongo accepte transaction (RS required côté serveur)", () => {
		const stmt = parse(tokenize("transaction { find users pick id }"));
		if (stmt.operation !== "transaction") throw new Error();
		const planned = lowerTransaction(stmt);
		expect(() =>
			assertTransactionSupported(planned, MONGODB_CAPABILITIES)
		).not.toThrow();
	});

	it("KV refuse transaction", () => {
		const stmt = parse(tokenize("transaction { find users pick id }"));
		if (stmt.operation !== "transaction") throw new Error();
		const planned = lowerTransaction(stmt);
		expectCode(
			() => assertTransactionSupported(planned, KV_CAPABILITIES),
			"planner_transaction_unsupported"
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Lower : typecheck propagé
// ═══════════════════════════════════════════════════════════════════════════

describe("lower — typecheck propagé aux stmts internes", () => {
	it("cross-type predicate dans un stmt interne remonte proprement", () => {
		expectCode(
			() =>
				pgTx(
					'transaction { find users where id = "abc" pick id }',
					SCHEMA
				),
			"lower_type_mismatch_compare"
		);
	});
});
