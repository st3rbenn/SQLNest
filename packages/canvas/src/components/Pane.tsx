import {
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef
} from "react";
import { canvasClass } from "../constants";
import { shallow, useNestStore, useStoreApi } from "../context";
import {
	autoPan as autoPanVelocity,
	flowToPoint,
	getNodesInside,
	pointToFlow
} from "../geometry";
import { SelectionMode, type XYPosition } from "../types";

const AUTO_PAN_SPEED = 15;

export type PaneProps = {
	panOnDrag: boolean | number[];
	isSelecting: boolean;
	selectionKeyPressed: boolean;
	selectionOnDrag: boolean;
	selectionMode: SelectionMode;
	paneClickDistance: number;
	onSelectionStart: ((event: ReactPointerEvent) => void) | undefined;
	onSelectionEnd: ((event: ReactPointerEvent) => void) | undefined;
	onPaneClick: ((event: ReactMouseEvent) => void) | undefined;
	onPaneContextMenu: ((event: ReactMouseEvent) => void) | undefined;
	children: ReactNode;
};

/**
 * Fond sous les nodes : clic et menu contextuel sur le vide, lasso. En mode
 * sélection, le « clic » sur le vide part au relâchement si le pointeur n'a
 * pas bougé.
 */
export function Pane({
	panOnDrag,
	isSelecting,
	selectionKeyPressed,
	selectionOnDrag,
	selectionMode,
	paneClickDistance,
	onSelectionStart,
	onSelectionEnd,
	onPaneClick,
	onPaneContextMenu,
	children
}: PaneProps) {
	const store = useStoreApi();
	const { userSelectionActive, dragging } = useNestStore(
		(s) => ({
			userSelectionActive: s.userSelectionActive,
			dragging: s.paneDragging
		}),
		shallow
	);
	const isSelectionEnabled = isSelecting || userSelectionActive;
	const container = useRef<HTMLDivElement>(null);
	const containerBounds = useRef<DOMRect | null>(null);
	const selectedIds = useRef(new Set<string>());
	// Un lasso est en cours : le clic qui suit le relâchement est avalé.
	const selectionInProgress = useRef(false);
	const pointer = useRef<XYPosition>({ x: 0, y: 0 });
	const autoPanId = useRef(0);
	const autoPanStarted = useRef(false);

	const onClick = (event: ReactMouseEvent) => {
		if (selectionInProgress.current) {
			selectionInProgress.current = false;
			return;
		}
		onPaneClick?.(event);
		store.resetSelectedElements();
	};

	const onContextMenu = (event: ReactMouseEvent) => {
		if (Array.isArray(panOnDrag) && panOnDrag.includes(2)) {
			event.preventDefault();
			return;
		}
		onPaneContextMenu?.(event);
	};

	const commitRect = (mouseX: number, mouseY: number) => {
		const { userSelectionRect, transform, nodeLookup } = store.getState();
		if (userSelectionRect === null) return;
		const start = flowToPoint(
			{ x: userSelectionRect.startX, y: userSelectionRect.startY },
			transform
		);
		const rect = {
			startX: userSelectionRect.startX,
			startY: userSelectionRect.startY,
			x: Math.min(mouseX, start.x),
			y: Math.min(mouseY, start.y),
			width: Math.abs(mouseX - start.x),
			height: Math.abs(mouseY - start.y)
		};
		const previous = selectedIds.current;
		selectedIds.current = new Set(
			getNodesInside(
				nodeLookup.values(),
				rect,
				transform,
				selectionMode === SelectionMode.Partial,
				true
			).map((n) => n.id)
		);
		const same =
			previous.size === selectedIds.current.size &&
			[...previous].every((id) => selectedIds.current.has(id));
		if (!same) store.selectExactly(selectedIds.current);
		store.setState({ userSelectionRect: rect, userSelectionActive: true });
	};

	const stopAutoPan = () => {
		cancelAnimationFrame(autoPanId.current);
		autoPanId.current = 0;
		autoPanStarted.current = false;
	};
	const autoPan = () => {
		const bounds = containerBounds.current;
		if (bounds === null) return;
		const [x, y] = autoPanVelocity(pointer.current, bounds, AUTO_PAN_SPEED);
		if (store.panBy({ x, y }) && selectionInProgress.current) {
			commitRect(pointer.current.x, pointer.current.y);
		}
		autoPanId.current = requestAnimationFrame(autoPan);
	};
	useEffect(() => () => cancelAnimationFrame(autoPanId.current), []);

	// Capture : le lasso doit pouvoir partir au-dessus d'un node (touche de
	// sélection enfoncée) sans que le node reçoive le geste.
	const onPointerDownCapture = (event: ReactPointerEvent) => {
		const { domNode, transform } = store.getState();
		containerBounds.current = domNode?.getBoundingClientRect() ?? null;
		if (containerBounds.current === null) return;
		const onContainer = event.target === container.current;
		const target = event.target as Element;
		const isNoKey = !onContainer && target.closest(".nokey") !== null;
		const isActive = (selectionOnDrag && onContainer) || selectionKeyPressed;
		if (
			isNoKey ||
			!isSelecting ||
			!isActive ||
			event.button !== 0 ||
			!event.isPrimary
		)
			return;
		target.setPointerCapture?.(event.pointerId);
		selectionInProgress.current = false;
		const x = event.clientX - containerBounds.current.left;
		const y = event.clientY - containerBounds.current.top;
		const start = pointToFlow({ x, y }, transform);
		store.setState({
			userSelectionRect: {
				width: 0,
				height: 0,
				startX: start.x,
				startY: start.y,
				x,
				y
			}
		});
		if (!onContainer) {
			event.stopPropagation();
			event.preventDefault();
		}
	};

	const onPointerMove = (event: ReactPointerEvent) => {
		const { userSelectionRect, transform } = store.getState();
		const bounds = containerBounds.current;
		if (bounds === null || userSelectionRect === null) return;
		const mouseX = event.clientX - bounds.left;
		const mouseY = event.clientY - bounds.top;
		pointer.current = { x: mouseX, y: mouseY };
		const start = flowToPoint(
			{ x: userSelectionRect.startX, y: userSelectionRect.startY },
			transform
		);
		if (!selectionInProgress.current) {
			const required = selectionKeyPressed ? 0 : paneClickDistance;
			if (Math.hypot(mouseX - start.x, mouseY - start.y) <= required) return;
			store.resetSelectedElements();
			onSelectionStart?.(event);
		}
		selectionInProgress.current = true;
		if (!autoPanStarted.current) {
			autoPan();
			autoPanStarted.current = true;
		}
		commitRect(mouseX, mouseY);
	};

	const onPointerUp = (event: ReactPointerEvent) => {
		if (!isSelectionEnabled || event.button !== 0) return;
		(event.target as Element).releasePointerCapture?.(event.pointerId);
		if (
			!userSelectionActive &&
			event.target === container.current &&
			store.getState().userSelectionRect !== null
		) {
			onClick(event);
		}
		store.setState({ userSelectionActive: false, userSelectionRect: null });
		if (selectionInProgress.current) onSelectionEnd?.(event);
		stopAutoPan();
	};

	const onPointerCancel = (event: ReactPointerEvent) => {
		(event.target as Element).releasePointerCapture?.(event.pointerId);
		stopAutoPan();
	};

	const onClickCapture = (event: ReactMouseEvent) => {
		if (selectionInProgress.current) {
			event.stopPropagation();
			selectionInProgress.current = false;
		}
	};

	const onSelf =
		(handler: (event: ReactMouseEvent) => void) => (event: ReactMouseEvent) => {
			if (event.target === container.current) handler(event);
		};

	const classes: string[] = [canvasClass.pane, canvasClass.container];
	if (
		panOnDrag === true ||
		(Array.isArray(panOnDrag) && panOnDrag.includes(0))
	) {
		classes.push("draggable");
	}
	if (dragging) classes.push("dragging");
	if (isSelecting) classes.push("selection");

	return (
		// biome-ignore lint/a11y: fond de canvas, pas un contrôle
		<div
			ref={container}
			className={classes.join(" ")}
			onClick={isSelectionEnabled ? undefined : onSelf(onClick)}
			onContextMenu={onSelf(onContextMenu)}
			onPointerMove={isSelectionEnabled ? onPointerMove : undefined}
			onPointerUp={onPointerUp}
			onPointerCancel={isSelectionEnabled ? onPointerCancel : undefined}
			onPointerDownCapture={
				isSelectionEnabled ? onPointerDownCapture : undefined
			}
			onClickCapture={isSelectionEnabled ? onClickCapture : undefined}
		>
			{children}
			<UserSelection />
		</div>
	);
}

function UserSelection() {
	const { active, rect } = useNestStore(
		(s) => ({ active: s.userSelectionActive, rect: s.userSelectionRect }),
		shallow
	);
	if (!active || rect === null) return null;
	return (
		<div
			className={`${canvasClass.selection} ${canvasClass.container}`}
			style={{
				width: rect.width,
				height: rect.height,
				transform: `translate(${rect.x}px, ${rect.y}px)`
			}}
		/>
	);
}
