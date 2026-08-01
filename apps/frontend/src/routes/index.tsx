import {
	FloatingPanel,
	StatusPill,
	type StatusPillVariant
} from "@sqlnest/design-system";
import { createFileRoute } from "@tanstack/react-router";
import type { CSSProperties } from "react";
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

// Canvas plein écran : viewport complet (plus de top nav depuis App.tsx).
// Les contrôles sont des panels FLOTTANTS par-dessus — le visualizer EST
// la page, à la Figma. Bg via token — pilote la couleur du canvas RF, la
// grille de points est peinte par `Background` de RF au-dessus.
const pageStyle: CSSProperties = {
	position: "relative",
	height: "100vh",
	background: "var(--sqlnest-canvas-bg)",
	overflow: "hidden"
};

function SchemaPage() {
	// Le sélecteur de schéma Postgres (input "schéma public") a été retiré
	// de cette page — cette info remontera dans le breadcrumb en haut du
	// canvas (cf. memory `todo-canvas-breadcrumbs`). En attendant, on
	// interroge le schéma par défaut (`public`).
	const targetSchema: string | undefined = undefined;
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

			<SchemaCanvas schema={schema} schemaLabel={schemaLabel} />
		</div>
	);
}
