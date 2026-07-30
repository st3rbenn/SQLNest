import {
	EngineTabs,
	FloatingPanel,
	StatusPill,
	type StatusPillVariant
} from "@sqlnest/design-system";
import { Group, TextInput } from "@mantine/core";
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
	overflow: "hidden"
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

	// Status (pill) : couleur + libellé selon l'état.
	let status: { variant: StatusPillVariant; text: React.ReactNode };
	if (isLoading) {
		status = { variant: "info", text: "Introspection en cours…" };
	} else if (badSchema) {
		status = {
			variant: "danger",
			text: (
				<>
					Schéma <code>{schemaLabel}</code> refusé — identifiant simple attendu
				</>
			)
		};
	} else if (error) {
		status = { variant: "danger", text: "Base injoignable — exemple affiché" };
	} else if (liveButEmpty) {
		status = {
			variant: "warning",
			text:
				engine === "postgres" ? (
					<>
						Live — aucune table dans <code>{schemaLabel}</code>
					</>
				) : (
					"Live — base vide"
				)
		};
	} else {
		status = {
			variant: "success",
			text:
				engine === "postgres" ? (
					<>
						Live — schéma <code>{schemaLabel}</code>
					</>
				) : (
					"Live"
				)
		};
	}

	return (
		<div style={pageStyle}>
			{/* Panel flottant : moteur + schéma. Ancré après le drawer docké (300 px). */}
			<FloatingPanel position="top-left" offset={{ x: 316, y: 12 }} p="xs">
				<Group gap="xs" wrap="nowrap">
					<EngineTabs value={engine} onChange={setEngine} />
					{engine === "postgres" ? (
						<TextInput
							value={pgSchema}
							onChange={(e) => setPgSchema(e.currentTarget.value)}
							placeholder="public"
							size="xs"
							radius="sm"
							w={120}
							spellCheck={false}
							styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
						/>
					) : null}
				</Group>
			</FloatingPanel>

			{/* Bandeau statut : bottom-left, après le drawer. */}
			<FloatingPanel
				position="bottom-left"
				offset={{ x: 316, y: 12 }}
				p={0}
				withBorder={false}
				shadow="none"
			>
				<StatusPill status={status.variant} withDot={status.variant === "success"}>
					{status.text}
				</StatusPill>
			</FloatingPanel>

			<SchemaCanvas schema={schema} />
		</div>
	);
}
