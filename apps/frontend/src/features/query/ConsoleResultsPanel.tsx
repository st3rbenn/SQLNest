/**
 * Panel des résultats sous l'éditeur SNQL :
 *  - Status bar : StatusPill (success/error/idle) + row count + timing +
 *    bouton Exporter (V2).
 *  - Toolbar : SearchInput (filter local) + 3 ToolbarButton (Table |
 *    Graph | JSON) — mode persisté en localStorage.
 *  - Content : dispatch selon `viewMode` vers ResultsTable / JsonView /
 *    GraphPlaceholder.
 *  - Footer pagination : lignes par page (persisté) + navigation
 *    < page N/T >.
 *
 * Le filter local applique un match `includes()` sur `JSON.stringify(row)` —
 * suffisant en V1 pour la plupart des cas. Filter par colonne = V2.
 */

import { SearchInput, ToolbarButton } from "@sqlnest/design-system";
import { useLocalStorage } from "@mantine/hooks";
import {
	IconChartBar,
	IconChevronLeft,
	IconChevronRight,
	IconCode,
	IconTable
} from "@tabler/icons-react";
import type { CSSProperties } from "react";
import { useMemo, useState } from "react";
import { ErrorBlock } from "./ErrorBlock";
import { ResultsGraphPlaceholder } from "./ResultsGraphPlaceholder";
import { ResultsJsonView } from "./ResultsJsonView";
import { ResultsTable } from "./ResultsTable";
import type { QueryResult, SerializedSpan } from "./useRunQuery";

export type ResultsViewMode = "table" | "json" | "graph";

const VIEW_STORAGE_KEY = "sqlnest.console.results.view";
const PAGE_SIZE_STORAGE_KEY = "sqlnest.console.results.pageSize";
const PAGE_SIZE_OPTIONS = [25, 50, 100, 250, 500] as const;

const containerStyle: CSSProperties = {
	flex: 1,
	minHeight: 0,
	display: "flex",
	flexDirection: "column",
	gap: 10,
	padding: "14px 16px 14px",
	background: "var(--sqlnest-surface)",
	borderTop: "1px solid var(--sqlnest-border)"
};

const statusRowStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 10,
	color: "var(--sqlnest-text-secondary)",
	fontSize: 12,
	minHeight: 24
};

const statusDotStyle = (color: string): CSSProperties => ({
	display: "inline-flex",
	alignItems: "center",
	gap: 6,
	fontWeight: 500,
	color
});

const statusDotBadge = (color: string): CSSProperties => ({
	width: 6,
	height: 6,
	borderRadius: "50%",
	background: color
});

const toolbarRowStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 8
};

const toolbarSearchStyle: CSSProperties = {
	flex: 1,
	maxWidth: 320
};

const viewGroupStyle: CSSProperties = {
	display: "inline-flex",
	gap: 2,
	padding: 2,
	background: "var(--sqlnest-surface-hover)",
	border: "1px solid var(--sqlnest-border-subtle)",
	borderRadius: 6
};

const paginationRowStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	gap: 12,
	color: "var(--sqlnest-text-secondary)",
	fontSize: 11,
	paddingTop: 4
};

const paginationLeftStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 10
};

const paginationRightStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 6
};

const selectStyle: CSSProperties = {
	background: "var(--sqlnest-surface)",
	color: "var(--sqlnest-text-primary)",
	border: "1px solid var(--sqlnest-border)",
	borderRadius: 4,
	fontSize: 11,
	padding: "2px 6px",
	cursor: "pointer"
};

export function ConsoleResultsPanel({
	result,
	error,
	isPending,
	timingMs,
	onFocusSpan
}: {
	readonly result: QueryResult | undefined;
	readonly error: Error | null;
	readonly isPending: boolean;
	readonly timingMs: number | undefined;
	/** Câble optionnel vers l'éditeur (Phase 3a — jump-to-span depuis ErrorBlock). */
	readonly onFocusSpan?: (span: SerializedSpan) => void;
}): React.ReactNode {
	const [viewMode, setViewMode] = useLocalStorage<ResultsViewMode>({
		key: VIEW_STORAGE_KEY,
		defaultValue: "table",
		getInitialValueInEffect: false
	});
	const [pageSize, setPageSize] = useLocalStorage<number>({
		key: PAGE_SIZE_STORAGE_KEY,
		defaultValue: 50,
		getInitialValueInEffect: false
	});

	const [filter, setFilter] = useState("");
	const [page, setPage] = useState(1);

	const rows = result?.rows ?? [];
	const columns = result?.columns ?? [];

	// Filter local : match `includes` sur le stringify. Ré-évalué à chaque
	// changement de rows/filter — mémoïsé pour éviter le recompute sur
	// changement de page ou de view mode.
	const filteredRows = useMemo(() => {
		if (filter.trim() === "") return rows;
		const needle = filter.toLowerCase();
		return rows.filter((r) => JSON.stringify(r).toLowerCase().includes(needle));
	}, [rows, filter]);

	const totalRows = filteredRows.length;
	const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
	const clampedPage = Math.min(page, totalPages);
	const start = (clampedPage - 1) * pageSize;
	const end = Math.min(start + pageSize, totalRows);
	const pagedRows = useMemo(
		() => filteredRows.slice(start, end),
		[filteredRows, start, end]
	);

	const statusColor = error
		? "var(--sqlnest-danger)"
		: isPending
			? "var(--sqlnest-warning)"
			: result
				? "var(--sqlnest-success)"
				: "var(--sqlnest-text-tertiary)";
	const statusLabel = error
		? "Erreur"
		: isPending
			? "Exécution…"
			: result
				? result.written
					? "Écriture OK"
					: "Succès"
				: "Prêt";

	return (
		<div style={containerStyle}>
			<div style={statusRowStyle}>
				<span style={statusDotStyle(statusColor)}>
					<span style={statusDotBadge(statusColor)} />
					{statusLabel}
				</span>
				{result ? (
					<>
						<span>·</span>
						<span>
							{totalRows} ligne{totalRows > 1 ? "s" : ""}
							{filter && rows.length !== totalRows
								? ` (sur ${rows.length} filtrées)`
								: ""}
						</span>
					</>
				) : null}
				{timingMs !== undefined ? (
					<>
						<span>·</span>
						<span>{formatTiming(timingMs)}</span>
					</>
				) : null}
			</div>

			{/* Bloc erreur riche (Phase 3a) : chips $N cliquables résolus via
			    `pgError.paramSpans`, col/table cliquables via `identSpans`, jump
			    vers le span source SNQL dans l'éditeur (`onFocusSpan`). Quand une
			    erreur est présente on masque toolbar+results en dessous (pas de
			    faux « 0 lignes » sur écran d'erreur). */}
			{error ? <ErrorBlock error={error} onFocusSpan={onFocusSpan} /> : null}

			{error ? null : (
				<>
					<div style={toolbarRowStyle}>
				<div style={toolbarSearchStyle}>
					<SearchInput
						value={filter}
						onChange={(e) => {
							setFilter(e.currentTarget.value);
							setPage(1);
						}}
						placeholder="Filtrer les résultats…"
						size="xs"
					/>
				</div>
				<div style={{ flex: 1 }} />
				<div style={viewGroupStyle}>
					<ToolbarButton
						label="Vue tableau"
						active={viewMode === "table"}
						size={26}
						onClick={() => setViewMode("table")}
					>
						<IconTable size={13} stroke={2} />
					</ToolbarButton>
					<ToolbarButton
						label="Vue graphique"
						active={viewMode === "graph"}
						size={26}
						onClick={() => setViewMode("graph")}
					>
						<IconChartBar size={13} stroke={2} />
					</ToolbarButton>
					<ToolbarButton
						label="Vue JSON"
						active={viewMode === "json"}
						size={26}
						onClick={() => setViewMode("json")}
					>
						<IconCode size={13} stroke={2} />
					</ToolbarButton>
				</div>
			</div>

			{viewMode === "table" ? (
				<ResultsTable columns={columns} rows={pagedRows} />
			) : viewMode === "json" ? (
				<ResultsJsonView rows={pagedRows} />
			) : (
				<ResultsGraphPlaceholder />
			)}

			{result && viewMode !== "graph" ? (
				<div style={paginationRowStyle}>
					<div style={paginationLeftStyle}>
						{totalRows > 0 ? (
							<span>
								{start + 1}–{end} sur {totalRows}
							</span>
						) : (
							<span>0 sur 0</span>
						)}
						<span>·</span>
						<label style={{ display: "inline-flex", gap: 6 }}>
							Lignes par page
							<select
								style={selectStyle}
								value={pageSize}
								onChange={(e) => {
									setPageSize(Number.parseInt(e.target.value, 10));
									setPage(1);
								}}
							>
								{PAGE_SIZE_OPTIONS.map((n) => (
									<option key={n} value={n}>
										{n}
									</option>
								))}
							</select>
						</label>
					</div>
					<div style={paginationRightStyle}>
						<ToolbarButton
							label="Page précédente"
							active={false}
							size={22}
							disabled={clampedPage <= 1}
							onClick={() => setPage((p) => Math.max(1, p - 1))}
						>
							<IconChevronLeft size={12} stroke={2} />
						</ToolbarButton>
						<span style={{ minWidth: 60, textAlign: "center" }}>
							{clampedPage} / {totalPages}
						</span>
						<ToolbarButton
							label="Page suivante"
							active={false}
							size={22}
							disabled={clampedPage >= totalPages}
							onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
						>
							<IconChevronRight size={12} stroke={2} />
						</ToolbarButton>
					</div>
				</div>
			) : null}
				</>
			)}
		</div>
	);
}

function formatTiming(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)} ms`;
	return `${(ms / 1000).toFixed(2)} s`;
}
