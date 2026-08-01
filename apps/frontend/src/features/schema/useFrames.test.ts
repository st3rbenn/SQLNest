import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Frame } from "./frames";
import type { SchemaModel } from "./schema-model";
import { nextHue, nextLabel, useFrames } from "./useFrames";

// FRAME_HUES : users=210, commerce=30, analytics=262, crossrefs=340, events=275, xref=155.
const HUE_POOL = [210, 30, 262, 340, 275, 155] as const;

function makeFrame(overrides: Partial<Frame> & { key: string }): Frame {
	return {
		key: overrides.key,
		label: overrides.label ?? overrides.key,
		hue: overrides.hue ?? HUE_POOL[0],
		collections: overrides.collections ?? [],
		...(overrides.rect !== undefined ? { rect: overrides.rect } : {})
	};
}

function coll(name: string): SchemaModel["collections"][number] {
	return { name, fields: [], source: "declared" };
}

/** Schéma "sample" — frames par défaut = users + commerce (2 frames). */
const SAMPLE_SCHEMA: SchemaModel = {
	engine: "postgres",
	collections: [
		coll("users"),
		coll("orders"),
		coll("products"),
		coll("order_items"),
		coll("carts")
	],
	relations: []
};

/** Schéma hors sample — framesFor renvoie `[]`. */
const CUSTOM_SCHEMA: SchemaModel = {
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
	return `sqlnest:frames:${schema.engine}:${names}`;
}

describe("nextHue", () => {
	it("returns the first hue when no frames exist", () => {
		expect(nextHue([])).toBe(HUE_POOL[0]);
	});

	it("prefers the least-used hue in the pool", () => {
		const frames = [
			makeFrame({ key: "a", hue: 210 }),
			makeFrame({ key: "b", hue: 30 })
		];
		expect(HUE_POOL.slice(2)).toContain(nextHue(frames));
	});

	it("cycles back to a used hue once all are used at least once", () => {
		const frames = HUE_POOL.map((h, i) => makeFrame({ key: `f${i}`, hue: h }));
		// Toutes les teintes sont utilisées 1×. Ré-attribuer une teinte du pool
		// est acceptable (aucune n'est "moins utilisée").
		expect(HUE_POOL).toContain(nextHue(frames));
	});
});

describe("nextLabel", () => {
	it("returns 'Frame 1' when the list is empty", () => {
		expect(nextLabel([])).toBe("Frame 1");
	});

	it("skips labels already taken", () => {
		const frames = [
			makeFrame({ key: "a", label: "Frame 1" }),
			makeFrame({ key: "b", label: "Frame 2" })
		];
		expect(nextLabel(frames)).toBe("Frame 3");
	});

	it("does not collide with a custom label", () => {
		const frames = [makeFrame({ key: "a", label: "Utilisateurs" })];
		expect(nextLabel(frames)).toBe("Frame 1");
	});

	it("fills gaps left by removed frames", () => {
		const frames = [
			makeFrame({ key: "a", label: "Frame 1" }),
			makeFrame({ key: "c", label: "Frame 3" })
		];
		expect(nextLabel(frames)).toBe("Frame 2");
	});
});

describe("useFrames", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});
	afterEach(() => {
		window.localStorage.clear();
	});

	it("seeds from framesFor(schema) at first render for a sample schema", () => {
		const { result } = renderHook(() => useFrames(SAMPLE_SCHEMA));
		expect(result.current.frames.map((f) => f.key)).toEqual([
			"users",
			"commerce"
		]);
	});

	it("returns an empty list for a schema outside the sample", () => {
		const { result } = renderHook(() => useFrames(CUSTOM_SCHEMA));
		expect(result.current.frames).toEqual([]);
	});

	it("initialises from localStorage when present", () => {
		const persisted: Frame[] = [
			{ key: "persisted", label: "Persisted", hue: 42, collections: ["users"] }
		];
		window.localStorage.setItem(
			storageKey(SAMPLE_SCHEMA),
			JSON.stringify(persisted)
		);
		const { result } = renderHook(() => useFrames(SAMPLE_SCHEMA));
		expect(result.current.frames).toEqual(persisted);
	});

	it("falls back to seeds when localStorage payload is corrupt", () => {
		window.localStorage.setItem(storageKey(SAMPLE_SCHEMA), "{not json");
		const { result } = renderHook(() => useFrames(SAMPLE_SCHEMA));
		expect(result.current.frames.map((f) => f.key)).toEqual([
			"users",
			"commerce"
		]);
	});

	it("persists every mutation to localStorage under the schema key", () => {
		const { result } = renderHook(() => useFrames(SAMPLE_SCHEMA));
		act(() => {
			result.current.createFrame(["users"], { label: "Neuf" });
		});
		const raw = window.localStorage.getItem(storageKey(SAMPLE_SCHEMA));
		expect(raw).not.toBeNull();
		const parsed = JSON.parse(raw ?? "[]") as Frame[];
		expect(parsed.some((f) => f.label === "Neuf")).toBe(true);
	});

	it("createFrame adds a new frame and returns it", () => {
		const { result } = renderHook(() => useFrames(CUSTOM_SCHEMA));
		let created: Frame | undefined;
		act(() => {
			created = result.current.createFrame(["alpha"], { label: "A" });
		});
		expect(created?.label).toBe("A");
		expect(created?.collections).toEqual(["alpha"]);
		expect(result.current.frames).toHaveLength(1);
		expect(result.current.frames[0]?.key).toBe(created?.key);
	});

	it("createFrame detaches its tables from any prior frame (one table = one frame)", () => {
		const { result } = renderHook(() => useFrames(CUSTOM_SCHEMA));
		act(() => {
			result.current.createFrame(["alpha", "beta"], { label: "First" });
		});
		act(() => {
			result.current.createFrame(["beta"], { label: "Second" });
		});
		const first = result.current.frames.find((f) => f.label === "First");
		const second = result.current.frames.find((f) => f.label === "Second");
		expect(first?.collections).toEqual(["alpha"]);
		expect(second?.collections).toEqual(["beta"]);
	});

	it("createFrame de-duplicates its input table list", () => {
		const { result } = renderHook(() => useFrames(CUSTOM_SCHEMA));
		let created: Frame | undefined;
		act(() => {
			created = result.current.createFrame(["alpha", "alpha", "beta"]);
		});
		expect(created?.collections).toEqual(["alpha", "beta"]);
	});

	it("createFrame accepts a rect option and persists it", () => {
		const { result } = renderHook(() => useFrames(CUSTOM_SCHEMA));
		let created: Frame | undefined;
		act(() => {
			created = result.current.createFrame(["alpha"], {
				rect: { x: 10, y: 20, width: 100, height: 50 }
			});
		});
		expect(created?.rect).toEqual({ x: 10, y: 20, width: 100, height: 50 });
	});

	it("removeFrame drops the target frame", () => {
		const { result } = renderHook(() => useFrames(SAMPLE_SCHEMA));
		act(() => {
			result.current.removeFrame("users");
		});
		expect(result.current.frames.map((f) => f.key)).toEqual(["commerce"]);
	});

	it("renameFrame updates only the target frame's label", () => {
		const { result } = renderHook(() => useFrames(SAMPLE_SCHEMA));
		act(() => {
			result.current.renameFrame("users", "People");
		});
		const users = result.current.frames.find((f) => f.key === "users");
		const commerce = result.current.frames.find((f) => f.key === "commerce");
		expect(users?.label).toBe("People");
		expect(commerce?.label).toBe("Commerce");
	});

	it("removeTableFromFrame detaches the table but keeps the frame", () => {
		const { result } = renderHook(() => useFrames(SAMPLE_SCHEMA));
		act(() => {
			result.current.removeTableFromFrame("orders");
		});
		const commerce = result.current.frames.find((f) => f.key === "commerce");
		expect(commerce).toBeDefined();
		expect(commerce?.collections).not.toContain("orders");
	});

	it("addTableToFrame moves a table between frames (invariant: one frame per table)", () => {
		const { result } = renderHook(() => useFrames(SAMPLE_SCHEMA));
		act(() => {
			result.current.addTableToFrame("users", "orders");
		});
		const users = result.current.frames.find((f) => f.key === "users");
		const commerce = result.current.frames.find((f) => f.key === "commerce");
		expect(users?.collections).toContain("orders");
		expect(commerce?.collections).not.toContain("orders");
	});

	it("addTableToFrame is a no-op when the table already belongs to the target frame", () => {
		const { result } = renderHook(() => useFrames(SAMPLE_SCHEMA));
		const before = result.current.frames;
		act(() => {
			result.current.addTableToFrame("users", "users");
		});
		expect(result.current.frames).toEqual(before);
	});

	it("setFrameRect stores the rect on the target frame", () => {
		const { result } = renderHook(() => useFrames(SAMPLE_SCHEMA));
		act(() => {
			result.current.setFrameRect("users", {
				x: 5,
				y: 10,
				width: 200,
				height: 120
			});
		});
		const users = result.current.frames.find((f) => f.key === "users");
		expect(users?.rect).toEqual({ x: 5, y: 10, width: 200, height: 120 });
	});

	it("moveFrame translates an anchored rect by (dx, dy)", () => {
		const { result } = renderHook(() => useFrames(SAMPLE_SCHEMA));
		act(() => {
			result.current.setFrameRect("users", {
				x: 100,
				y: 100,
				width: 50,
				height: 50
			});
		});
		act(() => {
			result.current.moveFrame("users", 25, -10);
		});
		const users = result.current.frames.find((f) => f.key === "users");
		expect(users?.rect).toEqual({ x: 125, y: 90, width: 50, height: 50 });
	});

	it("moveFrame is a no-op on a frame without an anchored rect", () => {
		const { result } = renderHook(() => useFrames(SAMPLE_SCHEMA));
		const before = result.current.frames.find((f) => f.key === "users");
		expect(before?.rect).toBeUndefined();
		act(() => {
			result.current.moveFrame("users", 25, 25);
		});
		const after = result.current.frames.find((f) => f.key === "users");
		expect(after?.rect).toBeUndefined();
	});

	it("frameOfTable resolves the frame owning a table (or null)", () => {
		const { result } = renderHook(() => useFrames(SAMPLE_SCHEMA));
		expect(result.current.frameOfTable("users")?.key).toBe("users");
		expect(result.current.frameOfTable("orders")?.key).toBe("commerce");
		expect(result.current.frameOfTable("nowhere")).toBeNull();
	});

	it("re-seeds when the schema signature changes and no storage exists for the new key", () => {
		const { result, rerender } = renderHook(
			({ schema }: { schema: SchemaModel }) => useFrames(schema),
			{ initialProps: { schema: SAMPLE_SCHEMA } }
		);
		expect(result.current.frames.map((f) => f.key)).toEqual([
			"users",
			"commerce"
		]);
		rerender({ schema: CUSTOM_SCHEMA });
		expect(result.current.frames).toEqual([]);
	});

	it("replaceAll remplace intégralement le state (pas de merge)", () => {
		const { result } = renderHook(() => useFrames(SAMPLE_SCHEMA));
		// SAMPLE_SCHEMA seed 2 frames (users, commerce)
		expect(result.current.frames).toHaveLength(2);
		const snapshot: Frame[] = [
			makeFrame({ key: "only", label: "Only", collections: ["users"] })
		];
		act(() => {
			result.current.replaceAll(snapshot);
		});
		// Les seeds ont disparu — c'est bien un remplacement, pas un merge.
		expect(result.current.frames).toEqual(snapshot);
	});

	it("replaceAll déclenche la persistance localStorage", () => {
		const { result } = renderHook(() => useFrames(CUSTOM_SCHEMA));
		const snapshot: Frame[] = [
			makeFrame({ key: "snap", label: "Snap", collections: ["alpha"] })
		];
		act(() => {
			result.current.replaceAll(snapshot);
		});
		const raw = window.localStorage.getItem(storageKey(CUSTOM_SCHEMA));
		expect(raw).not.toBeNull();
		expect(JSON.parse(raw ?? "[]")).toEqual(snapshot);
	});

	it("replaceAll avec le state courant est idempotent (pas d'erreur)", () => {
		const { result } = renderHook(() => useFrames(SAMPLE_SCHEMA));
		const before = result.current.frames;
		expect(() =>
			act(() => {
				result.current.replaceAll(before);
			})
		).not.toThrow();
		expect(result.current.frames).toEqual(before);
	});

	it("re-hydrates from localStorage when the schema signature changes to a stored key", () => {
		const stored: Frame[] = [
			{ key: "stored", label: "Stored", hue: 262, collections: ["alpha"] }
		];
		window.localStorage.setItem(
			storageKey(CUSTOM_SCHEMA),
			JSON.stringify(stored)
		);
		const { result, rerender } = renderHook(
			({ schema }: { schema: SchemaModel }) => useFrames(schema),
			{ initialProps: { schema: SAMPLE_SCHEMA } }
		);
		rerender({ schema: CUSTOM_SCHEMA });
		expect(result.current.frames).toEqual(stored);
	});
});
