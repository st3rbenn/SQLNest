import {
	FloatingPanel,
	StatusPill,
	type StatusPillVariant
} from "@sqlnest/design-system";
import { TextInput } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { type CSSProperties, useState } from "react";
import { SchemaCanvas } from "../features/schema/SchemaCanvas";
import { SAMPLE_POSTGRES } from "../features/schema/schema-model";
import { SchemaRequestError, useSchema } from "../features/schema/useSchema";

export const Route = createFileRoute("/")({
	component: SchemaPage
});

// Le toggle Postgres/MongoDB migrera vers la future page « Connexion »
// (setup + credentials + choix du driver). En attendant, on épingle
// `postgres` — le canvas Schéma vit sur une seule base à la fois.
const ENGINE = "postgres" as const;

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
	const [pgSchema, setPgSchema] = useState("");
	const targetSchema = pgSchema.trim() || undefined;
	const { data, error, isLoading } = useSchema(ENGINE, targetSchema);
	const schema = data ?? SAMPLE_POSTGRES;
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
			text: (
				<>
					Live — aucune table dans <code>{schemaLabel}</code>
				</>
			)
		};
	} else {
		status = {
			variant: "success",
			text: (
				<>
					Live — schéma <code>{schemaLabel}</code>
				</>
			)
		};
	}

	return (
		<div style={pageStyle}>
			{/* Panel flottant : champ schéma (Postgres uniquement pour l'instant).
			 * Le sélecteur de moteur migrera vers la page de connexion. */}
			<FloatingPanel position="top-left" offset={{ x: 316, y: 12 }} p="xs">
				<TextInput
					value={pgSchema}
					onChange={(e) => setPgSchema(e.currentTarget.value)}
					placeholder="public"
					size="xs"
					radius="sm"
					w={140}
					spellCheck={false}
					leftSection={
						<span style={{ fontSize: 10, color: "var(--mantine-color-slate-5)" }}>
							schéma
						</span>
					}
					leftSectionWidth={52}
					styles={{
						input: {
							fontFamily: "var(--mantine-font-family-monospace)",
							paddingLeft: 56
						}
					}}
				/>
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
