import { createFileRoute } from "@tanstack/react-router";
import { type CSSProperties, useState } from "react";
import { SnqlEditor } from "../features/query/SnqlEditor";
import { useRunQuery } from "../features/query/useRunQuery";
import { useSchema } from "../features/schema/useSchema";

export const Route = createFileRoute("/query")({
	component: QueryPage
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

function renderCell(value: unknown) {
	if (value === null || value === undefined) {
		return <span style={{ color: "#cbd5e1" }}>NULL</span>;
	}
	if (typeof value === "object") {
		return <code style={{ fontSize: 12 }}>{JSON.stringify(value)}</code>;
	}
	return String(value);
}

function QueryPage() {
	const [engine, setEngine] = useState<Engine>("postgres");
	const [source, setSource] = useState(EXAMPLES.postgres);
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

	const selectEngine = (next: Engine) => {
		setEngine(next);
		// Bascule l'exemple si l'utilisateur n'a pas encore édité.
		if (source === EXAMPLES.postgres || source === EXAMPLES.mongodb) {
			setSource(EXAMPLES[next]);
		}
	};

	const result = run.data;

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

			{result ? (
				<div>
					<div style={{ fontSize: 13, color: "#475569", margin: "0 0 10px" }}>
						<b>{result.rowCount}</b> ligne(s) · moteur <b>{engine}</b>
					</div>
					<div
						style={{
							overflowX: "auto",
							border: "1px solid #e2e8f0",
							borderRadius: 10
						}}
					>
						<table
							style={{
								borderCollapse: "collapse",
								width: "100%",
								fontSize: 13
							}}
						>
							<thead>
								<tr>
									{result.columns.map((col) => (
										<th
											key={col.name}
											style={{
												textAlign: "left",
												padding: "10px 14px",
												background: "#f8fafc",
												borderBottom: "1px solid #e2e8f0",
												fontWeight: 650,
												color: "#334155",
												whiteSpace: "nowrap"
											}}
										>
											{col.name}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{result.rows.map((row, i) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id
									<tr key={i}>
										{result.columns.map((col) => (
											<td
												key={col.name}
												style={{
													padding: "9px 14px",
													borderTop: "1px solid #f1f5f9",
													color: "#1e293b",
													whiteSpace: "nowrap"
												}}
											>
												{renderCell(row[col.name])}
											</td>
										))}
									</tr>
								))}
							</tbody>
						</table>
					</div>
					{result.rowCount === 0 ? (
						<p style={{ color: "#94a3b8", fontSize: 13, marginTop: 12 }}>
							Aucune ligne.
						</p>
					) : null}
				</div>
			) : null}
		</div>
	);
}
