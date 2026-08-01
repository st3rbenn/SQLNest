import { createFileRoute } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { SchemaCanvas } from "../features/schema/SchemaCanvas";
import { SAMPLE_POSTGRES } from "../features/schema/schema-model";
import { useSchema } from "../features/schema/useSchema";

export const Route = createFileRoute("/_authenticated/")({
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
	const { data } = useSchema(ENGINE, targetSchema);
	const schema = data ?? SAMPLE_POSTGRES;
	const schemaLabel = targetSchema ?? "public";

	return (
		<div style={pageStyle}>
			<SchemaCanvas schema={schema} schemaLabel={schemaLabel} />
		</div>
	);
}
