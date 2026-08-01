import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useUndoRedoShortcuts } from "./useUndoRedoShortcuts";

/**
 * Dispatche un keydown avec un `target` optionnel (par défaut document.body).
 * On instancie un vrai KeyboardEvent pour que preventDefault soit trackable.
 */
function fireKey(
	init: {
		readonly key: string;
		readonly meta?: boolean;
		readonly ctrl?: boolean;
		readonly shift?: boolean;
		readonly target?: HTMLElement;
	}
): KeyboardEvent {
	const event = new KeyboardEvent("keydown", {
		key: init.key,
		metaKey: init.meta ?? false,
		ctrlKey: init.ctrl ?? false,
		shiftKey: init.shift ?? false,
		bubbles: true,
		cancelable: true
	});
	// Spy preventDefault (par défaut c'est déjà une méthode — on override).
	const spy = vi.fn(() => {
		// Marque le flag pour parité avec le comportement natif.
		Object.defineProperty(event, "defaultPrevented", {
			value: true,
			configurable: true
		});
	});
	Object.defineProperty(event, "preventDefault", {
		value: spy,
		configurable: true
	});
	const target = init.target ?? document.body;
	target.dispatchEvent(event);
	return event;
}

describe("useUndoRedoShortcuts", () => {
	afterEach(() => {
		// Unmount les hooks — sinon leurs listeners `document.keydown` restent
		// enregistrés et se cumulent entre tests, faisant fire N callbacks
		// pour un seul dispatchEvent.
		cleanup();
		document.body.innerHTML = "";
	});

	it("Cmd+Z hors input → onUndo appelé + preventDefault", () => {
		const onUndo = vi.fn();
		const onRedo = vi.fn();
		renderHook(() => useUndoRedoShortcuts({ onUndo, onRedo }));

		const evt = fireKey({ key: "z", meta: true });

		expect(onUndo).toHaveBeenCalledTimes(1);
		expect(onRedo).not.toHaveBeenCalled();
		expect(evt.preventDefault).toHaveBeenCalledTimes(1);
	});

	it("Cmd+Shift+Z hors input → onRedo appelé + preventDefault", () => {
		const onUndo = vi.fn();
		const onRedo = vi.fn();
		renderHook(() => useUndoRedoShortcuts({ onUndo, onRedo }));

		const evt = fireKey({ key: "z", meta: true, shift: true });

		expect(onRedo).toHaveBeenCalledTimes(1);
		expect(onUndo).not.toHaveBeenCalled();
		expect(evt.preventDefault).toHaveBeenCalledTimes(1);
	});

	it("Cmd+Y hors input → onRedo appelé + preventDefault", () => {
		const onUndo = vi.fn();
		const onRedo = vi.fn();
		renderHook(() => useUndoRedoShortcuts({ onUndo, onRedo }));

		const evt = fireKey({ key: "y", meta: true });

		expect(onRedo).toHaveBeenCalledTimes(1);
		expect(onUndo).not.toHaveBeenCalled();
		expect(evt.preventDefault).toHaveBeenCalledTimes(1);
	});

	it("Ctrl+Z (cross-platform) → onUndo appelé + preventDefault", () => {
		const onUndo = vi.fn();
		const onRedo = vi.fn();
		renderHook(() => useUndoRedoShortcuts({ onUndo, onRedo }));

		const evt = fireKey({ key: "z", ctrl: true });

		expect(onUndo).toHaveBeenCalledTimes(1);
		expect(evt.preventDefault).toHaveBeenCalledTimes(1);
	});

	it("Ctrl+Shift+Z → onRedo + preventDefault", () => {
		const onUndo = vi.fn();
		const onRedo = vi.fn();
		renderHook(() => useUndoRedoShortcuts({ onUndo, onRedo }));

		const evt = fireKey({ key: "z", ctrl: true, shift: true });

		expect(onRedo).toHaveBeenCalledTimes(1);
		expect(evt.preventDefault).toHaveBeenCalledTimes(1);
	});

	it("Cmd+Z avec focus dans un <input> → NI onUndo NI preventDefault", () => {
		const onUndo = vi.fn();
		const onRedo = vi.fn();
		renderHook(() => useUndoRedoShortcuts({ onUndo, onRedo }));

		const input = document.createElement("input");
		document.body.appendChild(input);
		input.focus();

		const evt = fireKey({ key: "z", meta: true, target: input });

		expect(onUndo).not.toHaveBeenCalled();
		expect(onRedo).not.toHaveBeenCalled();
		expect(evt.preventDefault).not.toHaveBeenCalled();
	});

	it("Cmd+Z avec focus dans un <textarea> → NI onUndo NI preventDefault", () => {
		const onUndo = vi.fn();
		const onRedo = vi.fn();
		renderHook(() => useUndoRedoShortcuts({ onUndo, onRedo }));

		const ta = document.createElement("textarea");
		document.body.appendChild(ta);
		ta.focus();

		const evt = fireKey({ key: "z", meta: true, target: ta });

		expect(onUndo).not.toHaveBeenCalled();
		expect(evt.preventDefault).not.toHaveBeenCalled();
	});

	it("Cmd+Z avec focus dans un contenteditable → NI onUndo NI preventDefault", () => {
		const onUndo = vi.fn();
		const onRedo = vi.fn();
		renderHook(() => useUndoRedoShortcuts({ onUndo, onRedo }));

		const div = document.createElement("div");
		div.setAttribute("contenteditable", "true");
		document.body.appendChild(div);
		div.focus();

		const evt = fireKey({ key: "z", meta: true, target: div });

		expect(onUndo).not.toHaveBeenCalled();
		expect(evt.preventDefault).not.toHaveBeenCalled();
	});

	it("touche sans modifier (Z seul) → no-op, pas de preventDefault", () => {
		const onUndo = vi.fn();
		const onRedo = vi.fn();
		renderHook(() => useUndoRedoShortcuts({ onUndo, onRedo }));

		const evt = fireKey({ key: "z" });

		expect(onUndo).not.toHaveBeenCalled();
		expect(onRedo).not.toHaveBeenCalled();
		expect(evt.preventDefault).not.toHaveBeenCalled();
	});

	it("autre touche avec Cmd (Cmd+A) → no-op", () => {
		const onUndo = vi.fn();
		const onRedo = vi.fn();
		renderHook(() => useUndoRedoShortcuts({ onUndo, onRedo }));

		const evt = fireKey({ key: "a", meta: true });

		expect(onUndo).not.toHaveBeenCalled();
		expect(onRedo).not.toHaveBeenCalled();
		expect(evt.preventDefault).not.toHaveBeenCalled();
	});

	it("cleanup : après unmount, plus aucun callback ne fire", () => {
		const onUndo = vi.fn();
		const onRedo = vi.fn();
		const { unmount } = renderHook(() =>
			useUndoRedoShortcuts({ onUndo, onRedo })
		);

		unmount();
		fireKey({ key: "z", meta: true });

		expect(onUndo).not.toHaveBeenCalled();
	});
});
