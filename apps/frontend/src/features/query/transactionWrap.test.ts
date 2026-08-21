import { parse, tokenize } from "@sqlnest/snql";
import { describe, expect, it } from "vitest";
import {
	supportsTransactionsForEngine,
	wrapInTransaction
} from "./transactionWrap";

/**
 * Tests du helper `transactionWrap` [[ADR-023]] E/5.1. Couvre capability
 * check (Postgres/Mongo capable, KV non) + double-wrap detection D7
 * (source déjà transaction racine = no-op).
 */

describe("supportsTransactionsForEngine — capability statique SNQL", () => {
	it("postgres → true", () => {
		expect(supportsTransactionsForEngine("postgres")).toBe(true);
	});

	it("mongodb → true (Mongo replica set assumé, standalone TODO E/8)", () => {
		expect(supportsTransactionsForEngine("mongodb")).toBe(true);
	});

	it("kv (Redis-like) → false", () => {
		expect(supportsTransactionsForEngine("kv")).toBe(false);
	});

	it("engine inconnu → false (défensif, jamais silent-fail)", () => {
		expect(supportsTransactionsForEngine("neo4j-hypothetical")).toBe(false);
	});
});

describe("wrapInTransaction — cas de base", () => {
	function wrap(source: string) {
		return wrapInTransaction(source, parse(tokenize(source)));
	}

	it("delete simple → wrap avec braces + trim", () => {
		const r = wrap("remove from users where id = 42");
		expect(r.kind).toBe("wrap");
		expect(r.source).toBe(
			"transaction { remove from users where id = 42 }"
		);
	});

	it("update simple → wrap", () => {
		const r = wrap("update users set active = false");
		expect(r.kind).toBe("wrap");
		expect(r.source).toBe("transaction { update users set active = false }");
	});

	it("insert simple → wrap", () => {
		const r = wrap('add {id: 1, name: "x"} into t');
		expect(r.kind).toBe("wrap");
		expect(r.source).toBe('transaction { add {id: 1, name: "x"} into t }');
	});

	it("select → wrap quand même (ADR-023 ne restreint pas ⌘⇧⏎ aux writes)", () => {
		// L'user peut vouloir tester une lecture en isolation transactionnelle
		// (READ COMMITTED etc.). Pas de restriction UI.
		const r = wrap("find users pick id");
		expect(r.kind).toBe("wrap");
		expect(r.source).toBe("transaction { find users pick id }");
	});

	it("source avec espaces trailing / leading → trim avant wrap", () => {
		const r = wrap("   remove from users    ");
		expect(r.kind).toBe("wrap");
		expect(r.source).toBe("transaction { remove from users }");
	});
});

describe("wrapInTransaction — double-wrap detection (D7)", () => {
	function wrap(source: string) {
		return wrapInTransaction(source, parse(tokenize(source)));
	}

	it("transaction { … } racine → already_tx (no-op wrap, exec direct)", () => {
		const src = "transaction { remove from users; }";
		const r = wrap(src);
		expect(r.kind).toBe("already_tx");
		expect(r.source).toBe(src);
	});

	it("transaction avec isolation → already_tx", () => {
		const src = "transaction isolation serializable { remove from users; }";
		const r = wrap(src);
		expect(r.kind).toBe("already_tx");
	});

	it("transaction avec multiple stmts → already_tx (respect intention)", () => {
		const src = "transaction { remove from users; update orders set discount = 0; }";
		const r = wrap(src);
		expect(r.kind).toBe("already_tx");
	});
});
