import type {
	HTMLAttributes,
	MouseEvent as ReactMouseEvent,
	ReactNode
} from "react";
import { clickConnect, startConnection } from "../connection";
import { canvasClass } from "../constants";
import { shallow, useNestStore, useNodeId, useStoreApi } from "../context";
import { NO_DRAG_CLASS } from "../drag";
import { NO_PAN_CLASS } from "../panZoom";
import type { CanvasState } from "../store";
import { type HandleType, Position } from "../types";

export type HandleProps = Omit<HTMLAttributes<HTMLDivElement>, "id"> & {
	type?: HandleType;
	position?: Position;
	id?: string | null;
	isConnectable?: boolean;
	isConnectableStart?: boolean;
	isConnectableEnd?: boolean;
	children?: ReactNode;
};

const idle = {
	connectingFrom: false,
	connectingTo: false,
	clickConnecting: false,
	isPossibleEndHandle: false,
	connectionInProcess: false,
	clickConnectionInProcess: false,
	valid: false
};

const connectingSelector =
	(nodeId: string | null, handleId: string | null, type: HandleType) =>
	(s: CanvasState) => {
		const { connectionClickStartHandle: click, connection } = s;
		const { fromHandle, toHandle, isValid } = connection;
		if (!fromHandle && !click) return idle;
		const connectingTo =
			toHandle?.nodeId === nodeId &&
			toHandle?.id === handleId &&
			toHandle?.type === type;
		return {
			connectingFrom:
				fromHandle?.nodeId === nodeId &&
				fromHandle?.id === handleId &&
				fromHandle?.type === type,
			connectingTo,
			clickConnecting:
				click?.nodeId === nodeId &&
				click?.id === handleId &&
				click?.type === type,
			isPossibleEndHandle: fromHandle?.type !== type,
			connectionInProcess: !!fromHandle,
			clickConnectionInProcess: !!click,
			valid: connectingTo && isValid === true
		};
	};

/**
 * Point d'accroche des edges sur un node. Un drag depuis un handle trace une
 * ligne de connexion qui s'accroche au handle compatible le plus proche.
 */
export function Handle({
	type = "source",
	position = Position.Top,
	id,
	isConnectable = true,
	isConnectableStart = true,
	isConnectableEnd = true,
	className,
	children,
	onMouseDown,
	...rest
}: HandleProps) {
	const handleId = id ?? null;
	const store = useStoreApi();
	const nodeId = useNodeId();
	const instanceId = useNestStore((s) => s.instanceId);
	const state = useNestStore(
		connectingSelector(nodeId, handleId, type),
		shallow
	);

	const onPointerDown = (event: ReactMouseEvent<HTMLDivElement>) => {
		if (nodeId !== null && isConnectableStart && event.button === 0) {
			startConnection(
				event.nativeEvent,
				store,
				event.currentTarget,
				nodeId,
				handleId
			);
		}
		onMouseDown?.(event);
	};
	const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
		if (nodeId === null) return;
		clickConnect(
			event.nativeEvent,
			store,
			nodeId,
			handleId,
			type,
			isConnectableStart
		);
	};

	const classes = [
		canvasClass.handle,
		`${canvasClass.handle}-${position}`,
		NO_DRAG_CLASS,
		NO_PAN_CLASS,
		className,
		type === "target" ? "target" : "source",
		isConnectable && "connectable",
		isConnectableStart && "connectablestart",
		isConnectableEnd && "connectableend",
		state.clickConnecting && "clickconnecting",
		state.connectingFrom && "connectingfrom",
		state.connectingTo && "connectingto",
		state.valid && "valid",
		isConnectable &&
			(!state.connectionInProcess || state.isPossibleEndHandle) &&
			(state.connectionInProcess || state.clickConnectionInProcess
				? isConnectableEnd
				: isConnectableStart) &&
			"connectionindicator"
	].filter(Boolean);

	return (
		// biome-ignore lint/a11y: point d'accroche, pas un contrôle clavier
		<div
			data-handleid={handleId}
			data-nodeid={nodeId}
			data-handlepos={position}
			data-id={`${instanceId}-${nodeId}-${handleId}-${type}`}
			className={classes.join(" ")}
			onMouseDown={onPointerDown}
			onClick={onClick}
			{...rest}
		>
			{children}
		</div>
	);
}
