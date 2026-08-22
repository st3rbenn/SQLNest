import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useConsolePersistence } from "./useConsolePersistence";

/**
 * Tests de la persistence — HistoryEntry + scoping per-connection +
 * migration soft depuis old string entries.
 */

const GLOBAL_KEY = "sqlnest:canvas-console:history";
function connKey(id: string): string {
	return `${GLOBAL_KEY}:${id}`;
}

beforeEach(() => {
	window.localStorage.clear();
});

describe("useConsolePersistence — addHistory + HistoryEntry", () => {
	it("addHistory sans meta → entry {source} seulement", () => {
		const { result } = renderHook(() =>
			useConsolePersistence("postgres", "conn-1")
		);
		act(() => result.current.addHistory("find users pick id"));
		expect(result.current.history).toHaveLength(1);
		expect(result.current.history[0]).toEqual({ source: "find users pick id" });
	});

	it("addHistory avec written=true → entry a le flag", () => {
		const { result } = renderHook(() =>
			useConsolePersistence("postgres", "conn-1")
		);
		act(() =>
			result.current.addHistory("update users set active = false where id = 1", {
				written: true,
				rolledBack: false
			})
		);
		expect(result.current.history[0]).toMatchObject({
			source: "update users set active = false where id = 1",
			written: true,
			rolledBack: false
		});
	});

	it("addHistory avec rolledBack=true → tracer le rollback", () => {
		const { result } = renderHook(() =>
			useConsolePersistence("postgres", "conn-1")
		);
		act(() =>
			result.current.addHistory("transaction { remove from users }", {
				written: true,
				rolledBack: true
			})
		);
		expect(result.current.history[0]).toMatchObject({
			written: true,
			rolledBack: true
		});
	});

	it("dédup par source — le récent l'emporte en tête + met à jour meta", () => {
		const { result } = renderHook(() =>
			useConsolePersistence("postgres", "conn-1")
		);
		act(() => result.current.addHistory("find users pick id"));
		act(() =>
			result.current.addHistory("find users pick id", {
				written: false
			})
		);
		expect(result.current.history).toHaveLength(1);
		expect(result.current.history[0]?.written).toBe(false);
	});
});

describe("useConsolePersistence — scoping per-connection (D9)", () => {
	it("conn-A et conn-B ont des histories séparés", () => {
		const { result: a } = renderHook(() =>
			useConsolePersistence("postgres", "conn-A")
		);
		const { result: b } = renderHook(() =>
			useConsolePersistence("postgres", "conn-B")
		);
		act(() => a.current.addHistory("query for conn A"));
		act(() => b.current.addHistory("query for conn B"));
		expect(a.current.history).toHaveLength(1);
		expect(b.current.history).toHaveLength(1);
		expect(a.current.history[0]?.source).toBe("query for conn A");
		expect(b.current.history[0]?.source).toBe("query for conn B");
	});

	it("connectionId absent → clé globale (fallback rétrocompat)", () => {
		const { result } = renderHook(() => useConsolePersistence("postgres"));
		act(() => result.current.addHistory("global query"));
		const raw = window.localStorage.getItem(GLOBAL_KEY);
		expect(raw).toContain("global query");
	});

	it("connectionId présent → clé scopée `history:<id>`", () => {
		const { result } = renderHook(() =>
			useConsolePersistence("postgres", "conn-42")
		);
		act(() => result.current.addHistory("scoped query"));
		const raw = window.localStorage.getItem(connKey("conn-42"));
		expect(raw).toContain("scoped query");
		expect(window.localStorage.getItem(GLOBAL_KEY)).toBeNull();
	});
});

describe("useConsolePersistence — migration soft old string[] → HistoryEntry[]", () => {
	it("Load anciennes entries string dans localStorage → upgrade en {source}", () => {
		window.localStorage.setItem(
			connKey("conn-1"),
			JSON.stringify(["find old query 1", "find old query 2"])
		);
		const { result } = renderHook(() =>
			useConsolePersistence("postgres", "conn-1")
		);
		expect(result.current.history).toEqual([
			{ source: "find old query 1" },
			{ source: "find old query 2" }
		]);
	});

	it("Mix string + HistoryEntry → tout est normalisé HistoryEntry", () => {
		window.localStorage.setItem(
			connKey("conn-1"),
			JSON.stringify([
				"legacy string",
				{ source: "already object", written: true, rolledBack: false }
			])
		);
		const { result } = renderHook(() =>
			useConsolePersistence("postgres", "conn-1")
		);
		expect(result.current.history[0]).toEqual({ source: "legacy string" });
		expect(result.current.history[1]).toMatchObject({
			source: "already object",
			written: true,
			rolledBack: false
		});
	});

	it("JSON corrompu → history vide (safe fallback)", () => {
		window.localStorage.setItem(connKey("conn-1"), "{not json");
		const { result } = renderHook(() =>
			useConsolePersistence("postgres", "conn-1")
		);
		expect(result.current.history).toEqual([]);
	});

	it("Entry sans source valide → filtrée", () => {
		window.localStorage.setItem(
			connKey("conn-1"),
			JSON.stringify([
				{ source: "ok" },
				{ noSource: true },
				null,
				{ source: 42 }
			])
		);
		const { result } = renderHook(() =>
			useConsolePersistence("postgres", "conn-1")
		);
		expect(result.current.history).toEqual([{ source: "ok" }]);
	});
});

describe("useConsolePersistence — clearHistory", () => {
	it("clearHistory vide le state + localStorage de la clé courante", () => {
		const { result } = renderHook(() =>
			useConsolePersistence("postgres", "conn-1")
		);
		act(() => result.current.addHistory("a"));
		act(() => result.current.addHistory("b"));
		expect(result.current.history).toHaveLength(2);
		act(() => result.current.clearHistory());
		expect(result.current.history).toEqual([]);
	});
});
