import { ResultTable } from "@sqlnest/design-system";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { SnqlEditor } from "../features/query/SnqlEditor";
import { useRunQuery } from "../features/query/useRunQuery";
import { useSchema } from "../features/schema/useSchema";

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

export const Route = createFileRoute("/query")({
	component: QueryPage,
	validateSearch
});

type Engine = "postgres" | "mongodb";

const EXAMPLES: Record<Engine, string> = {
	postgres: "get users | where is_active = true | pick email, display_name",
	mongodb: 'get orders | where status = "paid" | pick user_id, total_cents'
};

const pageStyle: CSSProperties = {
	padding: "32px 28px 64px",
	fontFamily: "ui-sans-serif, system-ui, sans-serif",
	color: "#0f172a",
	maxWidth: 980
};

function tabStyle(active: boolean): CSSProperties {
	return {
		padding: "8px 16px",
		borderRadius: 8,
		border: `1px solid ${active ? "#2563eb" : "#e2e8f0"}`,
		background: active ? "#2563eb" : "#fff",
		color: active ? "#fff" : "#475569",
		fontWeight: 600,
		fontSize: 14,
		cursor: "pointer"
	};
}

function QueryPage() {
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const [engine, setEngine] = useState<Engine>("postgres");
	const [source, setSource] = useState(search.source ?? EXAMPLES.postgres);
	const [pgSchema, setPgSchema] = useState("");
	// Le schéma cible ne concerne que Postgres ; vide → défaut `public`.
	const targetSchema =
		engine === "postgres" ? pgSchema.trim() || undefined : undefined;
	// Introspection du moteur/schéma courant → candidats de complétion de l'éditeur.
	const schemaQuery = useSchema(engine, targetSchema);
	const run = useRunQuery();

	const execute = () => {
		run.mutate({
			engine,
			source,
			...(targetSchema ? { schema: targetSchema } : {})
		});
	};

	// Injection depuis un lien externe (menu contextuel du canvas Schéma).
	// `source` → charge dans l'éditeur ; `autorun=1` → exécute **une seule fois**.
	// On efface `autorun` de l'URL après tir pour éviter la re-exécution au refresh.
	const didAutorun = useRef(false);
	useEffect(() => {
		if (search.source && search.source !== source) setSource(search.source);
		if (search.autorun === 1 && !didAutorun.current && search.source) {
			didAutorun.current = true;
			run.mutate({
				engine,
				source: search.source,
				...(targetSchema ? { schema: targetSchema } : {})
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
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional — only react to URL changes and mount, not local state
	}, [search.source, search.autorun]);

	const selectEngine = (next: Engine) => {
		setEngine(next);
		// Bascule l'exemple si l'utilisateur n'a pas encore édité.
		if (source === EXAMPLES.postgres || source === EXAMPLES.mongodb) {
			setSource(EXAMPLES[next]);
		}
	};

	const result = run.data;
	const columnNames = useMemo(
		() => result?.columns.map((c) => c.name) ?? [],
		[result?.columns]
	);

	// Défini dans le composant : le code-splitting de route (autoCodeSplitting)
	// n'embarque pas un const module référencé uniquement dans un JSX conditionnel.
	const schemaInputStyle: CSSProperties = {
		padding: "7px 10px",
		borderRadius: 8,
		border: "1px solid #e2e8f0",
		fontSize: 13,
		fontFamily: "ui-monospace, SFMono-Regular, monospace",
		color: "#0f172a",
		width: 130
	};

	return (
		<div style={pageStyle}>
			<h1 style={{ fontSize: 26, margin: "0 0 6px" }}>Requête SNQL</h1>
			<p style={{ color: "#475569", margin: "0 0 20px", lineHeight: 1.5 }}>
				Un langage, deux moteurs. Tape une requête SNQL, exécute-la contre la
				vraie base (Postgres ou MongoDB) et vois les lignes.
			</p>

			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 8,
					marginBottom: 12
				}}
			>
				<button
					type="button"
					style={tabStyle(engine === "postgres")}
					onClick={() => selectEngine("postgres")}
				>
					PostgreSQL
				</button>
				<button
					type="button"
					style={tabStyle(engine === "mongodb")}
					onClick={() => selectEngine("mongodb")}
				>
					MongoDB
				</button>
				{engine === "postgres" ? (
					<label
						style={{
							display: "flex",
							alignItems: "center",
							gap: 6,
							marginLeft: 8,
							fontSize: 13,
							color: "#64748b"
						}}
					>
						schéma
						<input
							value={pgSchema}
							onChange={(e) => setPgSchema(e.target.value)}
							placeholder="public"
							spellCheck={false}
							style={schemaInputStyle}
						/>
					</label>
				) : null}
			</div>

			<SnqlEditor
				value={source}
				onChange={setSource}
				onRun={execute}
				schema={schemaQuery.data}
				placeholder="get users | where is_active = true | pick email"
			/>

			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 14,
					margin: "12px 0 24px"
				}}
			>
				<button
					type="button"
					onClick={execute}
					disabled={run.isPending || source.trim() === ""}
					style={{
						padding: "9px 20px",
						borderRadius: 8,
						border: "none",
						background: run.isPending ? "#93c5fd" : "#2563eb",
						color: "#fff",
						fontWeight: 650,
						fontSize: 14,
						cursor: run.isPending ? "default" : "pointer"
					}}
				>
					{run.isPending ? "Exécution…" : "Exécuter"}
				</button>
				<span style={{ fontSize: 12, color: "#94a3b8" }}>
					Ctrl/⌘ + Entrée pour exécuter · Ctrl + Espace pour compléter
				</span>
			</div>

			{run.error ? (
				<div
					style={{
						background: "#fef2f2",
						color: "#b91c1c",
						padding: "12px 14px",
						borderRadius: 8,
						fontSize: 14,
						fontFamily: "ui-monospace, monospace"
					}}
				>
					{run.error.message}
				</div>
			) : null}

			{result?.written && result.rows.length === 0 ? (
				// Écriture dont le moteur ne renvoie pas les lignes (update/delete
				// MongoDB : pas d'équivalent RETURNING multi-documents). Un tableau
				// vide passerait pour un bug — on annonce le nombre de lignes touchées.
				// Discriminant = `written` (pas la forme du résultat) : une LECTURE à
				// 0 ligne doit rester une table vide, pas « lignes affectées ».
				<div style={{ fontSize: 13, color: "#475569" }}>
					<b>{result.rowCount}</b> ligne(s) affectée(s) · moteur <b>{engine}</b>
					<div style={{ color: "#94a3b8", marginTop: 6 }}>
						Ce moteur ne renvoie pas les documents modifiés.
					</div>
				</div>
			) : null}

			{result && !(result.written && result.rows.length === 0) ? (
				<div>
					<div style={{ fontSize: 13, color: "#475569", margin: "0 0 10px" }}>
						<b>{result.rowCount}</b> ligne(s) · moteur <b>{engine}</b>
					</div>
					<ResultTable columns={columnNames} rows={result.rows} />
				</div>
			) : null}
		</div>
	);
}
