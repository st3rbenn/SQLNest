import { ActionIcon } from "@mantine/core";
import {
	IconChevronDown,
	IconChevronRight,
	IconClockHour3,
	IconLock,
	IconServer
} from "@tabler/icons-react";
import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { type CSSProperties, Fragment, useState } from "react";
import { SCHEMA_EVENTS_COLLECTION } from "./schemaEventsCollection";
import type { ChecksumHistoryEntry } from "./checksumHistoryClient";
import { useChecksumHistory } from "./useChecksumHistory";

export const SYSTEM_TABLE_ID = "__sqlnest_schema_events__";
const NODE_WIDTH = 280;
const HEADER_H = 46;
const ROW_H = 22;

/** Palette système — distincte des tables user (bleu declared / ambre inferred).
 * Violet indigo posé sur `--sqlnest-surface` — signale "meta / infrastructure". */
const SYSTEM_BORDER = "#7c5cff";
const SYSTEM_HEADER = "rgba(124,92,255,0.12)";

export interface SystemSchemaEventsNodeData {
	readonly connectionId: string;
	readonly teamSlug: string | null;
	readonly [key: string]: unknown;
}

export type SystemSchemaEventsNodeType = Node<
	SystemSchemaEventsNodeData,
	"system-schema-events"
>;

const HIDDEN_HANDLE: CSSProperties = { opacity: 0, border: "none" };

function AllHandles() {
	const sides = [
		{ id: "top", position: Position.Top },
		{ id: "right", position: Position.Right },
		{ id: "bottom", position: Position.Bottom },
		{ id: "left", position: Position.Left }
	] as const;
	return (
		<>
			{sides.map((s) => (
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
 * non-supprimable, déplaçable. Palette violet indigo pour signaler
 * "infrastructure SQLNest", distincte des tables user (bleu declared).
 *
 * Deux modes :
 *  - collapsed : affiche seulement les colonnes fixes (comme une TableNode).
 *  - expanded  : ajoute une preview inline des 50 derniers events (fetch
 *    on-demand via useChecksumHistory).
 *
 * La table est requêtable via SNQL (`find schema_events pick id, checksum
 * sort seen_at desc limit N`). L'exécution est routée par le frontend vers
 * l'API SQLNest, pas vers la DB user (voir `useRunQuery`).
 */
export function SystemSchemaEventsNode({
	data
}: NodeProps<SystemSchemaEventsNodeType>) {
	const { connectionId, teamSlug } = data;
	const [expanded, setExpanded] = useState(false);
	const history = useChecksumHistory(connectionId, teamSlug, {
		enabled: expanded
	});
	const rows = history.data?.pages.flatMap((p) => p?.entries ?? []) ?? [];

	const contentHeight =
		HEADER_H + SCHEMA_EVENTS_COLLECTION.fields.length * ROW_H + 8;

	return (
		<div
			style={{
				width: NODE_WIDTH,
				background: "var(--sqlnest-surface)",
				border: `2px solid ${SYSTEM_BORDER}`,
				borderRadius: 10,
				overflow: "hidden",
				fontFamily: "ui-sans-serif, system-ui, sans-serif",
				boxShadow: "0 1px 3px rgba(0,0,0,0.35)"
			}}
		>
			<AllHandles />
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: 8,
					padding: "10px 12px",
					borderBottom: "1px solid var(--sqlnest-border)",
					background: SYSTEM_HEADER
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
					title="Table SQLNest — lecture seule, jamais dans votre DB"
				>
					<IconLock size={10} stroke={2.5} />
					Système
				</span>
			</div>
			<div style={{ padding: "4px 0", minHeight: contentHeight - HEADER_H }}>
				{SCHEMA_EVENTS_COLLECTION.fields.map((f) => (
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
					textAlign: "left"
				}}
			>
				{expanded ? (
					<IconChevronDown size={12} stroke={2} />
				) : (
					<IconChevronRight size={12} stroke={2} />
				)}
				<span>
					{expanded
						? "Masquer les événements"
						: "Voir les événements récents"}
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
				maxHeight: 260,
				overflowY: "auto",
				padding: "6px 0"
			}}
		>
			{loading && (
				<p
					style={{
						margin: 0,
						padding: "8px 12px",
						fontSize: 11,
						color: "var(--sqlnest-text-tertiary)"
					}}
				>
					Chargement…
				</p>
			)}
			{error && (
				<p
					style={{
						margin: 0,
						padding: "8px 12px",
						fontSize: 11,
						color: "var(--sqlnest-danger)"
					}}
				>
					Échec du chargement.
				</p>
			)}
			{!loading && !error && rows.length === 0 && (
				<p
					style={{
						margin: 0,
						padding: "8px 12px",
						fontSize: 11,
						color: "var(--sqlnest-text-tertiary)"
					}}
				>
					Aucun événement — le CLI heartbeat n'a rien capté encore.
				</p>
			)}
			{rows.map((row) => (
				<EventRow key={row.id} row={row} />
			))}
			{hasMore && (
				<div style={{ padding: "6px 12px", textAlign: "center" }}>
					<ActionIcon
						variant="subtle"
						size="xs"
						loading={loadingMore}
						onClick={onLoadMore}
						aria-label="Charger plus d'événements"
					>
						<IconChevronDown size={12} />
					</ActionIcon>
				</div>
			)}
		</div>
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
