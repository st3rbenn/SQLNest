import { describe, expect, it } from "vitest";
import {
	DIVERGENCES,
	divergenceByCode,
	hintsForConstruct
} from "./divergences-mongo-vs-pg";

describe("divergences PG↔Mongo registre (ADR-024 PM/8 D7)", () => {
	it("contient les 8 divergences #13-#20", () => {
		expect(DIVERGENCES.length).toBe(8);
	});

	it("codes uniques (pas de doublon)", () => {
		const codes = DIVERGENCES.map((d) => d.code);
		expect(new Set(codes).size).toBe(codes.length);
	});

	it("divergenceByCode récupère #13 concat", () => {
		const d = divergenceByCode("concat_null_parity");
		expect(d).toBeDefined();
		expect(d!.mitigation).toBe("shim");
	});

	it("hintsForConstruct('concat') retourne #13", () => {
		const hints = hintsForConstruct("concat");
		expect(hints).toHaveLength(1);
		expect(hints[0]!.code).toBe("concat_null_parity");
	});

	it("chaque entrée a titre + pgBehavior + mongoBehavior + mitigation", () => {
		for (const d of DIVERGENCES) {
			expect(d.title.length).toBeGreaterThan(0);
			expect(d.pgBehavior.length).toBeGreaterThan(0);
			expect(d.mongoBehavior.length).toBeGreaterThan(0);
			expect(["shim", "refus", "warn"]).toContain(d.mitigation);
		}
	});

	it("mitigation 'shim' implique livraison (hintMessage mentionne PM/N)", () => {
		const shims = DIVERGENCES.filter((d) => d.mitigation === "shim");
		for (const s of shims) {
			expect(s.hintMessage ?? "").toMatch(/PM\/\d/);
		}
	});
});
