import { createFileRoute } from "@tanstack/react-router";
import { type CSSProperties, useState } from "react";
import { SchemaVisualizer } from "../features/schema/SchemaVisualizer";
import {
	SAMPLE_MONGODB,
	SAMPLE_POSTGRES
} from "../features/schema/schema-model";
import { useSchema } from "../features/schema/useSchema";

export const Route = createFileRoute("/")({
	component: SchemaPage
});

type Engine = "postgres" | "mongodb";

const bannerStyle: CSSProperties = {
	display: "inline-block",
	fontSize: 13,
	padding: "6px 12px",
	borderRadius: 8,
	marginBottom: 16
};

const pageStyle: CSSProperties = {
	padding: "32px 28px 64px",
	fontFamily: "ui-sans-serif, system-ui, sans-serif",
	color: "#0f172a"
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

function SchemaPage() {
	const [engine, setEngine] = useState<Engine>("postgres");
	const { data, error, isLoading } = useSchema(engine);
	const fallback = engine === "postgres" ? SAMPLE_POSTGRES : SAMPLE_MONGODB;
	const schema = data ?? fallback;

	return (
		<div style={pageStyle}>
			<h1 style={{ fontSize: 26, margin: "0 0 6px" }}>
				Schéma — visualizer ER
			</h1>
			<p
				style={{
					color: "#475569",
					maxWidth: 720,
					margin: "0 0 20px",
					lineHeight: 1.5
				}}
			>
				Le <b>SchemaModel</b> unifié, rendu en diagramme entités-relations. Le
				même schéma logique, introspecté par chaque moteur : Postgres le{" "}
				<b>déclare</b> (catalogue + clés étrangères) ; MongoDB l'<b>infère</b>{" "}
				(échantillonnage + heuristique de nommage, d'où les confidences et le
				trait pointillé).
			</p>

			<div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
				<button
					type="button"
					style={tabStyle(engine === "postgres")}
					onClick={() => setEngine("postgres")}
				>
					PostgreSQL
				</button>
				<button
					type="button"
					style={tabStyle(engine === "mongodb")}
					onClick={() => setEngine("mongodb")}
				>
					MongoDB
				</button>
			</div>

			{isLoading ? (
				<div
					style={{ ...bannerStyle, background: "#eff6ff", color: "#1d4ed8" }}
				>
					Introspection en cours…
				</div>
			) : error ? (
				<div
					style={{ ...bannerStyle, background: "#fef2f2", color: "#b91c1c" }}
				>
					Base injoignable — exemple affiché. Lancez <code>pnpm db:up</code> et
					le backend.
				</div>
			) : (
				<div
					style={{ ...bannerStyle, background: "#ecfdf5", color: "#047857" }}
				>
					● Live — schéma introspecté depuis la base
				</div>
			)}

			<div style={{ overflowX: "auto" }}>
				<SchemaVisualizer schema={schema} />
			</div>
		</div>
	);
}
