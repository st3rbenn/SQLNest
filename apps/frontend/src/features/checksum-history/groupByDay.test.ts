import { describe, expect, it } from "vitest";
import type { ChecksumHistoryEntry } from "./checksumHistoryClient";
import { groupByDay } from "./groupByDay";

function entry(seenAt: string, id = "id"): ChecksumHistoryEntry {
	return {
		id,
		dbSchemaChecksum: "abcdef0123",
		dbConnectionId: "conn-1",
		seenAt
	};
}

describe("groupByDay", () => {
	it("regroupe les events de la même journée locale", () => {
		const now = new Date("2026-08-24T10:00:00");
		const groups = groupByDay(
			[
				entry("2026-08-24T15:00:00", "a"),
				entry("2026-08-24T08:30:00", "b")
			],
			now
		);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.label).toBe("Aujourd'hui");
		expect(groups[0]!.entries.map((e) => e.id)).toEqual(["a", "b"]);
	});

	it("label 'Hier' pour la veille locale", () => {
		const now = new Date("2026-08-24T10:00:00");
		const groups = groupByDay([entry("2026-08-23T22:00:00")], now);
		expect(groups[0]!.label).toBe("Hier");
	});

	it("label date locale pour au-delà d'hier", () => {
		const now = new Date("2026-08-24T10:00:00");
		const groups = groupByDay([entry("2026-08-15T10:00:00")], now);
		expect(groups[0]!.label).toContain("15");
		expect(groups[0]!.label.toLowerCase()).toContain("août");
	});

	it("préserve l'ordre décroissant des entries dans chaque bucket", () => {
		const now = new Date("2026-08-24T10:00:00");
		const groups = groupByDay(
			[
				entry("2026-08-24T15:00:00", "later"),
				entry("2026-08-24T08:00:00", "earlier"),
				entry("2026-08-23T20:00:00", "yesterday")
			],
			now
		);
		expect(groups).toHaveLength(2);
		expect(groups[0]!.entries[0]!.id).toBe("later");
		expect(groups[0]!.entries[1]!.id).toBe("earlier");
		expect(groups[1]!.entries[0]!.id).toBe("yesterday");
	});

	it("liste vide → aucun groupe", () => {
		expect(groupByDay([])).toEqual([]);
	});
});
