import {
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef
} from "react";
import { canvasClass } from "../constants";
import { useNestStore, useStoreApi } from "../context";
import { clamp } from "../geometry";
import { createPanZoom, type PanZoomOptions } from "../panZoom";
import type { Viewport } from "../types";

const containerStyle = {
	position: "absolute",
	width: "100%",
	height: "100%",
	top: 0,
	left: 0
} as const;

export type ZoomPaneProps = Omit<
	PanZoomOptions,
	"userSelectionActive" | "clickDistance"
> & {
	defaultViewport: Viewport;
	minZoom: number;
	maxZoom: number;
	selectionOnDrag: boolean;
	paneClickDistance: number;
	children: ReactNode;
};

/** Mesure le conteneur (resize fenêtre + ResizeObserver) et la pousse dans le store. */
function useContainerSize(ref: RefObject<HTMLDivElement | null>) {
	const store = useStoreApi();
	useLayoutEffect(() => {
		const el = ref.current;
		if (el === null) return;
		const update = () => {
			if (!(el.checkVisibility?.() ?? true)) return;
			store.setState({
				width: el.offsetWidth || 500,
				height: el.offsetHeight || 500
			});
		};
		update();
		window.addEventListener("resize", update);
		const observer = new ResizeObserver(update);
		observer.observe(el);
		return () => {
			window.removeEventListener("resize", update);
			observer.disconnect();
		};
	}, [ref, store]);
}

/** Calque qui capte molette, drag de pan et double-clic. */
export function ZoomPane({
	defaultViewport,
	minZoom,
	maxZoom,
	selectionOnDrag,
	paneClickDistance,
	children,
	...options
}: ZoomPaneProps) {
	const store = useStoreApi();
	const ref = useRef<HTMLDivElement>(null);
	useContainerSize(ref);

	// Viewport par défaut et bornes initiales ne comptent qu'au montage.
	// biome-ignore lint/correctness/useExhaustiveDependencies: montage uniquement
	useLayoutEffect(() => {
		const el = ref.current;
		if (el === null) return;
		const panZoom = createPanZoom(el, store);
		store.setState({
			minZoom,
			maxZoom,
			panZoom,
			transform: [
				defaultViewport.x,
				defaultViewport.y,
				clamp(defaultViewport.zoom, minZoom, maxZoom)
			],
			domNode: el.closest(`.${canvasClass.root}`)
		});
		return () => {
			panZoom.destroy();
			store.setState({ panZoom: null });
		};
	}, [store]);

	const panZoom = useNestStore((s) => s.panZoom);
	const {
		panOnScroll,
		panOnScrollSpeed,
		zoomOnScroll,
		zoomOnPinch,
		zoomOnDoubleClick,
		panOnDrag,
		zoomActivationKeyPressed
	} = options;
	useEffect(() => {
		panZoom?.update({
			panOnScroll,
			panOnScrollSpeed,
			zoomOnScroll,
			zoomOnPinch,
			zoomOnDoubleClick,
			panOnDrag,
			zoomActivationKeyPressed,
			userSelectionActive: false,
			clickDistance: selectionOnDrag
				? Number.POSITIVE_INFINITY
				: Math.max(0, paneClickDistance)
		});
	}, [
		panZoom,
		panOnScroll,
		panOnScrollSpeed,
		zoomOnScroll,
		zoomOnPinch,
		zoomOnDoubleClick,
		panOnDrag,
		zoomActivationKeyPressed,
		selectionOnDrag,
		paneClickDistance
	]);

	return (
		<div className={canvasClass.renderer} ref={ref} style={containerStyle}>
			{children}
		</div>
	);
}

export type PaneProps = {
	panOnDrag: boolean | number[];
	isSelecting: boolean;
	onPaneClick: ((event: ReactMouseEvent) => void) | undefined;
	onPaneContextMenu: ((event: ReactMouseEvent) => void) | undefined;
	children: ReactNode;
};

/** Fond cliquable sous les nodes : clic / menu contextuel sur le vide. */
export function Pane({
	panOnDrag,
	isSelecting,
	onPaneClick,
	onPaneContextMenu,
	children
}: PaneProps) {
	const ref = useRef<HTMLDivElement>(null);
	const dragging = useNestStore((s) => s.paneDragging);
	const classes: string[] = [canvasClass.pane, canvasClass.container];
	if (
		panOnDrag === true ||
		(Array.isArray(panOnDrag) && panOnDrag.includes(0))
	) {
		classes.push("draggable");
	}
	if (dragging) classes.push("dragging");
	if (isSelecting) classes.push("selection");
	const onSelf =
		(handler: ((event: ReactMouseEvent) => void) | undefined) =>
		(event: ReactMouseEvent) => {
			if (event.target === ref.current) handler?.(event);
		};
	return (
		// biome-ignore lint/a11y: fond de canvas, pas un contrôle
		<div
			ref={ref}
			className={classes.join(" ")}
			onClick={onSelf(onPaneClick)}
			onContextMenu={onSelf(onPaneContextMenu)}
		>
			{children}
		</div>
	);
}
