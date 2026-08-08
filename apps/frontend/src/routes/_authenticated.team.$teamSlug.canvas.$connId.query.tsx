/**
 * Route `/team/:teamSlug/canvas/:connId/query` — éditeur SNQL scopé
 * team (C.21.5). Miroir de la route legacy `/canvas/:connId/query`.
 */

import { Button, ResultTable } from "@sqlnest/design-system";
import { IconArrowLeft } from "@tabler/icons-react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
	type CSSProperties,
	useEffect,
	useMemo,
	useRef,
	useState
} from "react";
import { useDbConnections } from "../features/db-connections/useDbConnections";
import { SnqlEditor } from "../features/query/SnqlEditor";
import { useRunQuery } from "../features/query/useRunQuery";
import { useSchema } from "../features/schema/useSchema";
import { useCurrentTeamSlug } from "../features/teams/useCurrentTeam";

interface QuerySearch {
	source?: string;
	autorun?: 1;
}

function validateSearch(raw: Record<string, unknown>): QuerySearch {
	const out: QuerySearch = {};
	if (typeof raw.source === "string" && raw.source.length > 0) {
		out.source = raw.source;
	}
	if (raw.autorun === 1 || raw.autorun === "1") out.autorun = 1;
	return out;
}

export const Route = createFileRoute(
	"/_authenticated/team/$teamSlug/canvas/$connId/query"
)({
	component: TeamQueryPage,
	validateSearch
});

const SNQL_PLACEHOLDER = "get <table> | pick <fields>";

const pageWrapperStyle: CSSProperties = {
	minHeight: "100vh",
	background: "var(--sqlnest-canvas-bg)",
	fontFamily: "ui-sans-serif, system-ui, sans-serif",
	color: "var(--sqlnest-text-primary)"
};

const pageStyle: CSSProperties = {
	padding: "32px 28px 64px",
	maxWidth: 980,
	margin: "0 auto"
};

const backLinkStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 6,
	fontSize: 12.5,
	color: "var(--sqlnest-text-secondary)",
	textDecoration: "none",
	marginBottom: 16
};

function TeamQueryPage() {
	const { connId, teamSlug } = Route.useParams();
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const [source, setSource] = useState(search.source ?? "");
	const contextSlug = useCurrentTeamSlug();
	const slug = contextSlug ?? teamSlug;
	const { data: connections } = useDbConnections(slug);
	const schemaQuery = useSchema(connId, slug);
	const run = useRunQuery();

	const dbName = connections?.find((c) => c.id === connId)?.name ?? connId;

	const execute = (): void => {
		run.mutate({ connectionId: connId, source, teamSlug: slug });
	};

	const didAutorun = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional
	useEffect(() => {
		if (search.source && search.source !== source) setSource(search.source);
		if (search.autorun === 1 && !didAutorun.current && search.source) {
			didAutorun.current = true;
			run.mutate({
				connectionId: connId,
				source: search.source,
				teamSlug: slug
			});
			void navigate({
				search: (prev) => {
					const next: QuerySearch = {};
					if (prev.source !== undefined) next.source = prev.source;
					return next;
				},
				replace: true
			});
		}
	}, [search.source, search.autorun]);

	const result = run.data;
	const columnNames = useMemo(
		() => result?.columns.map((c) => c.name) ?? [],
		[result?.columns]
	);

	return (
		<div style={pageWrapperStyle}>
			<div style={pageStyle}>
				<Link
					to="/team/$teamSlug/canvas/$connId"
					params={{ teamSlug, connId }}
					style={backLinkStyle}
				>
					<IconArrowLeft size={13} stroke={2} />
					Retour au canvas · {dbName}
				</Link>
				<h1
					style={{
						fontSize: 26,
						margin: "0 0 6px",
						color: "var(--sqlnest-text-primary)"
					}}
				>
					Requête SNQL
				</h1>
				<p
					style={{
						color: "var(--sqlnest-text-secondary)",
						margin: "0 0 20px",
						lineHeight: 1.5
					}}
				>
					Tape une requête SNQL, exécute-la contre la base et vois les lignes.
				</p>

				<SnqlEditor
					value={source}
					onChange={setSource}
					onRun={execute}
					schema={schemaQuery.data}
					placeholder={SNQL_PLACEHOLDER}
				/>

				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 14,
						margin: "12px 0 24px"
					}}
				>
					<Button
						onClick={execute}
						disabled={source.trim() === ""}
						loading={run.isPending}
						loadingLabel="Exécution…"
					>
						Exécuter
					</Button>
					<span style={{ fontSize: 12, color: "var(--sqlnest-text-tertiary)" }}>
						Ctrl/⌘ + Entrée pour exécuter · Ctrl + Espace pour compléter
					</span>
				</div>

				{run.error ? (
					<div
						style={{
							background: "var(--sqlnest-danger-soft)",
							color: "var(--sqlnest-danger)",
							padding: "12px 14px",
							borderRadius: 8,
							fontSize: 14,
							border: "1px solid var(--sqlnest-danger)",
							fontFamily: "var(--mantine-font-family-monospace)"
						}}
					>
						{run.error.message}
					</div>
				) : null}

				{result?.written && result.rows.length === 0 ? (
					<div style={{ fontSize: 13, color: "var(--sqlnest-text-secondary)" }}>
						<b>{result.rowCount}</b> ligne(s) affectée(s)
						<div
							style={{ color: "var(--sqlnest-text-tertiary)", marginTop: 6 }}
						>
							Ce moteur ne renvoie pas les documents modifiés.
						</div>
					</div>
				) : null}

				{result && !(result.written && result.rows.length === 0) ? (
					<div>
						<div
							style={{
								fontSize: 13,
								color: "var(--sqlnest-text-secondary)",
								margin: "0 0 10px"
							}}
						>
							<b>{result.rowCount}</b> ligne(s)
						</div>
						<ResultTable columns={columnNames} rows={result.rows} />
					</div>
				) : null}
			</div>
		</div>
	);
}
