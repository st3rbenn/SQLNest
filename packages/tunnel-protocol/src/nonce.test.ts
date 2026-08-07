/**
 * Tests unit — protection anti-replay (counter + timestamp).
 */

import { describe, expect, test } from "vitest";
import {
	checkAndAdvance,
	createEmitterCounter,
	createPeerCounter,
	nextCounter
} from "./nonce";
import { MAX_SKEW_MS } from "./types";

const NOW = 1_700_000_000_000;

describe("checkAndAdvance — counter monotone", () => {
	test("séquence croissante 0 → 1 → 2 acceptée", () => {
		const state = createPeerCounter();
		expect(checkAndAdvance(state, 0, NOW, NOW).ok).toBe(true);
		expect(checkAndAdvance(state, 1, NOW, NOW).ok).toBe(true);
		expect(checkAndAdvance(state, 2, NOW, NOW).ok).toBe(true);
	});

	test("saut monotone accepté (0 → 5)", () => {
		const state = createPeerCounter();
		expect(checkAndAdvance(state, 5, NOW, NOW).ok).toBe(true);
	});

	test("ctr réutilisé → counter_reused", () => {
		const state = createPeerCounter();
		checkAndAdvance(state, 3, NOW, NOW);
		const res = checkAndAdvance(state, 3, NOW, NOW);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("counter_reused");
	});

	test("ctr backward → counter_backward", () => {
		const state = createPeerCounter();
		checkAndAdvance(state, 10, NOW, NOW);
		const res = checkAndAdvance(state, 5, NOW, NOW);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("counter_backward");
	});
});

describe("checkAndAdvance — timestamp skew", () => {
	test("ts dans la fenêtre → OK", () => {
		const state = createPeerCounter();
		expect(checkAndAdvance(state, 1, NOW - MAX_SKEW_MS + 1000, NOW).ok).toBe(
			true
		);
	});

	test("ts trop vieux (> MAX_SKEW dans le passé) → timestamp_too_old", () => {
		const state = createPeerCounter();
		const res = checkAndAdvance(state, 1, NOW - MAX_SKEW_MS - 1, NOW);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("timestamp_too_old");
	});

	test("ts trop futur (> MAX_SKEW dans le futur) → timestamp_too_new", () => {
		const state = createPeerCounter();
		const res = checkAndAdvance(state, 1, NOW + MAX_SKEW_MS + 1, NOW);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("timestamp_too_new");
	});
});

describe("checkAndAdvance — mutation d'état", () => {
	test("succès → state.lastCtr et lastTs mis à jour", () => {
		const state = createPeerCounter();
		checkAndAdvance(state, 7, NOW, NOW);
		expect(state.lastCtr).toBe(7);
		expect(state.lastTs).toBe(NOW);
	});

	test("échec → state non modifié", () => {
		const state = createPeerCounter();
		checkAndAdvance(state, 5, NOW, NOW);
		const snapshot = { ...state };
		checkAndAdvance(state, 3, NOW, NOW); // backward
		expect(state).toEqual(snapshot);
	});
});

describe("EmitterCounterState", () => {
	test("nextCounter incrémente à partir de 0", () => {
		const s = createEmitterCounter();
		expect(nextCounter(s)).toBe(0);
		expect(nextCounter(s)).toBe(1);
		expect(nextCounter(s)).toBe(2);
	});

	test("state.next reflète le prochain ctr à émettre", () => {
		const s = createEmitterCounter();
		nextCounter(s);
		nextCounter(s);
		expect(s.next).toBe(2);
	});
});
