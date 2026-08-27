import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { hydrateBson } from "./adapter";

const HEX = "507f1f77bcf86cd799439011";

describe("hydrateBson — fidélité BSON _id (#7 lean-robuste)", () => {
	describe("filtre (filter=true) → both-forms ObjectId + string", () => {
		it("`{_id: '<hex>'}` (égalité shorthand) → $in [ObjectId, string]", () => {
			const out = hydrateBson({ _id: HEX }, true) as {
				_id: { $in: unknown[] };
			};
			expect(out._id.$in).toHaveLength(2);
			expect(out._id.$in[0]).toBeInstanceOf(ObjectId);
			expect((out._id.$in[0] as ObjectId).toString()).toBe(HEX);
			expect(out._id.$in[1]).toBe(HEX);
		});

		it("`{_id: {$eq: '<hex>'}}` → $in both-forms", () => {
			const out = hydrateBson({ _id: { $eq: HEX } }, true) as {
				_id: { $in: unknown[] };
			};
			expect(out._id.$in[0]).toBeInstanceOf(ObjectId);
			expect(out._id.$in[1]).toBe(HEX);
		});

		it("`{_id: {$nin: ['<hex>', null]}}` (from `!=`) → both-forms + null", () => {
			const out = hydrateBson({ _id: { $nin: [HEX, null] } }, true) as {
				_id: { $nin: unknown[] };
			};
			expect(out._id.$nin).toHaveLength(3);
			expect(out._id.$nin[0]).toBeInstanceOf(ObjectId);
			expect(out._id.$nin[1]).toBe(HEX);
			expect(out._id.$nin[2]).toBeNull();
		});

		it("range sur _id (`$gt`) → coercion ObjectId simple (pas de both-forms)", () => {
			const out = hydrateBson({ _id: { $gt: HEX } }, true) as {
				_id: { $gt: unknown };
			};
			expect(out._id.$gt).toBeInstanceOf(ObjectId);
		});

		it("valeur non-24-hex sous _id → inchangée (pas d'expansion)", () => {
			expect(hydrateBson({ _id: "not-hex" }, true)).toEqual({ _id: "not-hex" });
		});
	});

	describe("insert / valeur (filter=false) → AUCUNE coercion _id", () => {
		it("`{_id: '<hex>'}` stocké tel quel (string, fidélité)", () => {
			expect(hydrateBson({ _id: HEX }, false)).toEqual({ _id: HEX });
		});

		it("un `_id` non-24-hex reste tel quel", () => {
			expect(hydrateBson({ _id: "custom-key" }, false)).toEqual({
				_id: "custom-key"
			});
		});
	});
});
