import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SchemaModel } from "./schema-model";
import { useTablePositions } from "./useTablePositions";

function coll(name: string): SchemaModel["collections"][number] {
	return { name, fields: [], source: "declared" };
}

const SCHEMA_A: SchemaModel = {
	engine: "postgres",
	collections: [coll("users"), coll("orders")],
	relations: []
};

const SCHEMA_B: SchemaModel = {
	engine: "postgres",
	collections: [coll("alpha"), coll("beta"), coll("gamma")],
	relations: []
};

function storageKey(schema: SchemaModel): string {
	const names = schema.collections
		.map((c) => c.name)
		.slice()
		.sort()
		.join(",");
	return `sqlnest:positions:${schema.engine}:${names}`;
}

describe("useTablePositions", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});
	afterEach(() => {
		window.localStorage.clear();
		vi.restoreAllMocks();
	});

	it("starts with an empty map when localStorage is empty", () => {
		const { result } = renderHook(() => useTablePositions(SCHEMA_A));
		expect(result.current.positions).toEqual({});
	});

	it("initialises from localStorage when a payload exists", () => {
		const stored = { users: { x: 10, y: 20 }, orders: { x: 30, y: 40 } };
		window.localStorage.setItem(storageKey(SCHEMA_A), JSON.stringify(stored));
		const { result } = renderHook(() => useTablePositions(SCHEMA_A));
		expect(result.current.positions).toEqual(stored);
	});

	it("falls back to {} when the stored JSON is corrupt", () => {
		window.localStorage.setItem(storageKey(SCHEMA_A), "{not json");
		const { result } = renderHook(() => useTablePositions(SCHEMA_A));
		expect(result.current.positions).toEqual({});
	});

	it("swallows storage errors during init and returns {}", () => {
		const spy = vi
			.spyOn(Storage.prototype, "getItem")
			.mockImplementation(() => {
				throw new Error("SecurityError");
			});
		const { result } = renderHook(() => useTablePositions(SCHEMA_A));
		expect(result.current.positions).toEqual({});
		spy.mockRestore();
	});

	it("setPosition updates one entry and persists to localStorage", () => {
		const { result } = renderHook(() => useTablePositions(SCHEMA_A));
		act(() => {
			result.current.setPosition("users", { x: 1, y: 2 });
		});
		expect(result.current.positions).toEqual({ users: { x: 1, y: 2 } });
		const raw = window.localStorage.getItem(storageKey(SCHEMA_A));
		expect(raw).not.toBeNull();
		expect(JSON.parse(raw ?? "{}")).toEqual({ users: { x: 1, y: 2 } });
	});

	it("setManyPositions merges entries with the current map", () => {
		const { result } = renderHook(() => useTablePositions(SCHEMA_A));
		act(() => {
			result.current.setPosition("users", { x: 1, y: 2 });
		});
		act(() => {
			result.current.setManyPositions({
				orders: { x: 3, y: 4 },
				users: { x: 100, y: 200 }
			});
		});
		expect(result.current.positions).toEqual({
			users: { x: 100, y: 200 },
			orders: { x: 3, y: 4 }
		});
	});

	it("swallows storage errors during persistence (quota / private mode)", () => {
		const { result } = renderHook(() => useTablePositions(SCHEMA_A));
		const spy = vi
			.spyOn(Storage.prototype, "setItem")
			.mockImplementation(() => {
				throw new Error("QuotaExceeded");
			});
		expect(() =>
			act(() => {
				result.current.setPosition("users", { x: 1, y: 2 });
			})
		).not.toThrow();
		expect(result.current.positions).toEqual({ users: { x: 1, y: 2 } });
		spy.mockRestore();
	});

	it("re-seeds to {} when the schema signature changes and no storage exists for the new key", () => {
		const { result, rerender } = renderHook(
			({ schema }: { schema: SchemaModel }) => useTablePositions(schema),
			{ initialProps: { schema: SCHEMA_A } }
		);
		act(() => {
			result.current.setPosition("users", { x: 1, y: 2 });
		});
		expect(result.current.positions).toEqual({ users: { x: 1, y: 2 } });
		rerender({ schema: SCHEMA_B });
		expect(result.current.positions).toEqual({});
	});

	it("re-hydrates from localStorage when switching to a schema with a stored key", () => {
		const stored = { alpha: { x: 7, y: 8 } };
		window.localStorage.setItem(storageKey(SCHEMA_B), JSON.stringify(stored));
		const { result, rerender } = renderHook(
			({ schema }: { schema: SchemaModel }) => useTablePositions(schema),
			{ initialProps: { schema: SCHEMA_A } }
		);
		rerender({ schema: SCHEMA_B });
		expect(result.current.positions).toEqual(stored);
	});

	it("replaceAll remplace intégralement le state (pas de merge)", () => {
		const { result } = renderHook(() => useTablePositions(SCHEMA_A));
		act(() => {
			result.current.setPosition("users", { x: 1, y: 2 });
			result.current.setPosition("orders", { x: 3, y: 4 });
		});
		act(() => {
			result.current.replaceAll({ users: { x: 999, y: 999 } });
		});
		// `orders` a disparu — c'est bien un remplacement, pas un merge.
		expect(result.current.positions).toEqual({ users: { x: 999, y: 999 } });
	});

	it("replaceAll déclenche la persistance localStorage", () => {
		const { result } = renderHook(() => useTablePositions(SCHEMA_A));
		act(() => {
			result.current.replaceAll({ alpha: { x: 10, y: 20 } });
		});
		const raw = window.localStorage.getItem(storageKey(SCHEMA_A));
		expect(raw).not.toBeNull();
		expect(JSON.parse(raw ?? "{}")).toEqual({ alpha: { x: 10, y: 20 } });
	});

	it("replaceAll avec le state courant est idempotent (pas d'erreur)", () => {
		const { result } = renderHook(() => useTablePositions(SCHEMA_A));
		act(() => {
			result.current.setPosition("users", { x: 1, y: 2 });
		});
		const before = result.current.positions;
		expect(() =>
			act(() => {
				result.current.replaceAll(before);
			})
		).not.toThrow();
		expect(result.current.positions).toEqual(before);
	});

	it("re-seed falls back to {} when stored JSON is corrupt for the new key", () => {
		window.localStorage.setItem(storageKey(SCHEMA_B), "not-json");
		const { result, rerender } = renderHook(
			({ schema }: { schema: SchemaModel }) => useTablePositions(schema),
			{ initialProps: { schema: SCHEMA_A } }
		);
		act(() => {
			result.current.setPosition("users", { x: 1, y: 2 });
		});
		rerender({ schema: SCHEMA_B });
		expect(result.current.positions).toEqual({});
	});
});
