import { EdgeLabelRenderer } from "@xyflow/react";
import type { CSSProperties, PointerEvent } from "react";
import type { Side } from "../edgeRouting";

const SIDES: readonly Side[] = ["top", "right", "bottom", "left"];

const HANDLE_BASE: CSSProperties = {
	position: "absolute",
	width: 14,
	height: 14,
	borderRadius: "50%",
	background: "#2563eb",
	border: "2px solid #fff",
	boxShadow: "0 0 0 1px #2563eb, 0 1px 3px rgba(15,23,42,0.25)",
	pointerEvents: "auto",
	touchAction: "none",
	zIndex: 10
};

const ANCHOR_BASE: CSSProperties = {
	position: "absolute",
	width: 10,
	height: 10,
	borderRadius: "50%",
	background: "#fff",
	border: "2px solid #2563eb",
	opacity: 0.7,
	pointerEvents: "none",
	zIndex: 9,
	transition: "opacity 80ms"
};

function handleStyle(x: number, y: number, dragging: boolean): CSSProperties {
	return {
		...HANDLE_BASE,
		transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
		cursor: dragging ? "grabbing" : "grab"
	};
}

function anchorStyle(x: number, y: number): CSSProperties {
	return {
		...ANCHOR_BASE,
		transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`
	};
}

export interface EdgeHandlesProps {
	readonly srcXY: { x: number; y: number };
	readonly tgtXY: { x: number; y: number };
	readonly dragEnd: "source" | "target" | null;
	readonly snapped: Side | null;
	readonly anchors: Record<Side, { x: number; y: number }> | null;
	readonly onDown: (
		end: "source" | "target"
	) => (e: PointerEvent) => void;
	readonly onMove: (e: PointerEvent) => void;
	readonly onUp: (e: PointerEvent) => void;
	readonly onDoubleClick: (e: PointerEvent) => void;
	readonly onEnter: () => void;
	readonly onLeave: () => void;
}

export function EdgeHandles({
	srcXY,
	tgtXY,
	dragEnd,
	snapped,
	anchors,
	onDown,
	onMove,
	onUp,
	onDoubleClick,
	onEnter,
	onLeave
}: EdgeHandlesProps) {
	return (
		<EdgeLabelRenderer>
			{/* Anchors sur les 3 côtés autres que le snapped (pointer-events
			 * none → ne volent pas la capture du handle). */}
			{dragEnd !== null && anchors !== null
				? SIDES.filter((s) => s !== snapped).map((s) => (
						<div key={s} style={anchorStyle(anchors[s].x, anchors[s].y)} />
					))
				: null}
			<div
				style={handleStyle(srcXY.x, srcXY.y, dragEnd === "source")}
				onPointerDown={onDown("source")}
				onPointerMove={onMove}
				onPointerUp={onUp}
				onDoubleClick={onDoubleClick}
				onMouseEnter={onEnter}
				onMouseLeave={onLeave}
				aria-label="Déplacer l'ancre source"
				title="Glisser pour changer de côté · double-clic pour réinitialiser"
			/>
			<div
				style={handleStyle(tgtXY.x, tgtXY.y, dragEnd === "target")}
				onPointerDown={onDown("target")}
				onPointerMove={onMove}
				onPointerUp={onUp}
				onDoubleClick={onDoubleClick}
				onMouseEnter={onEnter}
				onMouseLeave={onLeave}
				aria-label="Déplacer l'ancre target"
				title="Glisser pour changer de côté · double-clic pour réinitialiser"
			/>
		</EdgeLabelRenderer>
	);
}
