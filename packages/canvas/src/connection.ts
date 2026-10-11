import { canvasClass } from "./constants";
import {
	autoPan,
	flowToPoint,
	nodeDimensions,
	overlappingArea,
	pointToFlow
} from "./geometry";
import { findHandle, handlePosition, oppositePosition } from "./handles";
import type { CanvasStore } from "./store";
import type {
	ConnectionState,
	HandleBound,
	HandleType,
	InternalNode,
	XYPosition
} from "./types";

const CONNECTION_RADIUS = 20;
/** Marge autour du rayon pour présélectionner les nodes candidats. */
const ADDITIONAL_DISTANCE = 250;
const DRAG_THRESHOLD = 1;
const AUTO_PAN_SPEED = 15;

export type Connection = {
	source: string;
	sourceHandle: string | null;
	target: string;
	targetHandle: string | null;
};

/** Point client d'un événement souris, ou du premier doigt posé. */
export function clientPoint(event: MouseEvent | TouchEvent): {
	clientX: number;
	clientY: number;
} {
	if ("clientX" in event) return event;
	const touch = event.touches[0];
	return {
		clientX: touch?.clientX ?? Number.NaN,
		clientY: touch?.clientY ?? Number.NaN
	};
}

const handleDataId = (
	instanceId: string,
	nodeId: string,
	id: string | null,
	type: HandleType
) => `${instanceId}-${nodeId}-${id}-${type}`;

function typeOf(el: Element | null): HandleType | null {
	if (el?.classList.contains("target")) return "target";
	if (el?.classList.contains("source")) return "source";
	return null;
}

/** Handle le plus proche de `position` (flow) dans le rayon, type opposé préféré à égalité. */
function closestHandle(
	position: XYPosition,
	nodeLookup: Map<string, InternalNode>,
	from: HandleBound
): HandleBound | null {
	const reach = CONNECTION_RADIUS + ADDITIONAL_DISTANCE;
	let closest: HandleBound[] = [];
	let min = Number.POSITIVE_INFINITY;
	for (const node of nodeLookup.values()) {
		const { width, height } = nodeDimensions(node);
		const p = node.internals.positionAbsolute;
		if (
			overlappingArea(
				position.x - reach,
				position.y - reach,
				reach * 2,
				reach * 2,
				p.x,
				p.y,
				width,
				height
			) <= 0
		) {
			continue;
		}
		const handles = [
			...(node.internals.handleBounds?.source ?? []),
			...(node.internals.handleBounds?.target ?? [])
		];
		for (const handle of handles) {
			if (
				from.nodeId === handle.nodeId &&
				from.type === handle.type &&
				from.id === handle.id
			)
				continue;
			const { x, y } = handlePosition(node, handle, handle.position, true);
			const distance = Math.hypot(x - position.x, y - position.y);
			if (distance > CONNECTION_RADIUS) continue;
			if (distance < min) {
				closest = [{ ...handle, x, y }];
				min = distance;
			} else if (distance === min) {
				closest.push({ ...handle, x, y });
			}
		}
	}
	if (closest.length === 0) return null;
	if (closest.length > 1) {
		const opposite = from.type === "source" ? "target" : "source";
		return (
			closest.find((h) => h.type === opposite) ?? (closest[0] as HandleBound)
		);
	}
	return closest[0] as HandleBound;
}

type HandleCheck = {
	handleDomNode: Element | null;
	isValid: boolean;
	connection: Connection | null;
	toHandle: HandleBound | null;
};

/**
 * Valide une fin de connexion. Le handle sous le curseur passe avant le plus
 * proche ; en mode strict, une source se relie à une cible et inversement.
 */
export function checkHandle(
	event: MouseEvent | TouchEvent,
	store: CanvasStore,
	handle: Pick<HandleBound, "nodeId" | "id" | "type"> | null,
	from: { nodeId: string; handleId: string | null; type: HandleType }
): HandleCheck {
	const { instanceId, nodeLookup } = store.getState();
	const isTarget = from.type === "target";
	const handleDomNode = handle
		? document.querySelector(
				`.${canvasClass.handle}[data-id="${handleDataId(instanceId, handle.nodeId, handle.id, handle.type)}"]`
			)
		: null;
	const { clientX, clientY } = clientPoint(event);
	const below = document.elementFromPoint(clientX, clientY);
	const toCheck = below?.classList.contains(canvasClass.handle)
		? below
		: handleDomNode;
	const result: HandleCheck = {
		handleDomNode: toCheck,
		isValid: false,
		connection: null,
		toHandle: null
	};
	if (toCheck === null) return result;
	const type = typeOf(toCheck);
	const nodeId = toCheck.getAttribute("data-nodeid");
	const handleId = toCheck.getAttribute("data-handleid");
	if (nodeId === null || type === null) return result;
	result.connection = {
		source: isTarget ? nodeId : from.nodeId,
		sourceHandle: isTarget ? handleId : from.handleId,
		target: isTarget ? from.nodeId : nodeId,
		targetHandle: isTarget ? from.handleId : handleId
	};
	const connectable =
		toCheck.classList.contains("connectable") &&
		toCheck.classList.contains("connectableend");
	result.isValid =
		connectable &&
		((isTarget && type === "source") || (!isTarget && type === "target"));
	result.toHandle = findHandle(nodeLookup.get(nodeId), type, handleId, true);
	return result;
}

/**
 * Drag depuis un handle : la ligne de connexion suit le pointeur et
 * s'accroche au handle valide le plus proche. Au relâchement la connexion
 * est abandonnée (aucun `onConnect` dans l'app).
 */
export function startConnection(
	down: MouseEvent | TouchEvent,
	store: CanvasStore,
	handleDomNode: HTMLElement,
	nodeId: string,
	handleId: string | null
) {
	const type = typeOf(handleDomNode);
	const { domNode, nodeLookup } = store.getState();
	const bounds = domNode?.getBoundingClientRect();
	if (!bounds || type === null) return;
	const fromInternal = findHandle(nodeLookup.get(nodeId), type, handleId);
	const fromNode = nodeLookup.get(nodeId);
	if (fromInternal === null || fromNode === undefined) return;

	const eventPos = (e: MouseEvent | TouchEvent): XYPosition => {
		const { clientX, clientY } = clientPoint(e);
		return { x: clientX - bounds.left, y: clientY - bounds.top };
	};
	const start = clientPoint(down);
	const fromHandle: HandleBound = { ...fromInternal, nodeId, type };
	let position = eventPos(down);
	let started = false;
	let autoPanStarted = false;
	let autoPanId = 0;
	let previous: ConnectionState = {
		inProgress: true,
		isValid: null,
		from: handlePosition(fromNode, fromHandle, fromHandle.position, true),
		fromHandle,
		fromPosition: fromHandle.position,
		fromNode,
		to: position,
		toHandle: null,
		toPosition: oppositePosition[fromHandle.position],
		toNode: null,
		pointer: position
	};

	const panLoop = () => {
		const [x, y] = autoPan(position, bounds, AUTO_PAN_SPEED);
		store.panBy({ x, y });
		autoPanId = requestAnimationFrame(panLoop);
	};

	const onMove = (e: MouseEvent | TouchEvent) => {
		if (!started) {
			const { clientX, clientY } = clientPoint(e);
			const dx = clientX - start.clientX;
			const dy = clientY - start.clientY;
			if (dx * dx + dy * dy <= DRAG_THRESHOLD * DRAG_THRESHOLD) return;
			started = true;
			store.updateConnection(previous);
		}
		if (store.getState().connection.fromHandle === null) {
			onUp(e);
			return;
		}
		const { transform, nodeLookup: lookup } = store.getState();
		position = eventPos(e);
		const closest = closestHandle(
			pointToFlow(position, transform),
			lookup,
			fromHandle
		);
		if (!autoPanStarted) {
			panLoop();
			autoPanStarted = true;
		}
		const result = checkHandle(e, store, closest, { nodeId, handleId, type });
		const isValid = result.isValid ? true : closest ? false : null;
		const node = lookup.get(nodeId);
		const next: ConnectionState = {
			...previous,
			from: node
				? handlePosition(node, fromHandle, fromHandle.position, true)
				: previous.from,
			isValid,
			to:
				result.toHandle && isValid
					? flowToPoint(
							{ x: result.toHandle.x, y: result.toHandle.y },
							transform
						)
					: position,
			toHandle: result.toHandle,
			toPosition:
				isValid && result.toHandle
					? result.toHandle.position
					: oppositePosition[fromHandle.position],
			toNode: result.toHandle
				? (lookup.get(result.toHandle.nodeId) ?? null)
				: null,
			pointer: position
		};
		store.updateConnection(next);
		previous = next;
	};

	const onUp = (e: MouseEvent | TouchEvent) => {
		// Un doigt levé alors qu'un autre reste posé ne termine pas la connexion.
		if ("touches" in e && e.touches.length > 0) return;
		store.cancelConnection();
		cancelAnimationFrame(autoPanId);
		document.removeEventListener("mousemove", onMove);
		document.removeEventListener("mouseup", onUp);
		document.removeEventListener("touchmove", onMove);
		document.removeEventListener("touchend", onUp);
	};

	document.addEventListener("mousemove", onMove);
	document.addEventListener("mouseup", onUp);
	document.addEventListener("touchmove", onMove);
	document.addEventListener("touchend", onUp);
}

/**
 * Connexion « au clic » : un 1ᵉʳ clic arme le handle de départ, un 2ᵉ clic
 * sur un autre handle la termine.
 */
export function clickConnect(
	event: MouseEvent,
	store: CanvasStore,
	nodeId: string,
	handleId: string | null,
	type: HandleType,
	isConnectableStart: boolean
) {
	const start = store.getState().connectionClickStartHandle;
	if (start === null && !isConnectableStart) return;
	if (start === null) {
		store.setState({
			connectionClickStartHandle: { nodeId, type, id: handleId }
		});
		return;
	}
	checkHandle(
		event,
		store,
		{ nodeId, id: handleId, type },
		{
			nodeId: start.nodeId,
			handleId: start.id,
			type: start.type
		}
	);
	store.setState({ connectionClickStartHandle: null });
}
