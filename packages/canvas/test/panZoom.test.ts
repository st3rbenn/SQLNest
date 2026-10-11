import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createPanZoom,
	type PanZoom,
	type PanZoomOptions
} from "../src/panZoom";
import { type CanvasStore, createCanvasStore } from "../src/store";
import type { Transform } from "../src/types";
import { isMacOs } from "../src/wheel";

/** Props de SchemaCanvas : panOnScroll, zoomOnScroll off, pan au clic milieu. */
const SQLNEST: PanZoomOptions = {
	panOnScroll: true,
	panOnScrollSpeed: 0.5,
	zoomOnScroll: false,
	zoomOnPinch: true,
	zoomOnDoubleClick: true,
	panOnDrag: [1],
	zoomActivationKeyPressed: false,
	userSelectionActive: false,
	connectionInProgress: false,
	clickDistance: Number.POSITIVE_INFINITY
};

let store: CanvasStore;
let el: HTMLDivElement;
let panZoom: PanZoom;

function setup(
	transform: Transform = [0, 0, 1],
	options: Partial<PanZoomOptions> = {}
) {
	store = createCanvasStore({ minZoom: 0.02, maxZoom: 1.75, transform });
	store.setState({ width: 1000, height: 600 });
	el = document.createElement("div");
	document.body.appendChild(el);
	panZoom = createPanZoom(el, store);
	panZoom.update({ ...SQLNEST, ...options });
}

const t = () => store.getState().transform;

/** happy-dom : WheelEvent n'hérite pas de MouseEvent (pas de ctrlKey ni
 *  clientX) — on part d'un MouseEvent comme dans un vrai navigateur. */
function wheel(target: Element, init: WheelEventInit) {
	const { deltaX = 0, deltaY = 0, deltaMode = 0, ...mouseInit } = init;
	const event = new MouseEvent("wheel", {
		bubbles: true,
		cancelable: true,
		...mouseInit
	});
	Object.defineProperties(event, {
		deltaX: { value: deltaX },
		deltaY: { value: deltaY },
		deltaMode: { value: deltaMode }
	});
	target.dispatchEvent(event);
	return event as WheelEvent;
}

function child(className: string): HTMLDivElement {
	const c = document.createElement("div");
	c.className = className;
	el.appendChild(c);
	return c;
}

afterEach(async () => {
	panZoom.destroy();
	el.remove();
	vi.useRealTimers();
	// Laisse expirer l'avalement de clic (setTimeout 0) d'un pan précédent.
	await new Promise((resolve) => setTimeout(resolve, 1));
});

describe("molette en mode panOnScroll", () => {
	beforeEach(() => setup([10, 20, 0.5]));

	it("pan de deltaY × 0.5, indépendant du zoom", () => {
		wheel(el, { deltaY: 100 });
		expect(t()).toEqual([10, -30, 0.5]);
		wheel(el, { deltaX: 40 });
		expect(t()).toEqual([-10, -30, 0.5]);
	});

	it("Firefox (deltaMode = 1) multiplie par 20", () => {
		wheel(el, { deltaY: 3, deltaMode: 1 });
		expect(t()).toEqual([10, 20 - 30, 0.5]);
	});

	it("survol d'un nœud draggable : pan quand même", () => {
		wheel(child("nest-node nopan"), { deltaY: 10 });
		expect(t()).toEqual([10, 15, 0.5]);
	});

	it("zone nowheel : rien, sauf pinch qui bloque le zoom page", () => {
		const nw = child("nowheel");
		const plain = wheel(nw, { deltaY: 50 });
		expect(t()).toEqual([10, 20, 0.5]);
		expect(plain.defaultPrevented).toBe(false);
		const pinch = wheel(nw, { deltaY: 50, ctrlKey: true });
		expect(t()).toEqual([10, 20, 0.5]);
		expect(pinch.defaultPrevented).toBe(true);
	});

	it("pinch (ctrlKey) zoome autour du pointeur", () => {
		wheel(el, { deltaY: -10, ctrlKey: true, clientX: 300, clientY: 200 });
		const factor = isMacOs() ? 10 : 1;
		const k = 0.5 * 2 ** (10 * 0.002 * factor);
		const [x, y, z] = t();
		expect(z).toBeCloseTo(k, 12);
		// Le point flow sous le pointeur ne bouge pas.
		expect((300 - x) / z).toBeCloseTo((300 - 10) / 0.5, 9);
		expect((200 - y) / z).toBeCloseTo((200 - 20) / 0.5, 9);
	});

	it("pinch borné par maxZoom", () => {
		store.setState({ transform: [0, 0, 1.7] });
		wheel(el, { deltaY: -500, ctrlKey: true });
		expect(t()[2]).toBe(1.75);
	});
});

describe("touche d'activation du zoom (Cmd / Ctrl) enfoncée", () => {
	beforeEach(() => setup([0, 0, 1], { zoomActivationKeyPressed: true }));

	it("molette = zoom autour du pointeur, formule 2^(-deltaY × 0.002)", () => {
		wheel(el, { deltaY: -100, clientX: 500, clientY: 300 });
		const k = 2 ** 0.2;
		const [x, y, z] = t();
		expect(z).toBeCloseTo(Math.min(k, 1.75), 12);
		expect((500 - x) / z).toBeCloseTo(500, 9);
		expect((300 - y) / z).toBeCloseTo(300, 9);
	});

	it("zoome aussi au-dessus d'un node draggable", () => {
		wheel(child("nest-node nopan"), { deltaY: 100 });
		expect(t()[2]).toBeCloseTo(2 ** -0.2, 12);
	});

	it("au zoom max, un wheel qui zoomerait encore est ignoré", () => {
		store.setState({ transform: [0, 0, 1.75] });
		const e = wheel(el, { deltaY: -100 });
		expect(t()).toEqual([0, 0, 1.75]);
		expect(e.defaultPrevented).toBe(true);
	});
});

function mouse(target: EventTarget, type: string, init: MouseEventInit) {
	const event = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		...init
	});
	target.dispatchEvent(event);
	return event;
}

describe("drag de pan", () => {
	it("clic milieu : suit le pointeur 1:1, pane en dragging pendant le geste", () => {
		setup([5, 5, 0.8]);
		mouse(el, "mousedown", { button: 1, clientX: 100, clientY: 100 });
		expect(store.getState().paneDragging).toBe(true);
		mouse(window, "mousemove", { clientX: 160, clientY: 70 });
		expect(t()).toEqual([65, -25, 0.8]);
		mouse(window, "mouseup", { button: 1, clientX: 160, clientY: 70 });
		expect(store.getState().paneDragging).toBe(false);
		mouse(window, "mousemove", { clientX: 300, clientY: 300 });
		expect(t()).toEqual([65, -25, 0.8]);
	});

	it("clic gauche ignoré quand panOnDrag = [1]", () => {
		setup();
		mouse(el, "mousedown", { button: 0, clientX: 0, clientY: 0 });
		mouse(window, "mousemove", { clientX: 50, clientY: 50 });
		expect(t()).toEqual([0, 0, 1]);
	});

	it("clic milieu sur un node draggable : pan quand même", () => {
		setup();
		mouse(child("nest-node nopan"), "mousedown", {
			button: 1,
			clientX: 0,
			clientY: 0
		});
		mouse(window, "mousemove", { clientX: 30, clientY: 0 });
		expect(t()).toEqual([30, 0, 1]);
		mouse(window, "mouseup", {});
	});

	it("Ctrl + clic milieu : pas de pan", () => {
		setup();
		mouse(el, "mousedown", { button: 1, ctrlKey: true });
		mouse(window, "mousemove", { clientX: 30, clientY: 0 });
		expect(t()).toEqual([0, 0, 1]);
	});

	it("Espace (panOnDrag = true) : clic gauche pan, sauf sur un node draggable", () => {
		setup([0, 0, 1], { panOnDrag: true, clickDistance: 1 });
		mouse(child("nest-node nopan"), "mousedown", { button: 0 });
		mouse(window, "mousemove", { clientX: 30, clientY: 0 });
		expect(t()).toEqual([0, 0, 1]);
		mouse(el, "mousedown", { button: 0, clientX: 0, clientY: 0 });
		mouse(window, "mousemove", { clientX: 40, clientY: 10 });
		expect(t()).toEqual([40, 10, 1]);
		mouse(window, "mouseup", {});
	});

	it("un pan qui a bougé avale le clic suivant", () => {
		vi.useFakeTimers();
		setup([0, 0, 1], { panOnDrag: true, clickDistance: 1 });
		const onClick = vi.fn();
		el.addEventListener("click", onClick);
		mouse(el, "mousedown", { button: 0, clientX: 0, clientY: 0 });
		mouse(window, "mousemove", { clientX: 10, clientY: 0 });
		mouse(window, "mouseup", {});
		mouse(el, "click", {});
		expect(onClick).not.toHaveBeenCalled();
		vi.runAllTimers();
		mouse(el, "click", {});
		expect(onClick).toHaveBeenCalledTimes(1);
	});
});

describe("connexion en cours", () => {
	it("drag de pan bloqué, molette toujours active", () => {
		setup([0, 0, 1], { connectionInProgress: true });
		mouse(el, "mousedown", { button: 1, clientX: 0, clientY: 0 });
		mouse(window, "mousemove", { clientX: 40, clientY: 0 });
		expect(t()).toEqual([0, 0, 1]);
		wheel(el, { deltaY: 20 });
		expect(t()).toEqual([0, -10, 1]);
	});
});

describe("transitions animées", () => {
	beforeEach(() => {
		vi.useFakeTimers({
			toFake: [
				"requestAnimationFrame",
				"cancelAnimationFrame",
				"performance",
				"setTimeout"
			]
		});
	});

	it("double-clic : ×2 autour du pointeur en 250 ms", () => {
		setup([0, 0, 0.5]);
		mouse(el, "dblclick", { clientX: 200, clientY: 100 });
		vi.advanceTimersByTime(100);
		const mid = t()[2];
		expect(mid).toBeGreaterThan(0.5);
		expect(mid).toBeLessThan(1);
		vi.advanceTimersByTime(300);
		const [x, y, k] = t();
		expect(k).toBe(1);
		expect((200 - x) / k).toBeCloseTo(400, 9);
		expect((100 - y) / k).toBeCloseTo(200, 9);
	});

	it("Shift + double-clic : ÷2 ; sur un node draggable : rien", () => {
		setup([0, 0, 1]);
		mouse(child("nest-node nopan"), "dblclick", {});
		vi.advanceTimersByTime(400);
		expect(t()).toEqual([0, 0, 1]);
		mouse(el, "dblclick", { shiftKey: true });
		vi.advanceTimersByTime(400);
		expect(t()[2]).toBe(0.5);
	});

	it("setViewport animé atteint exactement la cible ; un wheel l'interrompt", () => {
		setup([0, 0, 1]);
		panZoom.setViewport({ x: -800, y: 300, zoom: 0.3 }, { duration: 350 });
		vi.advanceTimersByTime(400);
		expect(t()).toEqual([-800, 300, 0.3]);

		panZoom.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 350 });
		vi.advanceTimersByTime(100);
		wheel(el, { deltaY: 10 });
		const frozen = t();
		vi.advanceTimersByTime(400);
		expect(t()).toEqual(frozen);
	});

	it("setViewport sans durée : immédiat, sans borner le zoom", () => {
		setup();
		panZoom.setViewport({ x: 1, y: 2, zoom: 5 });
		expect(t()).toEqual([1, 2, 5]);
	});

	it("scaleBy(1.2) zoome autour du centre du conteneur", () => {
		setup([0, 0, 1]);
		panZoom.scaleBy(1.2);
		const [x, y, k] = t();
		expect(k).toBeCloseTo(1.2, 12);
		expect((500 - x) / k).toBeCloseTo(500, 9);
		expect((300 - y) / k).toBeCloseTo(300, 9);
	});
});
