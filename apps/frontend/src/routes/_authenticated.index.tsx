import { createFileRoute } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { SchemaCanvas } from "../features/schema/SchemaCanvas";
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

const loadingStyle: CSSProperties = {
	position: "absolute",
	inset: 0,
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	fontSize: 12,
	color: "var(--sqlnest-text-tertiary)"
};

function SchemaPage() {
	// Le sélecteur de schéma Postgres (input "schéma public") a été retiré
	// de cette page — cette info remontera dans le breadcrumb en haut du
	// canvas (cf. memory `todo-canvas-breadcrumbs`). En attendant, on
	// interroge le schéma par défaut (`public`).
	const targetSchema: string | undefined = undefined;
	const { data, error } = useSchema(ENGINE, targetSchema);
	const schemaLabel = targetSchema ?? "public";

	// PAS de fallback SAMPLE_POSTGRES : rendre le sample puis basculer sur
	// la vraie data provoque un flick visible (les 4 tables demo sautent,
	// puis N tables apparaissent avec un layout tout autre). Tant que la
	// query n'a pas settle, on rend un écran vide sur bg canvas — la
	// signature localStorage `postgres:sortedNames` change AUSSI entre
	// sample et real data, donc hydrater le canvas sur le sample pollue
	// la persistance avec une signature parasite.
	return (
		<div style={pageStyle}>
			{data ? (
				<SchemaCanvas schema={data} schemaLabel={schemaLabel} />
			) : (
				<div style={loadingStyle}>
					{error ? "Base injoignable" : "Introspection…"}
				</div>
			)}
		</div>
	);
}
