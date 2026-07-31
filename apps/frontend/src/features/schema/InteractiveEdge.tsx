import {
	EdgeLabelRenderer,
	type EdgeProps,
	getSmoothStepPath,
	Position,
	useReactFlow
} from "@xyflow/react";
import { type CSSProperties, type PointerEvent, useRef, useState } from "react";
import { closestSide, type Side } from "./edgeRouting";

export interface InteractiveEdgeData {
	readonly setOverride?: (
		edgeId: string,
		end: "source" | "target",
		side: Side
	) => void;
	readonly clearOverride?: (edgeId: string) => void;
	/** Ratio d'offset ∈ [-0.4, 0.4] appliqué à l'endpoint source pour éviter
	 * la superposition quand plusieurs edges partagent le même côté. Fourni
	 * par `SchemaCanvas.displayEdges`. */
	readonly sourceOffsetRatio?: number;
	readonly targetOffsetRatio?: number;
	readonly [key: string]: unknown;
}

/** RF Position enum → notre Side (les string values coïncident). */
function toSide(p: Position): Side {
	if (p === Position.Top) return "top";
	if (p === Position.Right) return "right";
	if (p === Position.Bottom) return "bottom";
	return "left";
}

/** Inverse : Side → RF Position (pour ré-injecter dans getSmoothStepPath). */
function toPosition(s: Side): Position {
	if (s === "top") return Position.Top;
	if (s === "right") return Position.Right;
	if (s === "bottom") return Position.Bottom;
	return Position.Left;
}

/** Positions monde des 4 mid-sides d'un rect. */
function anchorPoints(rect: {
	position: { x: number; y: number };
	width?: number | undefined;
	height?: number | undefined;
}): Record<Side, { x: number; y: number }> {
	const w = rect.width ?? 240;
	const h = rect.height ?? 200;
	const { x, y } = rect.position;
	return {
		top: { x: x + w / 2, y },
		right: { x: x + w, y: y + h / 2 },
		bottom: { x: x + w / 2, y: y + h },
		left: { x, y: y + h / 2 }
	};
}

/**
 * Décale un endpoint le long de son côté par un ratio ∈ [-0.4, 0.4].
 * - top/bottom : décalage sur X (largeur du nœud).
 * - left/right : décalage sur Y (hauteur du nœud).
 * ratio=0 → mid-side (défaut). ratio=±0.4 → à 40% de la mi-largeur/hauteur
 * du mid-side, laisse 10% de marge des coins.
 */
function offsetAlongSide(
	x: number,
	y: number,
	side: Side,
	ratio: number,
	node: { width?: number | undefined; height?: number | undefined }
): { x: number; y: number } {
	if (ratio === 0) return { x, y };
	const w = node.width ?? 240;
	const h = node.height ?? 200;
	if (side === "top" || side === "bottom") return { x: x + ratio * w, y };
	return { x, y: y + ratio * h };
}

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

/**
 * Edge FK personnalisé avec endpoints déplaçables.
 *
 * Comportement :
 * - Hover de la ligne → 2 poignées bleues aux endpoints (source, target).
 * - Grab d'une poignée → 3 anchors hollow apparaissent sur les 3 côtés
 *   restants du nœud correspondant (source si on drag l'endpoint source).
 *   La poignée saute en direct au mid-side le plus proche du curseur
 *   (feedback visuel immédiat).
 * - Release → override persisté via `data.setOverride` (côté snappé).
 *   Le path de l'edge se redessine avec le nouveau handle.
 * - Double-clic sur une poignée → `data.clearOverride` → retour à
 *   l'auto-routing (`bestHandles`).
 *
 * Le path lui-même reste rendu par `getSmoothStepPath` — pas de preview
 * pendant le drag (seule la poignée se déplace), il se met à jour au
 * release quand `SchemaCanvas` réinjecte les nouveaux handles.
 */
export function InteractiveEdge(props: EdgeProps) {
	const {
		id,
		source,
		target,
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
		style,
		markerEnd,
		data
	} = props;
	const { screenToFlowPosition, getNode } = useReactFlow();
	const api = data as InteractiveEdgeData | undefined;

	const [hovered, setHovered] = useState(false);
	const [dragEnd, setDragEnd] = useState<"source" | "target" | null>(null);
	const [snapped, setSnapped] = useState<Side | null>(null);
	// Ref miroir du snapped courant — `onUp` capture le state via closure,
	// potentiellement stale si un `onMove` a tiré juste avant sans qu'un
	// render n'ait committé. La ref garantit qu'on persiste le dernier côté.
	const snappedRef = useRef<Side | null>(null);
	// Debounce mouseleave pour transitionner de la ligne à la poignée sans
	// flicker (2 éléments distincts, le curseur passe par un no-mans-land).
	const hideTimerRef = useRef<number | null>(null);

	const show = () => {
		if (hideTimerRef.current !== null) {
			window.clearTimeout(hideTimerRef.current);
			hideTimerRef.current = null;
		}
		setHovered(true);
	};
	const hide = () => {
		if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
		hideTimerRef.current = window.setTimeout(() => setHovered(false), 100);
	};

	const showHandles = hovered || dragEnd !== null;

	// Nœud dont on affiche les anchors pendant le drag. `getNode` renvoie
	// le nœud vivant → les anchors suivent si la table est déplacée.
	const dragNodeId =
		dragEnd === "source" ? source : dragEnd === "target" ? target : null;
	const dragNode = dragNodeId !== null ? getNode(dragNodeId) : undefined;
	const anchors = dragNode
		? anchorPoints({
				position: dragNode.position,
				width: dragNode.width ?? undefined,
				height: dragNode.height ?? undefined
			})
		: null;

	// Offsets pour éviter la superposition quand plusieurs edges partagent
	// un côté. Appliqués aux endpoints RF (mid-side par défaut). Nœuds
	// récupérés via getNode pour connaître width/height.
	const sourceNode = getNode(source);
	const targetNode = getNode(target);
	const srcOffsetRatio = api?.sourceOffsetRatio ?? 0;
	const tgtOffsetRatio = api?.targetOffsetRatio ?? 0;
	const srcOffsetXY = offsetAlongSide(
		sourceX,
		sourceY,
		toSide(sourcePosition),
		srcOffsetRatio,
		{
			width: sourceNode?.width ?? undefined,
			height: sourceNode?.height ?? undefined
		}
	);
	const tgtOffsetXY = offsetAlongSide(
		targetX,
		targetY,
		toSide(targetPosition),
		tgtOffsetRatio,
		{
			width: targetNode?.width ?? undefined,
			height: targetNode?.height ?? undefined
		}
	);

	// Position visuelle des poignées : celle en cours de drag saute au mid
	// du snapped side (sans offset — on ne prédit pas la répartition sur le
	// nouveau côté) ; l'autre reste à son endpoint offset.
	const srcXY =
		dragEnd === "source" && snapped !== null && anchors !== null
			? anchors[snapped]
			: srcOffsetXY;
	const tgtXY =
		dragEnd === "target" && snapped !== null && anchors !== null
			? anchors[snapped]
			: tgtOffsetXY;
	// Position enum pour le routing du path pendant le drag — sans ça, le
	// smoothstep partirait dans la direction de l'ancien côté (bézier orienté)
	// depuis les nouvelles coords, résultat visuel bizarre.
	const srcPos =
		dragEnd === "source" && snapped !== null
			? toPosition(snapped)
			: sourcePosition;
	const tgtPos =
		dragEnd === "target" && snapped !== null
			? toPosition(snapped)
			: targetPosition;

	// Path preview live : recalculé à chaque snapped change → le path suit
	// la poignée pendant le drag. Au release, le SchemaCanvas réinjecte le
	// vrai `sourceHandle`/`targetHandle` et RF recalcule sourceX/… → même
	// path, transition invisible.
	const [edgePath] = getSmoothStepPath({
		sourceX: srcXY.x,
		sourceY: srcXY.y,
		targetX: tgtXY.x,
		targetY: tgtXY.y,
		sourcePosition: srcPos,
		targetPosition: tgtPos
	});

	const onDown = (end: "source" | "target") => (e: PointerEvent) => {
		e.stopPropagation();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		const initialSide = toSide(
			end === "source" ? sourcePosition : targetPosition
		);
		snappedRef.current = initialSide;
		setSnapped(initialSide);
		setDragEnd(end);
	};

	const onMove = (e: PointerEvent) => {
		if (dragEnd === null || !dragNode) return;
		const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
		const side = closestSide(pos, {
			x: dragNode.position.x,
			y: dragNode.position.y,
			width: dragNode.width ?? 240,
			height: dragNode.height ?? 200
		});
		if (side !== snappedRef.current) {
			snappedRef.current = side;
			setSnapped(side);
		}
	};

	const onUp = (e: PointerEvent) => {
		if (dragEnd === null) return;
		try {
			(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
		} catch {
			/* pointer déjà relâché */
		}
		const finalSide = snappedRef.current;
		if (finalSide !== null && api?.setOverride) {
			api.setOverride(id, dragEnd, finalSide);
		}
		snappedRef.current = null;
		setSnapped(null);
		setDragEnd(null);
	};

	const onDoubleClick = (e: PointerEvent) => {
		e.stopPropagation();
		api?.clearOverride?.(id);
	};

	return (
		<>
			<path
				d={edgePath}
				className="react-flow__edge-path"
				style={style}
				markerEnd={markerEnd}
				fill="none"
			/>
			{/* Ligne d'interaction (invisible, large) — capte le hover. */}
			<path
				d={edgePath}
				fill="none"
				stroke="transparent"
				strokeWidth={20}
				onMouseEnter={show}
				onMouseLeave={hide}
			/>
			{showHandles ? (
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
						onMouseEnter={show}
						onMouseLeave={hide}
						aria-label="Déplacer l'ancre source"
						title="Glisser pour changer de côté · double-clic pour réinitialiser"
					/>
					<div
						style={handleStyle(tgtXY.x, tgtXY.y, dragEnd === "target")}
						onPointerDown={onDown("target")}
						onPointerMove={onMove}
						onPointerUp={onUp}
						onDoubleClick={onDoubleClick}
						onMouseEnter={show}
						onMouseLeave={hide}
						aria-label="Déplacer l'ancre target"
						title="Glisser pour changer de côté · double-clic pour réinitialiser"
					/>
				</EdgeLabelRenderer>
			) : null}
		</>
	);
}
