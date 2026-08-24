import {
	IconChevronDown,
	IconChevronRight,
	IconClockHour3,
	IconLock,
	IconServer
} from "@tabler/icons-react";
import {
	Handle,
	type Node,
	type NodeProps,
	NodeResizer,
	Position
} from "@xyflow/react";
import { type CSSProperties, Fragment, useState } from "react";
import { SCHEMA_EVENTS_COLLECTION } from "./schemaEventsCollection";
import type { ChecksumHistoryEntry } from "./checksumHistoryClient";
import { useChecksumHistory } from "./useChecksumHistory";

export const SYSTEM_TABLE_ID = "__sqlnest_schema_events__";
export const SYSTEM_TABLE_DEFAULT_WIDTH = 280;
export const SYSTEM_TABLE_DEFAULT_HEIGHT = 200;
export const SYSTEM_TABLE_MIN_WIDTH = 240;
export const SYSTEM_TABLE_MIN_HEIGHT = 140;

const HEADER_H = 46;
const ROW_H = 22;

/** Palette système — distincte des tables user (bleu declared / ambre inferred).
 * Violet indigo sur `--sqlnest-surface` : signale "meta / infrastructure". */
const SYSTEM_BORDER = "#7c5cff";
const SYSTEM_HEADER = "rgba(124,92,255,0.12)";

export interface SystemSchemaEventsNodeData {
	readonly connectionId: string;
	readonly teamSlug: string | null;
	/** Callback au release du resize — persist width/height/position via
	 * `useSchemaEventsNode` (RF déplace l'origine sur un handle top/left
	 * pour garder l'opposé fixe → il faut aussi persister x/y). */
	readonly onResizeEnd?: (params: {
		width: number;
		height: number;
		x: number;
		y: number;
	}) => void;
	readonly [key: string]: unknown;
}

export type SystemSchemaEventsNodeType = Node<
	SystemSchemaEventsNodeData,
	"system-schema-events"
>;

const HIDDEN_HANDLE: CSSProperties = { opacity: 0, border: "none" };
const HANDLE_SIDES = [
	{ id: "top", position: Position.Top },
	{ id: "right", position: Position.Right },
	{ id: "bottom", position: Position.Bottom },
	{ id: "left", position: Position.Left }
] as const;

function AllHandles() {
	return (
		<>
			{HANDLE_SIDES.map((s) => (
				<Fragment key={s.id}>
					<Handle
						id={s.id}
						type="source"
						position={s.position}
						style={HIDDEN_HANDLE}
					/>
					<Handle
						id={s.id}
						type="target"
						position={s.position}
						style={HIDDEN_HANDLE}
					/>
				</Fragment>
			))}
		</>
	);
}

/**
 * Node RF de la table système `schema_events` — audit trail des checksums
 * vus par le canvas courant. Auto-injecté sur tous les canvases,
 * non-supprimable, draggable + resizable comme les tables user.
 *
 * Réutilise le pattern TableNode : `NodeResizer` (4 sides + 4 corners avec
 * onResizeEnd), `AllHandles` (4 sides × source+target invisibles),
 * `width/height` push par RF → shell dimensionnable. Le drag et le resize
 * sont pilotés nativement par RF via `useNodesState` (voir
 * `useSchemaEventsNode`).
 */
export function SystemSchemaEventsNode({
	data,
	width,
	height: heightProp
}: NodeProps<SystemSchemaEventsNodeType>) {
	const { connectionId, teamSlug, onResizeEnd } = data;
	const [expanded, setExpanded] = useState(false);
	const history = useChecksumHistory(connectionId, teamSlug, {
		enabled: expanded
	});
	const rows = history.data?.pages.flatMap((p) => p?.entries ?? []) ?? [];

	const effectiveWidth = width ?? SYSTEM_TABLE_DEFAULT_WIDTH;
	const effectiveHeight = heightProp ?? SYSTEM_TABLE_DEFAULT_HEIGHT;
	const contentAvailable = effectiveHeight - HEADER_H;
	const fieldsShown = Math.max(
		0,
		Math.min(
			SCHEMA_EVENTS_COLLECTION.fields.length,
			Math.floor((contentAvailable - 36) / ROW_H)
		)
	);
	const shownFields = SCHEMA_EVENTS_COLLECTION.fields.slice(0, fieldsShown);

	return (
		<div
			style={{
				width: effectiveWidth,
				height: effectiveHeight,
				background: "var(--sqlnest-surface)",
				border: `2px solid ${SYSTEM_BORDER}`,
				borderRadius: 10,
				overflow: "hidden",
				fontFamily: "ui-sans-serif, system-ui, sans-serif",
				boxShadow: "0 1px 3px rgba(0,0,0,0.35)",
				display: "flex",
				flexDirection: "column"
			}}
		>
			<NodeResizer
				isVisible
				minWidth={SYSTEM_TABLE_MIN_WIDTH}
				maxWidth={800}
				minHeight={SYSTEM_TABLE_MIN_HEIGHT}
				maxHeight={1200}
				lineStyle={{ borderColor: SYSTEM_BORDER, borderWidth: 1.5 }}
				handleStyle={{
					width: 8,
					height: 8,
					borderRadius: 2,
					background: "var(--sqlnest-surface)",
					borderColor: SYSTEM_BORDER,
					borderWidth: 2
				}}
				onResizeEnd={(_, params) =>
					onResizeEnd?.({
						width: params.width,
						height: params.height,
						x: params.x ?? 0,
						y: params.y ?? 0
					})
				}
			/>
			<AllHandles />
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: 8,
					padding: "10px 12px",
					borderBottom: "1px solid var(--sqlnest-border)",
					background: SYSTEM_HEADER,
					flexShrink: 0
				}}
			>
				<span
					style={{
						display: "flex",
						alignItems: "center",
						gap: 6,
						fontWeight: 700,
						fontSize: 13,
						color: "var(--sqlnest-text-primary)"
					}}
				>
					<IconServer size={14} stroke={2} color={SYSTEM_BORDER} />
					{SCHEMA_EVENTS_COLLECTION.name}
				</span>
				<span
					style={{
						display: "flex",
						alignItems: "center",
						gap: 3,
						fontSize: 10,
						fontWeight: 600,
						color: SYSTEM_BORDER,
						letterSpacing: 0.5,
						textTransform: "uppercase"
					}}
				>
					<IconLock size={10} stroke={2.5} />
					Système
				</span>
			</div>
			<div style={{ padding: "4px 0", flex: "0 0 auto" }}>
				{shownFields.map((f) => (
					<div
						key={f.name}
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							gap: 8,
							height: ROW_H,
							padding: "0 12px",
							fontSize: 11.5,
							color: "var(--sqlnest-text-secondary)"
						}}
					>
						<span>{f.name}</span>
						<span
							style={{
								fontSize: 10.5,
								color: "var(--sqlnest-text-tertiary)"
							}}
						>
							{f.type}
							{f.nullable ? "?" : ""}
						</span>
					</div>
				))}
			</div>
			<button
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					setExpanded((v) => !v);
				}}
				className="nodrag"
				style={{
					display: "flex",
					alignItems: "center",
					gap: 6,
					width: "100%",
					padding: "6px 12px",
					background: "transparent",
					border: "none",
					borderTop: "1px solid var(--sqlnest-border-subtle)",
					color: "var(--sqlnest-text-tertiary)",
					fontSize: 11,
					cursor: "pointer",
					textAlign: "left",
					flexShrink: 0
				}}
			>
				{expanded ? (
					<IconChevronDown size={12} stroke={2} />
				) : (
					<IconChevronRight size={12} stroke={2} />
				)}
				<span>{expanded ? "Masquer les événements" : "Voir les événements"}</span>
			</button>
			{expanded && (
				<EventsPreview
					rows={rows}
					loading={history.isLoading}
					error={history.isError}
					hasMore={history.hasNextPage ?? false}
					loadingMore={history.isFetchingNextPage}
					onLoadMore={() => history.fetchNextPage()}
				/>
			)}
		</div>
	);
}

function EventsPreview({
	rows,
	loading,
	error,
	hasMore,
	loadingMore,
	onLoadMore
}: {
	readonly rows: readonly ChecksumHistoryEntry[];
	readonly loading: boolean;
	readonly error: boolean;
	readonly hasMore: boolean;
	readonly loadingMore: boolean;
	readonly onLoadMore: () => void;
}) {
	return (
		<div
			className="nowheel nodrag"
			style={{
				borderTop: "1px solid var(--sqlnest-border-subtle)",
				flex: "1 1 auto",
				minHeight: 0,
				overflowY: "auto",
				padding: "6px 0"
			}}
		>
			{loading && <StatusLine>Chargement…</StatusLine>}
			{error && <StatusLine tone="danger">Échec du chargement</StatusLine>}
			{!loading && !error && rows.length === 0 && (
				<StatusLine>Aucun événement</StatusLine>
			)}
			{rows.map((row) => (
				<EventRow key={row.id} row={row} />
			))}
			{hasMore && (
				<button
					type="button"
					onClick={onLoadMore}
					disabled={loadingMore}
					style={{
						display: "block",
						margin: "6px auto 2px",
						padding: "3px 10px",
						fontSize: 10.5,
						background: "transparent",
						border: "1px solid var(--sqlnest-border-subtle)",
						borderRadius: 4,
						color: "var(--sqlnest-text-tertiary)",
						cursor: loadingMore ? "wait" : "pointer"
					}}
				>
					{loadingMore ? "…" : "Plus"}
				</button>
			)}
		</div>
	);
}

function StatusLine({
	children,
	tone
}: {
	readonly children: React.ReactNode;
	readonly tone?: "danger";
}) {
	return (
		<p
			style={{
				margin: 0,
				padding: "8px 12px",
				fontSize: 11,
				color:
					tone === "danger"
						? "var(--sqlnest-danger)"
						: "var(--sqlnest-text-tertiary)"
			}}
		>
			{children}
		</p>
	);
}

function EventRow({ row }: { readonly row: ChecksumHistoryEntry }) {
	const time = new Date(row.seenAt).toLocaleString("fr-FR", {
		day: "2-digit",
		month: "short",
		hour: "2-digit",
		minute: "2-digit"
	});
	const short = row.dbSchemaChecksum.slice(0, 8);
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "3px 12px",
				fontSize: 10.5,
				fontFamily: "ui-monospace, monospace",
				color: "var(--sqlnest-text-secondary)"
			}}
		>
			<IconClockHour3
				size={11}
				stroke={1.8}
				style={{ color: "var(--sqlnest-text-tertiary)" }}
			/>
			<span style={{ color: "var(--sqlnest-text-tertiary)", minWidth: 90 }}>
				{time}
			</span>
			<span style={{ color: "var(--sqlnest-text-primary)" }}>{short}</span>
		</div>
	);
}
