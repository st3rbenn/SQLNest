import { IconChevronDown, IconChevronRight, IconClockHour3, IconServer } from "@tabler/icons-react";
import type { Node, NodeProps } from "@xyflow/react";
import { useEffect, useState } from "react";
import {
	SYSTEM_BORDER,
	SystemNodeShell
} from "../schema/nodes/SystemNodeShell";
import type { ChecksumHistoryEntry } from "./checksumHistoryClient";
import { SCHEMA_EVENTS_COLLECTION } from "./schemaEventsCollection";
import { UnseenEventsBadge } from "./UnseenEventsBadge";
import { useChecksumHistory } from "./useChecksumHistory";
import { useUnseenSchemaEvents } from "./useUnseenSchemaEvents";

export const SYSTEM_TABLE_ID = "__sqlnest_schema_events__";
export const SYSTEM_TABLE_DEFAULT_WIDTH = 280;
export const SYSTEM_TABLE_DEFAULT_HEIGHT = 200;
export const SYSTEM_TABLE_MIN_WIDTH = 240;
export const SYSTEM_TABLE_MIN_HEIGHT = 140;

const HEADER_H = 46;
const ROW_H = 22;

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

/**
 * Node RF de la table système `schema_events` — audit trail des checksums
 * vus par le canvas courant. Auto-injecté sur tous les canvases,
 * non-supprimable, draggable + resizable comme les tables user.
 *
 * Le chrome (bordure violette, header + badge Système, NodeResizer,
 * AllHandles) vit dans [[SystemNodeShell]] — partagé avec le node Enums.
 * Ici : uniquement le contenu propre (fields preview + audit trail).
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
	const unseen = useUnseenSchemaEvents(connectionId, teamSlug);

	// Ouvrir la preview stamp le timestamp de lecture — le badge disparaît
	// dès que l'user regarde. Effet plutôt que dans onClick pour couvrir
	// aussi les cas où l'expanded est piloté par un default true (rare mais
	// possible en v-next).
	useEffect(() => {
		if (expanded) unseen.markSeen();
	}, [expanded, unseen.markSeen]);

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
		<div style={{ position: "relative" }}>
			<UnseenEventsBadge count={unseen.count} capped={unseen.capped} />
			<SystemNodeShell
				width={effectiveWidth}
				height={effectiveHeight}
				minWidth={SYSTEM_TABLE_MIN_WIDTH}
				minHeight={SYSTEM_TABLE_MIN_HEIGHT}
				icon={<IconServer size={14} stroke={2} color={SYSTEM_BORDER} />}
				title={SCHEMA_EVENTS_COLLECTION.name}
				onResizeEnd={onResizeEnd}
			>
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
					<span>
						{expanded ? "Masquer les événements" : "Voir les événements"}
					</span>
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
			</SystemNodeShell>
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
