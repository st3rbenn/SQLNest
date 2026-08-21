import { describe, expect, it } from "vitest";
import { classifyRuntimeError } from "./rollbackClassify";
import { SnqlRuntimeError } from "./useRunQuery";

/**
 * Tests du classifier rollback [[ADR-023]] E/6.1. Couvre SQLSTATE PG (40*
 * et 25P0*) + codes/labels Mongo + fallback ordinary.
 */

function pgErr(code: string, message = "…"): SnqlRuntimeError {
	return new SnqlRuntimeError(message, {
		message,
		code
	});
}

function mongoErr(message: string): SnqlRuntimeError {
	return new SnqlRuntimeError(message);
}

describe("classifyRuntimeError — SQLSTATE PG rollback_error (classe 40)", () => {
	it("40P01 deadlock_detected → rollback_error", () => {
		expect(classifyRuntimeError(pgErr("40P01"))).toBe("rollback_error");
	});

	it("40001 serialization_failure → rollback_error", () => {
		expect(classifyRuntimeError(pgErr("40001"))).toBe("rollback_error");
	});

	it("40000 transaction_rollback générique → rollback_error", () => {
		expect(classifyRuntimeError(pgErr("40000"))).toBe("rollback_error");
	});

	it("40009 (classe 40 non-listée) → rollback_error par défaut classe 40", () => {
		expect(classifyRuntimeError(pgErr("40009"))).toBe("rollback_error");
	});
});

describe("classifyRuntimeError — SQLSTATE PG rollback_user (25P0*)", () => {
	it("25P01 no_active_sql_transaction → rollback_user", () => {
		expect(classifyRuntimeError(pgErr("25P01"))).toBe("rollback_user");
	});

	it("25P02 in_failed_sql_transaction → rollback_user", () => {
		expect(classifyRuntimeError(pgErr("25P02"))).toBe("rollback_user");
	});
});

describe("classifyRuntimeError — Mongo labels", () => {
	it("message contient 'WriteConflict' → rollback_error", () => {
		expect(
			classifyRuntimeError(
				mongoErr("MongoServerError: WriteConflict at collection users")
			)
		).toBe("rollback_error");
	});

	it("message contient 'TransactionAborted' → rollback_error", () => {
		expect(
			classifyRuntimeError(mongoErr("TransactionAborted: session expired"))
		).toBe("rollback_error");
	});

	it("message contient 'transient-transaction-error' label → rollback_error", () => {
		expect(
			classifyRuntimeError(
				mongoErr(
					"MongoError code 251 [transient-transaction-error]: retry"
				)
			)
		).toBe("rollback_error");
	});

	it("message contient 'code 112' → rollback_error (WriteConflict Mongo)", () => {
		expect(
			classifyRuntimeError(mongoErr("MongoError: code 112 - conflict"))
		).toBe("rollback_error");
	});

	it("message contient 'MongoError code: 251' → rollback_error", () => {
		expect(
			classifyRuntimeError(mongoErr("MongoError code: 251 aborted"))
		).toBe("rollback_error");
	});
});

describe("classifyRuntimeError — ordinary (fallback safe)", () => {
	it("SQLSTATE 23505 unique_violation → ordinary (contrainte hors tx = pas rollback)", () => {
		expect(classifyRuntimeError(pgErr("23505"))).toBe("ordinary");
	});

	it("SQLSTATE 42P01 undefined_table → ordinary", () => {
		expect(classifyRuntimeError(pgErr("42P01"))).toBe("ordinary");
	});

	it("SQLSTATE 42883 undefined_function → ordinary", () => {
		expect(classifyRuntimeError(pgErr("42883"))).toBe("ordinary");
	});

	it("Erreur sans pgError et message générique → ordinary", () => {
		expect(
			classifyRuntimeError(mongoErr("Connection refused"))
		).toBe("ordinary");
	});

	it("Erreur sans pgError, message vide → ordinary (safe fallback)", () => {
		expect(classifyRuntimeError(mongoErr(""))).toBe("ordinary");
	});

	it("Mongo code non-rollback (17280 = QueryFailed non-tx) → ordinary", () => {
		// 17280 n'est pas dans MONGO_ROLLBACK_ERROR_CODES et le message ne
		// contient aucun label rollback — safe fallback.
		expect(
			classifyRuntimeError(mongoErr("MongoError code 17280"))
		).toBe("ordinary");
	});
});
