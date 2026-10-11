import { clamp } from "./geometry";
import { cubicInOut, interpolateZoom, type View } from "./interpolate";
import type { CanvasStore } from "./store";
import type { Transform, Viewport } from "./types";
import { panOnScrollDelta, wheelZoomExponent } from "./wheel";

export const NO_PAN_CLASS = "nopan";
export const NO_WHEEL_CLASS = "nowheel";
const NODE_CLASS = "nest-node";
const EDGE_CLASS = "nest-edge";

const DBLCLICK_DURATION = 250;
const WHEEL_IDLE_MS = 150;

export type PanZoomOptions = {
	panOnScroll: boolean;
	panOnScrollSpeed: number;
	zoomOnScroll: boolean;
	zoomOnPinch: boolean;
	zoomOnDoubleClick: boolean;
	/** `true` = tous les boutons autorisés ; tableau = boutons souris acceptés. */
	panOnDrag: boolean | number[];
	zoomActivationKeyPressed: boolean;
	userSelectionActive: boolean;
	/** Drag depuis un handle en cours : seule la molette reste active. */
	connectionInProgress: boolean;
	/** Au-delà de cette distance (px) un drag de pan avale le clic qui suit. */
	clickDistance: number;
};

export type PanZoom = {
	update: (options: PanZoomOptions) => void;
	setViewport: (
		viewport: Viewport,
		options?: { duration?: number | undefined }
	) => void;
	scaleTo: (zoom: number, options?: { duration?: number | undefined }) => void;
	scaleBy: (
		factor: number,
		options?: { duration?: number | undefined }
	) => void;
	destroy: () => void;
};

const closest = (event: Event, className: string): boolean =>
	event.target instanceof Element &&
	event.target.closest(`.${className}`) !== null;

/**
 * Pan/zoom du conteneur : molette (pan ou zoom selon la touche d'activation),
 * pinch trackpad, drag souris selon `panOnDrag`, double-clic, transitions
 * animées interrompues par tout geste utilisateur.
 */
export function createPanZoom(
	element: HTMLElement,
	store: CanvasStore
): PanZoom {
	let options: PanZoomOptions | null = null;
	let animation: number | null = null;
	let wheelIdle: ReturnType<typeof setTimeout> | null = null;
	/** Point écran + point flow fixés au début d'un geste de zoom molette. */
	let wheelAnchor: { screen: [number, number]; flow: [number, number] } | null =
		null;
	let cleanupDrag: (() => void) | null = null;

	const getTransform = (): Transform => store.getState().transform;
	const setTransform = (t: Transform) => {
		const [x, y, k] = getTransform();
		if (x === t[0] && y === t[1] && k === t[2]) return;
		store.setState({ transform: t });
	};
	const extent = (): [number, number] => {
		const { width, height } = store.getState();
		return [width, height];
	};
	const clampZoom = (k: number) => {
		const { minZoom, maxZoom } = store.getState();
		return clamp(k, minZoom, maxZoom);
	};
	const pointerOf = (event: MouseEvent): [number, number] => {
		const rect = element.getBoundingClientRect();
		return [
			event.clientX - rect.left - element.clientLeft,
			event.clientY - rect.top - element.clientTop
		];
	};
	const interrupt = () => {
		if (animation !== null) {
			cancelAnimationFrame(animation);
			animation = null;
		}
	};
	/** Zoom à `k` en gardant le point flow `flow` sous le point écran `screen`. */
	const zoomAround = (
		k: number,
		screen: [number, number],
		flow: [number, number]
	): Transform => [screen[0] - flow[0] * k, screen[1] - flow[1] * k, k];
	const invert = (t: Transform, p: [number, number]): [number, number] => [
		(p[0] - t[0]) / t[2],
		(p[1] - t[1]) / t[2]
	];

	const animateTo = (
		target: Transform,
		duration: number,
		point?: [number, number]
	) => {
		interrupt();
		if (!(duration > 0)) {
			setTransform(target);
			return;
		}
		const [w0, h0] = extent();
		const p = point ?? [w0 / 2, h0 / 2];
		const w = Math.max(w0, h0);
		const a = getTransform();
		const fa = invert(a, p);
		const fb = invert(target, p);
		const interp = interpolateZoom(
			[fa[0], fa[1], w / a[2]] as View,
			[fb[0], fb[1], w / target[2]] as View
		);
		const start = performance.now();
		const frame = (now: number) => {
			const elapsed = Math.min(1, (now - start) / duration);
			if (elapsed >= 1) {
				animation = null;
				setTransform(target);
				return;
			}
			const [cx, cy, size] = interp(cubicInOut(elapsed));
			const k = w / size;
			setTransform([p[0] - cx * k, p[1] - cy * k, k]);
			animation = requestAnimationFrame(frame);
		};
		animation = requestAnimationFrame(frame);
	};

	const scaleAroundCenter = (k: number, duration?: number) => {
		const [w, h] = extent();
		const center: [number, number] = [w / 2, h / 2];
		const t = getTransform();
		animateTo(
			zoomAround(clampZoom(k), center, invert(t, center)),
			duration ?? 0
		);
	};

	/**
	 * Filtre commun aux gestes souris (drag, double-clic) et au zoom molette
	 * actif (touche d'activation enfoncée).
	 */
	const accepts = (event: MouseEvent | WheelEvent): boolean => {
		if (options === null) return false;
		const o = options;
		const isWheel = event.type === "wheel";
		const zoomScroll = o.zoomActivationKeyPressed || o.zoomOnScroll;
		if (
			event.button === 1 &&
			event.type === "mousedown" &&
			(closest(event, NODE_CLASS) || closest(event, EDGE_CLASS))
		) {
			return true;
		}
		if (
			!o.panOnDrag &&
			!zoomScroll &&
			!o.panOnScroll &&
			!o.zoomOnDoubleClick &&
			!o.zoomOnPinch
		) {
			return false;
		}
		if (o.userSelectionActive) return false;
		if (o.connectionInProgress && !isWheel) return false;
		if (closest(event, NO_WHEEL_CLASS) && isWheel) return false;
		if (
			closest(event, NO_PAN_CLASS) &&
			(!isWheel || (o.panOnScroll && !o.zoomActivationKeyPressed))
		) {
			return false;
		}
		if (!o.zoomOnPinch && event.ctrlKey && isWheel) return false;
		if (
			!zoomScroll &&
			!o.panOnScroll &&
			!(o.zoomOnPinch && event.ctrlKey) &&
			isWheel
		) {
			return false;
		}
		if (!o.panOnDrag && event.type === "mousedown") return false;
		if (
			Array.isArray(o.panOnDrag) &&
			!o.panOnDrag.includes(event.button) &&
			event.type === "mousedown"
		) {
			return false;
		}
		const buttonAllowed =
			(Array.isArray(o.panOnDrag) && o.panOnDrag.includes(event.button)) ||
			!event.button ||
			event.button <= 1;
		return (!event.ctrlKey || isWheel) && buttonAllowed;
	};

	const zoomWheel = (event: WheelEvent) => {
		if (!accepts(event)) return;
		const t = getTransform();
		const k = clampZoom(t[2] * 2 ** wheelZoomExponent(event));
		const p = pointerOf(event);
		if (wheelIdle !== null && wheelAnchor !== null) {
			if (wheelAnchor.screen[0] !== p[0] || wheelAnchor.screen[1] !== p[1]) {
				wheelAnchor = { screen: p, flow: invert(t, p) };
			}
			clearTimeout(wheelIdle);
		} else if (t[2] === k) {
			return;
		} else {
			wheelAnchor = { screen: p, flow: invert(t, p) };
			interrupt();
		}
		event.preventDefault();
		event.stopImmediatePropagation();
		wheelIdle = setTimeout(() => {
			wheelIdle = null;
			wheelAnchor = null;
		}, WHEEL_IDLE_MS);
		setTransform(zoomAround(k, wheelAnchor.screen, wheelAnchor.flow));
	};

	const onWheel = (event: WheelEvent) => {
		if (options === null) return;
		const o = options;
		const isPanOnScroll =
			o.panOnScroll && !o.zoomActivationKeyPressed && !o.userSelectionActive;
		if (isPanOnScroll) {
			if (closest(event, NO_WHEEL_CLASS)) {
				// Le pinch au-dessus d'une zone `nowheel` ne doit pas zoomer la page.
				if (event.ctrlKey) event.preventDefault();
				return;
			}
			event.preventDefault();
			event.stopImmediatePropagation();
			interrupt();
			const t = getTransform();
			if (event.ctrlKey && o.zoomOnPinch) {
				const p = pointerOf(event);
				const k = clampZoom(t[2] * 2 ** wheelZoomExponent(event));
				setTransform(zoomAround(k, p, invert(t, p)));
				return;
			}
			const [dx, dy] = panOnScrollDelta(event, o.panOnScrollSpeed);
			setTransform([t[0] + dx, t[1] + dy, t[2]]);
			return;
		}
		const hasNoWheel = closest(event, NO_WHEEL_CLASS);
		if (event.ctrlKey && hasNoWheel) event.preventDefault();
		if (hasNoWheel) return;
		event.preventDefault();
		zoomWheel(event);
	};

	const onMouseDown = (event: MouseEvent) => {
		if (!accepts(event)) return;
		const view = event.view ?? window;
		const x0 = event.clientX;
		const y0 = event.clientY;
		const clickDistance2 = (options?.clickDistance ?? 0) ** 2;
		let moved = false;
		const start = pointerOf(event);
		const t0 = getTransform();
		const anchor = invert(t0, start);
		event.stopImmediatePropagation();
		interrupt();
		const preventSelect = (e: Event) => e.preventDefault();
		view.addEventListener("selectstart", preventSelect, true);
		view.addEventListener("dragstart", preventSelect, true);
		store.setState({ paneDragging: true });

		const onMove = (e: MouseEvent) => {
			e.preventDefault();
			e.stopImmediatePropagation();
			if (!moved) {
				const dx = e.clientX - x0;
				const dy = e.clientY - y0;
				moved = dx * dx + dy * dy > clickDistance2;
			}
			const p = pointerOf(e);
			const k = getTransform()[2];
			setTransform([p[0] - anchor[0] * k, p[1] - anchor[1] * k, k]);
		};
		const onUp = (e: MouseEvent) => {
			e.preventDefault();
			e.stopImmediatePropagation();
			end();
		};
		const end = () => {
			view.removeEventListener("mousemove", onMove, true);
			view.removeEventListener("mouseup", onUp, true);
			view.removeEventListener("selectstart", preventSelect, true);
			view.removeEventListener("dragstart", preventSelect, true);
			cleanupDrag = null;
			store.setState({ paneDragging: false });
			if (moved) {
				const swallow = (e: Event) => {
					e.preventDefault();
					e.stopImmediatePropagation();
				};
				view.addEventListener("click", swallow, true);
				setTimeout(() => view.removeEventListener("click", swallow, true), 0);
			}
		};
		view.addEventListener("mousemove", onMove, true);
		view.addEventListener("mouseup", onUp, true);
		cleanupDrag = end;
	};

	const onDoubleClick = (event: MouseEvent) => {
		if (options === null || !options.zoomOnDoubleClick || !accepts(event))
			return;
		const t0 = getTransform();
		const p = pointerOf(event);
		const k = clampZoom(t0[2] * (event.shiftKey ? 0.5 : 2));
		event.preventDefault();
		event.stopImmediatePropagation();
		animateTo(zoomAround(k, p, invert(t0, p)), DBLCLICK_DURATION, p);
	};

	element.addEventListener("wheel", onWheel, { passive: false });
	element.addEventListener("mousedown", onMouseDown);
	element.addEventListener("dblclick", onDoubleClick);

	return {
		update: (next) => {
			options = next;
		},
		setViewport: (viewport, opts) =>
			animateTo([viewport.x, viewport.y, viewport.zoom], opts?.duration ?? 0),
		scaleTo: (zoom, opts) => scaleAroundCenter(zoom, opts?.duration),
		scaleBy: (factor, opts) =>
			scaleAroundCenter(getTransform()[2] * factor, opts?.duration),
		destroy: () => {
			interrupt();
			cleanupDrag?.();
			if (wheelIdle !== null) clearTimeout(wheelIdle);
			element.removeEventListener("wheel", onWheel);
			element.removeEventListener("mousedown", onMouseDown);
			element.removeEventListener("dblclick", onDoubleClick);
		}
	};
}
