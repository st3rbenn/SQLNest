import { createFileRoute } from "@tanstack/react-router";
import { type CSSProperties, useState } from "react";
import { SchemaVisualizer } from "../features/schema/SchemaVisualizer";
import {
	SAMPLE_MONGODB,
	SAMPLE_POSTGRES
} from "../features/schema/schema-model";
import { SchemaRequestError, useSchema } from "../features/schema/useSchema";

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

const schemaInputStyle: CSSProperties = {
	padding: "7px 10px",
	borderRadius: 8,
	border: "1px solid #e2e8f0",
	fontSize: 13,
	fontFamily: "ui-monospace, SFMono-Regular, monospace",
	color: "#0f172a",
	width: 130
};

function SchemaPage() {
	const [engine, setEngine] = useState<Engine>("postgres");
	const [pgSchema, setPgSchema] = useState("");
	// Le schéma cible ne concerne que Postgres ; Mongo l'ignore.
	const targetSchema =
		engine === "postgres" ? pgSchema.trim() || undefined : undefined;
	const { data, error, isLoading } = useSchema(engine, targetSchema);
	const fallback = engine === "postgres" ? SAMPLE_POSTGRES : SAMPLE_MONGODB;
	const schema = data ?? fallback;
	// Un 4xx = nom de schéma mal formé (entrée à corriger), pas une panne de base.
	const badSchema =
		error instanceof SchemaRequestError &&
		error.status >= 400 &&
		error.status < 500;
	const schemaLabel = targetSchema ?? "public";
	// Base atteinte mais schéma sans table : à signaler distinctement du vert « Live »
	// (sinon une faute de frappe ressemble à un schéma légitimement vide).
	const liveButEmpty = data !== undefined && data.collections.length === 0;

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

			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 8,
					marginBottom: 24
				}}
			>
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

			{isLoading ? (
				<div
					style={{ ...bannerStyle, background: "#eff6ff", color: "#1d4ed8" }}
				>
					Introspection en cours…
				</div>
			) : badSchema ? (
				<div
					style={{ ...bannerStyle, background: "#fef2f2", color: "#b91c1c" }}
				>
					Schéma <code>{schemaLabel}</code> refusé — nom invalide (identifiant
					simple attendu). Exemple affiché.
				</div>
			) : error ? (
				<div
					style={{ ...bannerStyle, background: "#fef2f2", color: "#b91c1c" }}
				>
					Base injoignable — exemple affiché. Lancez <code>pnpm db:up</code> et
					le backend.
				</div>
			) : liveButEmpty ? (
				<div
					style={{ ...bannerStyle, background: "#fffbeb", color: "#b45309" }}
				>
					{engine === "postgres" ? (
						<>
							● Live — aucune table dans le schéma <code>{schemaLabel}</code>{" "}
							(nom exact ?).
						</>
					) : (
						"● Live — base vide (aucune collection)."
					)}
				</div>
			) : (
				<div
					style={{ ...bannerStyle, background: "#ecfdf5", color: "#047857" }}
				>
					{engine === "postgres" ? (
						<>
							● Live — schéma <code>{schemaLabel}</code> introspecté depuis la
							base
						</>
					) : (
						"● Live — schéma introspecté depuis la base"
					)}
				</div>
			)}

			<div style={{ overflowX: "auto" }}>
				<SchemaVisualizer schema={schema} />
			</div>
		</div>
	);
}
