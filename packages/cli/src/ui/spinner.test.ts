import { describe, expect, test, vi } from "vitest";
import { createSpinner } from "./spinner";

/** Fabrique un stub `setInterval`/`clearInterval` synchrones : capture
 *  la callback pour la déclencher manuellement via `tick()`. */
function makeIntervalStub(): {
	setInterval: (fn: () => void, _ms: number) => symbol;
	clearInterval: (handle: unknown) => void;
	tick: () => void;
	handles: symbol[];
	cleared: symbol[];
} {
	const handles: symbol[] = [];
	const cleared: symbol[] = [];
	let cb: (() => void) | null = null;
	return {
		setInterval: (fn: () => void, _ms: number) => {
			cb = fn;
			const h = Symbol("handle");
			handles.push(h);
			return h;
		},
		clearInterval: (handle: unknown) => {
			cleared.push(handle as symbol);
		},
		tick: () => {
			cb?.();
		},
		handles,
		cleared
	};
}

describe("createSpinner — non-TTY fallback", () => {
	test("initial render + update + succeed → 3 plain-log lines", () => {
		const log = vi.fn();
		const spinner = createSpinner("En attente", { isTty: false, log });
		expect(log).toHaveBeenNthCalledWith(1, "[sqlnest] En attente");
		spinner.update("Approuvé");
		expect(log).toHaveBeenNthCalledWith(2, "[sqlnest] Approuvé");
		spinner.succeed("Pairing OK : « alice »");
		expect(log).toHaveBeenNthCalledWith(3, "✓ Pairing OK : « alice »");
		expect(log).toHaveBeenCalledTimes(3);
	});

	test("stop est un no-op silencieux en non-TTY", () => {
		const log = vi.fn();
		const spinner = createSpinner("En attente", { isTty: false, log });
		spinner.stop();
		// Seul l'appel initial doit avoir loggé — stop ne print rien.
		expect(log).toHaveBeenCalledTimes(1);
	});
});

describe("createSpinner — TTY", () => {
	test("initial render écrit une frame + interval enregistré", () => {
		const write = vi.fn();
		const intv = makeIntervalStub();
		createSpinner("En attente", {
			isTty: true,
			write,
			setInterval: intv.setInterval,
			clearInterval: intv.clearInterval
		});
		expect(write).toHaveBeenCalledTimes(1);
		expect(write.mock.calls[0]?.[0]).toContain("En attente");
		expect(intv.handles).toHaveLength(1);
	});

	test("succeed clear l'interval et écrit ✓ + newline", () => {
		const write = vi.fn();
		const intv = makeIntervalStub();
		const spinner = createSpinner("En attente", {
			isTty: true,
			write,
			setInterval: intv.setInterval,
			clearInterval: intv.clearInterval
		});
		spinner.succeed("Pairing OK");
		expect(intv.cleared).toEqual(intv.handles);
		const last = write.mock.calls.at(-1)?.[0] as string;
		expect(last).toContain("✓ Pairing OK");
		expect(last.endsWith("\n")).toBe(true);
	});

	test("update change le texte affiché au prochain render", () => {
		const write = vi.fn();
		const intv = makeIntervalStub();
		const spinner = createSpinner("En attente", {
			isTty: true,
			write,
			setInterval: intv.setInterval,
			clearInterval: intv.clearInterval
		});
		spinner.update("Approuvé");
		// update re-render immédiatement — pas besoin d'attendre le tick.
		const last = write.mock.calls.at(-1)?.[0] as string;
		expect(last).toContain("Approuvé");
	});

	test("update après stop est un no-op (pas de fuite d'affichage)", () => {
		const write = vi.fn();
		const intv = makeIntervalStub();
		const spinner = createSpinner("En attente", {
			isTty: true,
			write,
			setInterval: intv.setInterval,
			clearInterval: intv.clearInterval
		});
		spinner.stop();
		const callsAfterStop = write.mock.calls.length;
		spinner.update("Ignoré");
		expect(write.mock.calls.length).toBe(callsAfterStop);
	});

	test("tick change la frame in-place", () => {
		const write = vi.fn();
		const intv = makeIntervalStub();
		createSpinner("En attente", {
			isTty: true,
			write,
			setInterval: intv.setInterval,
			clearInterval: intv.clearInterval
		});
		const initialFrame = (write.mock.calls[0]?.[0] as string).slice(1, 2);
		intv.tick();
		const nextFrame = (write.mock.calls.at(-1)?.[0] as string).slice(1, 2);
		expect(nextFrame).not.toBe(initialFrame);
	});
});
