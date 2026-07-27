import { describe, expect, it } from "vitest";
import { UnknownEngineError } from "./errors";
import { getAdapter, registeredEngines, requireAdapter } from "./registry";

describe("registry", () => {
	it("résout l'adapter Postgres avec ses capacités", () => {
		const adapter = requireAdapter("postgres");
		expect(adapter.id).toBe("postgres");
		expect(adapter.capabilities.engine).toBe("postgres");
		expect(adapter.capabilities.supports.has("join")).toBe(true);
	});

	it("getAdapter renvoie undefined pour un moteur inconnu", () => {
		expect(getAdapter("oracle")).toBeUndefined();
	});

	it("requireAdapter lève UnknownEngineError pour un moteur inconnu", () => {
		expect(() => requireAdapter("oracle")).toThrow(UnknownEngineError);
	});

	it("liste les moteurs enregistrés", () => {
		expect(registeredEngines()).toContain("postgres");
	});
});
