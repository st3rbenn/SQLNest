import { createFileRoute } from "@tanstack/react-router";
import { type CSSProperties, useState } from "react";
import { SchemaCanvas } from "../features/schema/SchemaCanvas";
import {
	SAMPLE_MONGODB,
	SAMPLE_POSTGRES
} from "../features/schema/schema-model";
import { SchemaRequestError, useSchema } from "../features/schema/useSchema";

export const Route = createFileRoute("/")({
	component: SchemaPage
});

type Engine = "postgres" | "mongodb";

// Canvas plein écran : viewport moins la nav (~50 px). Les contrôles sont des
// panels FLOTTANTS par-dessus le canvas — le visualizer n'est plus une carte
// dans une page, c'est la page.
const pageStyle: CSSProperties = {
	position: "relative",
	height: "calc(100vh - 50px)",
	background: "#fafbfc",
	overflow: "hidden",
	fontFamily: "ui-sans-serif, system-ui, sans-serif"
};

const controlsPanel: CSSProperties = {
	position: "absolute",
	top: 12,
	left: 12,
	zIndex: 5,
	display: "flex",
	alignItems: "center",
	gap: 8,
	padding: "8px 10px",
	background: "#fff",
	border: "1px solid #e2e8f0",
	borderRadius: 12,
	boxShadow: "0 4px 16px rgba(15,23,42,0.10)"
};

const statusPanel: CSSProperties = {
	position: "absolute",
	bottom: 12,
	left: 12,
	zIndex: 5,
	fontSize: 12,
	padding: "6px 12px",
	borderRadius: 8,
	background: "#fff",
	border: "1px solid #e2e8f0",
	boxShadow: "0 4px 16px rgba(15,23,42,0.08)"
};

function tabStyle(active: boolean): CSSProperties {
	return {
		padding: "6px 12px",
		borderRadius: 8,
		border: `1px solid ${active ? "#2563eb" : "#e2e8f0"}`,
		background: active ? "#2563eb" : "#fff",
		color: active ? "#fff" : "#475569",
		fontWeight: 600,
		fontSize: 12,
		cursor: "pointer"
	};
}

const schemaInputStyle: CSSProperties = {
	padding: "5px 8px",
	borderRadius: 6,
	border: "1px solid #e2e8f0",
	fontSize: 12,
	fontFamily: "ui-monospace, SFMono-Regular, monospace",
	color: "#0f172a",
	width: 120,
	outline: "none"
};

function SchemaPage() {
	const [engine, setEngine] = useState<Engine>("postgres");
	const [pgSchema, setPgSchema] = useState("");
	const targetSchema =
		engine === "postgres" ? pgSchema.trim() || undefined : undefined;
	const { data, error, isLoading } = useSchema(engine, targetSchema);
	const fallback = engine === "postgres" ? SAMPLE_POSTGRES : SAMPLE_MONGODB;
	const schema = data ?? fallback;
	const badSchema =
		error instanceof SchemaRequestError &&
		error.status >= 400 &&
		error.status < 500;
	const schemaLabel = targetSchema ?? "public";
	const liveButEmpty = data !== undefined && data.collections.length === 0;

	// Status (bandeau) : couleur + libellé selon l'état.
	let status: { bg: string; color: string; text: React.ReactNode };
	if (isLoading) {
		status = {
			bg: "#eff6ff",
			color: "#1d4ed8",
			text: "Introspection en cours…"
		};
	} else if (badSchema) {
		status = {
			bg: "#fef2f2",
			color: "#b91c1c",
			text: (
				<>
					Schéma <code>{schemaLabel}</code> refusé — identifiant simple attendu
				</>
			)
		};
	} else if (error) {
		status = {
			bg: "#fef2f2",
			color: "#b91c1c",
			text: "Base injoignable — exemple affiché"
		};
	} else if (liveButEmpty) {
		status = {
			bg: "#fffbeb",
			color: "#b45309",
			text:
				engine === "postgres" ? (
					<>
						● Live — aucune table dans <code>{schemaLabel}</code>
					</>
				) : (
					"● Live — base vide"
				)
		};
	} else {
		status = {
			bg: "#ecfdf5",
			color: "#047857",
			text:
				engine === "postgres" ? (
					<>
						● Live — schéma <code>{schemaLabel}</code>
					</>
				) : (
					"● Live"
				)
		};
	}

	return (
		<div style={pageStyle}>
			{/* Panel flottant : moteur + schéma. En haut-gauche, discret. */}
			<div style={controlsPanel}>
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
							gap: 5,
							marginLeft: 4,
							fontSize: 11,
							color: "#94a3b8"
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

			{/* Bandeau statut, en bas-gauche, non-intrusif. */}
			<div
				style={{ ...statusPanel, background: status.bg, color: status.color }}
			>
				{status.text}
			</div>

			<SchemaCanvas schema={schema} />
		</div>
	);
}
