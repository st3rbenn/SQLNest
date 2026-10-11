import {
	type ComponentType,
	memo,
	type KeyboardEvent as ReactKeyboardEvent,
	useCallback,
	useMemo,
	useRef
} from "react";
import { canvasClass } from "../constants";
import { shallow, useNestStore, useStoreApi } from "../context";
import {
	createMarkerIds,
	DEFAULT_MARKER_COLOR,
	type EdgePosition,
	elevatedEdgeZIndex,
	getEdgePosition,
	getMarkerId,
	isEdgeVisible,
	isMarkerType
} from "../edges";
import { NO_PAN_CLASS } from "../panZoom";
import type { CanvasState } from "../store";
import { type EdgeProps, type EdgeTypes, MarkerType } from "../types";

const SELECTION_KEYS = ["Enter", " ", "Escape"];

/** Ids des edges à rendre — tous, ou ceux dont les deux nodes touchent l'écran. */
export function visibleEdgeIds(s: CanvasState, onlyVisible: boolean): string[] {
	if (!onlyVisible) return s.edges.map((edge) => edge.id);
	const ids: string[] = [];
	if (s.width && s.height) {
		for (const edge of s.edges) {
			const sourceNode = s.nodeLookup.get(edge.source);
			const targetNode = s.nodeLookup.get(edge.target);
			if (
				sourceNode &&
				targetNode &&
				isEdgeVisible({
					sourceNode,
					targetNode,
					width: s.width,
					height: s.height,
					transform: s.transform
				})
			) {
				ids.push(edge.id);
			}
		}
	}
	return ids;
}

function ArrowSymbol({
	color = "none",
	strokeWidth = 1
}: {
	color?: string | undefined;
	strokeWidth?: number | undefined;
}) {
	return (
		<polyline
			className="arrow"
			style={{ strokeWidth, ...(color && { stroke: color }) }}
			strokeLinecap="round"
			fill="none"
			strokeLinejoin="round"
			points="-5,-4 0,0 -5,4"
		/>
	);
}

function ArrowClosedSymbol({
	color = "none",
	strokeWidth = 1
}: {
	color?: string | undefined;
	strokeWidth?: number | undefined;
}) {
	return (
		<polyline
			className="arrowclosed"
			style={{ strokeWidth, ...(color && { stroke: color, fill: color }) }}
			strokeLinecap="round"
			strokeLinejoin="round"
			points="-5,-4 0,0 -5,4 -5,-4"
		/>
	);
}

const MARKER_SYMBOLS = {
	[MarkerType.Arrow]: ArrowSymbol,
	[MarkerType.ArrowClosed]: ArrowClosedSymbol
};

/** `<defs>` partagés : un marker par combinaison (type, couleur, taille…). */
function MarkerDefinitionsComponent() {
	const edges = useNestStore((s) => s.edges);
	const instanceId = useNestStore((s) => s.instanceId);
	const markers = useMemo(
		() => createMarkerIds(edges, instanceId, DEFAULT_MARKER_COLOR),
		[edges, instanceId]
	);
	if (markers.length === 0) return null;
	return (
		<svg className={canvasClass.marker} aria-hidden="true">
			<defs>
				{markers.map((marker) => {
					if (!isMarkerType(marker.type)) return null;
					const MarkerSymbol = MARKER_SYMBOLS[marker.type];
					return (
						<marker
							key={marker.id}
							className={canvasClass.arrowhead}
							id={marker.id}
							markerWidth={`${marker.width ?? 12.5}`}
							markerHeight={`${marker.height ?? 12.5}`}
							viewBox="-10 -10 20 20"
							markerUnits={marker.markerUnits ?? "strokeWidth"}
							orient={marker.orient ?? "auto-start-reverse"}
							refX="0"
							refY="0"
						>
							<MarkerSymbol
								color={marker.color}
								strokeWidth={marker.strokeWidth}
							/>
						</marker>
					);
				})}
			</defs>
		</svg>
	);
}

const MarkerDefinitions = memo(MarkerDefinitionsComponent);

type Positioned = Partial<EdgePosition> & { zIndex?: number | undefined };

const nullPosition: Positioned = {};

type EdgeWrapperProps = {
	id: string;
	edgeTypes: EdgeTypes | undefined;
};

function EdgeWrapperComponent({ id, edgeTypes }: EdgeWrapperProps) {
	const store = useStoreApi();
	const edge = useNestStore((s) => s.edgeLookup.get(id));
	const instanceId = useNestStore((s) => s.instanceId);
	const ref = useRef<SVGGElement>(null);
	const source = edge?.source;
	const target = edge?.target;
	const sourceHandle = edge?.sourceHandle ?? null;
	const targetHandle = edge?.targetHandle ?? null;
	const selected = edge?.selected;
	const edgeZ = edge?.zIndex;
	const selector = useCallback(
		(s: CanvasState): Positioned => {
			const sourceNode = source ? s.nodeLookup.get(source) : undefined;
			const targetNode = target ? s.nodeLookup.get(target) : undefined;
			if (!sourceNode || !targetNode) return nullPosition;
			const position = getEdgePosition(
				sourceNode,
				targetNode,
				sourceHandle || null,
				targetHandle || null
			);
			return {
				...(position ?? nullPosition),
				zIndex: elevatedEdgeZIndex({
					selected,
					zIndex: edgeZ,
					sourceNode,
					targetNode
				})
			};
		},
		[source, target, sourceHandle, targetHandle, selected, edgeZ]
	);
	const {
		zIndex = edgeZ,
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition
	} = useNestStore(selector, shallow);
	const markerStart = useMemo(
		() =>
			edge?.markerStart
				? `url('#${getMarkerId(edge.markerStart, instanceId)}')`
				: undefined,
		[edge?.markerStart, instanceId]
	);
	const markerEnd = useMemo(
		() =>
			edge?.markerEnd
				? `url('#${getMarkerId(edge.markerEnd, instanceId)}')`
				: undefined,
		[edge?.markerEnd, instanceId]
	);

	if (
		edge === undefined ||
		edge.hidden ||
		sourceX === undefined ||
		sourceY === undefined ||
		targetX === undefined ||
		targetY === undefined ||
		sourcePosition === undefined ||
		targetPosition === undefined
	) {
		return null;
	}

	const type = edge.type || "default";
	const EdgeComponent = edgeTypes?.[type] as
		| ComponentType<EdgeProps>
		| undefined;
	if (EdgeComponent === undefined) return null;

	const isFocusable = edge.focusable !== false;
	const isSelectable = edge.selectable !== false;

	// Les edges ne sont pas pilotés par l'app : sélectionner un edge
	// désélectionne seulement les nodes.
	const onClick = () => {
		if (!isSelectable) return;
		const { multiSelectionActive } = store.getState();
		if (edge.selected && multiSelectionActive) {
			ref.current?.blur();
			return;
		}
		if (!multiSelectionActive) store.selectExactly(new Set());
	};
	const onKeyDown = (event: ReactKeyboardEvent) => {
		if (!SELECTION_KEYS.includes(event.key) || !isSelectable) return;
		if (event.key === "Escape") {
			ref.current?.blur();
			store.unselectNodes();
		} else if (!store.getState().multiSelectionActive) {
			store.selectExactly(new Set());
		}
	};

	const classes = [canvasClass.edge, `${canvasClass.edge}-${type}`];
	if (edge.className) classes.push(edge.className);
	classes.push(NO_PAN_CLASS);
	if (edge.selected) classes.push("selected");
	if (edge.animated) classes.push("animated");
	if (!isSelectable) classes.push("inactive");
	if (isSelectable) classes.push("selectable");

	return (
		// biome-ignore lint/a11y/noSvgWithoutTitle: le libellé est porté par le groupe
		<svg style={{ zIndex }}>
			{/* biome-ignore lint/a11y: groupe focusable, rôle porté par `role` */}
			<g
				ref={ref}
				className={classes.join(" ")}
				onClick={onClick}
				onKeyDown={isFocusable ? onKeyDown : undefined}
				tabIndex={isFocusable ? 0 : undefined}
				role={isFocusable ? "group" : "img"}
				aria-roledescription="edge"
				data-id={id}
				aria-label={`Edge de ${edge.source} vers ${edge.target}`}
				aria-describedby={
					isFocusable ? `nest-edge-desc-${instanceId}` : undefined
				}
			>
				<EdgeComponent
					id={id}
					source={edge.source}
					target={edge.target}
					selected={edge.selected}
					animated={edge.animated}
					selectable={isSelectable}
					deletable={edge.deletable ?? true}
					label={edge.label}
					sourceX={sourceX}
					sourceY={sourceY}
					targetX={targetX}
					targetY={targetY}
					sourcePosition={sourcePosition}
					targetPosition={targetPosition}
					data={edge.data}
					style={edge.style}
					sourceHandleId={edge.sourceHandle}
					targetHandleId={edge.targetHandle}
					markerStart={markerStart}
					markerEnd={markerEnd}
					interactionWidth={edge.interactionWidth}
				/>
			</g>
		</svg>
	);
}

const EdgeWrapper = memo(EdgeWrapperComponent);

export type EdgeRendererProps = {
	edgeTypes: EdgeTypes | undefined;
	onlyRenderVisibleElements: boolean;
};

/** Calque SVG des edges, sous les nodes ; un `<svg>` par edge pour son z-index. */
function EdgeRendererComponent({
	edgeTypes,
	onlyRenderVisibleElements
}: EdgeRendererProps) {
	const ids = useNestStore(
		useCallback(
			(s: CanvasState) => visibleEdgeIds(s, onlyRenderVisibleElements),
			[onlyRenderVisibleElements]
		),
		shallow
	);
	return (
		<div className={canvasClass.edges}>
			<MarkerDefinitions />
			{ids.map((id) => (
				<EdgeWrapper key={id} id={id} edgeTypes={edgeTypes} />
			))}
		</div>
	);
}

export const EdgeRenderer = memo(EdgeRendererComponent);
