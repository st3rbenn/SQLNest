import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SchemaModel } from "./schema-model";
import { useTableSizes } from "./useTableSizes";

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
	return `sqlnest:sizes:${schema.engine}:${names}`;
}

describe("useTableSizes", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});
	afterEach(() => {
		window.localStorage.clear();
		vi.restoreAllMocks();
	});

	it("starts with an empty map when localStorage is empty", () => {
		const { result } = renderHook(() => useTableSizes(SCHEMA_A));
		expect(result.current.sizes).toEqual({});
	});

	it("initialises from localStorage when a payload exists", () => {
		const stored = {
			users: { width: 300, height: 200 },
			orders: { width: 260 }
		};
		window.localStorage.setItem(storageKey(SCHEMA_A), JSON.stringify(stored));
		const { result } = renderHook(() => useTableSizes(SCHEMA_A));
		expect(result.current.sizes).toEqual(stored);
	});

	it("falls back to {} when the stored JSON is corrupt", () => {
		window.localStorage.setItem(storageKey(SCHEMA_A), "{not json");
		const { result } = renderHook(() => useTableSizes(SCHEMA_A));
		expect(result.current.sizes).toEqual({});
	});

	it("swallows storage errors during init and returns {}", () => {
		const spy = vi
			.spyOn(Storage.prototype, "getItem")
			.mockImplementation(() => {
				throw new Error("SecurityError");
			});
		const { result } = renderHook(() => useTableSizes(SCHEMA_A));
		expect(result.current.sizes).toEqual({});
		spy.mockRestore();
	});

	it("setSize stores an entry and persists to localStorage", () => {
		const { result } = renderHook(() => useTableSizes(SCHEMA_A));
		act(() => {
			result.current.setSize("users", { width: 320, height: 180 });
		});
		expect(result.current.sizes).toEqual({
			users: { width: 320, height: 180 }
		});
		const raw = window.localStorage.getItem(storageKey(SCHEMA_A));
		expect(raw).not.toBeNull();
		expect(JSON.parse(raw ?? "{}")).toEqual({
			users: { width: 320, height: 180 }
		});
	});

	it("setSize can overwrite an existing entry (partial width-only)", () => {
		const { result } = renderHook(() => useTableSizes(SCHEMA_A));
		act(() => {
			result.current.setSize("users", { width: 320, height: 180 });
		});
		act(() => {
			result.current.setSize("users", { width: 400 });
		});
		expect(result.current.sizes.users).toEqual({ width: 400 });
	});

	it("setSize keeps unrelated entries untouched", () => {
		const { result } = renderHook(() => useTableSizes(SCHEMA_A));
		act(() => {
			result.current.setSize("users", { width: 320 });
		});
		act(() => {
			result.current.setSize("orders", { height: 100 });
		});
		expect(result.current.sizes).toEqual({
			users: { width: 320 },
			orders: { height: 100 }
		});
	});

	it("swallows storage errors during persistence (quota / private mode)", () => {
		const { result } = renderHook(() => useTableSizes(SCHEMA_A));
		const spy = vi
			.spyOn(Storage.prototype, "setItem")
			.mockImplementation(() => {
				throw new Error("QuotaExceeded");
			});
		expect(() =>
			act(() => {
				result.current.setSize("users", { width: 320 });
			})
		).not.toThrow();
		expect(result.current.sizes).toEqual({ users: { width: 320 } });
		spy.mockRestore();
	});

	it("re-seeds to {} when the schema signature changes and no storage exists for the new key", () => {
		const { result, rerender } = renderHook(
			({ schema }: { schema: SchemaModel }) => useTableSizes(schema),
			{ initialProps: { schema: SCHEMA_A } }
		);
		act(() => {
			result.current.setSize("users", { width: 320 });
		});
		expect(result.current.sizes).toEqual({ users: { width: 320 } });
		rerender({ schema: SCHEMA_B });
		expect(result.current.sizes).toEqual({});
	});

	it("re-hydrates from localStorage when switching to a schema with a stored key", () => {
		const stored = { alpha: { width: 200, height: 120 } };
		window.localStorage.setItem(storageKey(SCHEMA_B), JSON.stringify(stored));
		const { result, rerender } = renderHook(
			({ schema }: { schema: SchemaModel }) => useTableSizes(schema),
			{ initialProps: { schema: SCHEMA_A } }
		);
		rerender({ schema: SCHEMA_B });
		expect(result.current.sizes).toEqual(stored);
	});

	it("replaceAll remplace intégralement le state (pas de merge)", () => {
		const { result } = renderHook(() => useTableSizes(SCHEMA_A));
		act(() => {
			result.current.setSize("users", { width: 320 });
			result.current.setSize("orders", { width: 260 });
		});
		act(() => {
			result.current.replaceAll({ users: { width: 999 } });
		});
		// `orders` a disparu — c'est bien un remplacement, pas un merge.
		expect(result.current.sizes).toEqual({ users: { width: 999 } });
	});

	it("replaceAll déclenche la persistance localStorage", () => {
		const { result } = renderHook(() => useTableSizes(SCHEMA_A));
		act(() => {
			result.current.replaceAll({ alpha: { width: 100, height: 50 } });
		});
		const raw = window.localStorage.getItem(storageKey(SCHEMA_A));
		expect(raw).not.toBeNull();
		expect(JSON.parse(raw ?? "{}")).toEqual({
			alpha: { width: 100, height: 50 }
		});
	});

	it("replaceAll avec le state courant est idempotent (pas d'erreur)", () => {
		const { result } = renderHook(() => useTableSizes(SCHEMA_A));
		act(() => {
			result.current.setSize("users", { width: 320 });
		});
		const before = result.current.sizes;
		expect(() =>
			act(() => {
				result.current.replaceAll(before);
			})
		).not.toThrow();
		expect(result.current.sizes).toEqual(before);
	});

	it("re-seed falls back to {} when stored JSON is corrupt for the new key", () => {
		window.localStorage.setItem(storageKey(SCHEMA_B), "not-json");
		const { result, rerender } = renderHook(
			({ schema }: { schema: SchemaModel }) => useTableSizes(schema),
			{ initialProps: { schema: SCHEMA_A } }
		);
		act(() => {
			result.current.setSize("users", { width: 320 });
		});
		rerender({ schema: SCHEMA_B });
		expect(result.current.sizes).toEqual({});
	});
});
