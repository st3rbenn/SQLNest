import { UnstyledButton } from "@mantine/core";
import { IconDatabase, IconLeaf } from "@tabler/icons-react";
import type { CSSProperties } from "react";

export type CanvasBreadcrumbProps = {
	engine: "postgres" | "mongodb";
	/** Nom du schéma cible (Postgres) — pour Mongo, laisser vide. */
	schemaLabel?: string;
	tableCount: number;
	/** Placeholder pour un futur switch d'engine (page Connexion). */
	onEngineClick?: () => void;
	/** Placeholder pour un futur changement de schéma cible (input inline). */
	onSchemaClick?: () => void;
};

/**
 * Breadcrumb du canvas — haut-centre, permanent. Affiche `[icon] Postgres ·
 * public · N tables`. Les segments sont cliquables si un callback est fourni ;
 * sinon rendus en texte simple (v1 = affichage informatif, l'interactivité
 * vient dans les prochains tours — voir [[UX Canvas — Backlog]]).
 *
 * Positionné en `top: 12` — le `SelectionChip` (et le `HiddenChip` transitoire)
 * sont décalés à `top: 60` pour cohabiter sans chevauchement.
 */
export function CanvasBreadcrumb({
	engine,
	schemaLabel,
	tableCount,
	onEngineClick,
	onSchemaClick
}: CanvasBreadcrumbProps) {
	const Icon = engine === "mongodb" ? IconLeaf : IconDatabase;
	const engineLabel = engine === "mongodb" ? "MongoDB" : "Postgres";
	const engineColor =
		engine === "mongodb"
			? "var(--mantine-color-mint-6, #10b981)"
			: "var(--mantine-color-brand-6, #2563eb)";

	return (
		<div
			style={{
				position: "absolute",
				top: 12,
				left: "50%",
				transform: "translateX(-50%)",
				zIndex: 5,
				display: "inline-flex",
				alignItems: "center",
				gap: 8,
				padding: "6px 12px",
				borderRadius: 999,
				background: "#fff",
				border: "1px solid var(--mantine-color-slate-2)",
				boxShadow: "var(--mantine-shadow-md)",
				fontSize: 12,
				color: "var(--mantine-color-slate-7)"
			}}
			aria-label="Contexte du canvas"
		>
			<Segment onClick={onEngineClick}>
				<Icon size={14} stroke={2} style={{ color: engineColor }} />
				<span style={{ fontWeight: 600 }}>{engineLabel}</span>
			</Segment>
			{schemaLabel !== undefined ? (
				<>
					<Sep />
					<Segment onClick={onSchemaClick}>
						<code style={codeStyle}>{schemaLabel}</code>
					</Segment>
				</>
			) : null}
			<Sep />
			<span style={{ color: "var(--mantine-color-slate-5)" }}>
				{tableCount} table{tableCount > 1 ? "s" : ""}
			</span>
		</div>
	);
}

const codeStyle: CSSProperties = {
	fontFamily: "var(--mantine-font-family-monospace)",
	fontSize: 11.5,
	color: "var(--mantine-color-slate-8)",
	background: "var(--mantine-color-slate-0)",
	padding: "1px 6px",
	borderRadius: 4
};

const segmentBaseStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 4,
	color: "inherit"
};

function Segment({
	onClick,
	children
}: {
	onClick?: () => void;
	children: React.ReactNode;
}) {
	if (onClick === undefined) {
		return <span style={segmentBaseStyle}>{children}</span>;
	}
	return (
		<UnstyledButton onClick={onClick} style={segmentBaseStyle}>
			{children}
		</UnstyledButton>
	);
}

function Sep() {
	return (
		<span style={{ color: "var(--mantine-color-slate-3)" }} aria-hidden="true">
			·
		</span>
	);
}
