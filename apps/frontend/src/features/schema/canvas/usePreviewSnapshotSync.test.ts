import { describe, expect, it } from "vitest";
import { computePreviewSnapshot } from "./usePreviewSnapshotSync";

function makeNodes(count: number) {
	return Array.from({ length: count }, (_, i) => ({
		id: `t${i}`,
		position: { x: i * 10, y: 0 },
		width: 100,
		height: 50
	}));
}

describe("computePreviewSnapshot — bornes backend (le client tronque)", () => {
	it("tronque à 200 nodes (PreviewSnapshotSchema nodes.max(200))", () => {
		// Cas GEXSI : 445 tables → sans troncature chaque PUT partait en 400
		// et le sync retryait en boucle.
		const snap = computePreviewSnapshot({
			tableNodes: makeNodes(445),
			frames: [],
			relations: [],
			hiddenIds: new Set()
		});
		expect(snap.nodes).toHaveLength(200);
		expect(snap.nodes[0]?.id).toBe("t0");
		expect(snap.nodes[199]?.id).toBe("t199");
	});

	it("les edges vers un node tronqué tombent avec (jamais de bout pendant)", () => {
		const snap = computePreviewSnapshot({
			tableNodes: makeNodes(250),
			frames: [],
			relations: [
				{ from: { collection: "t1" }, to: { collection: "t2" } },
				// t240 est au-delà de la troncature → edge éliminé.
				{ from: { collection: "t1" }, to: { collection: "t240" } }
			],
			hiddenIds: new Set()
		});
		expect(snap.edges).toEqual([{ source: "t1", target: "t2" }]);
	});

	it("sous les bornes : aucun changement de comportement", () => {
		const snap = computePreviewSnapshot({
			tableNodes: makeNodes(11),
			frames: [],
			relations: [{ from: { collection: "t0" }, to: { collection: "t1" } }],
			hiddenIds: new Set(["t5"])
		});
		expect(snap.nodes).toHaveLength(10);
		expect(snap.edges).toHaveLength(1);
	});
});
