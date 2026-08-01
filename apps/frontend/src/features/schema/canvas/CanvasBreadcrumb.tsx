import { UnstyledButton } from "@mantine/core";
import { IconChevronRight, IconDatabase, IconLeaf } from "@tabler/icons-react";
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
 * Breadcrumb du canvas — haut-centre, permanent. Style « moderne » façon
 * Linear/Vercel : texte plat, chevrons entre segments, dernier segment
 * accentué. Fond blanc légèrement translucide + blur backdrop pour rester
 * lisible au-dessus du contenu coloré du canvas sans faire pill imposante.
 *
 * Segments cliquables si un callback est fourni ; sinon rendus en texte
 * simple. Le SelectionChip et HiddenChip transitoires sont à `top: 60`
 * pour cohabiter.
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
	// Sur dark, l'accent Figma sert de couleur d'engine « live » — mint pour
	// MongoDB reste une couleur de code (mongo = green). Fallback aligné sur
	// la palette actuelle.
	const engineColor =
		engine === "mongodb"
			? "var(--sqlnest-success, #10b981)"
			: "var(--sqlnest-accent, #0d99ff)";

	// Le dernier segment reçoit l'accent visuel (fw:600, slate-9) — les
	// précédents sont estompés (fw:400, slate-6). Priorité au « où je suis ».
	const hasSchema = schemaLabel !== undefined;
	const lastIsCount = true; // count est toujours le dernier segment

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
				gap: 6,
				padding: "6px 10px",
				fontSize: 12.5
			}}
			aria-label="Contexte du canvas"
		>
			<Segment onClick={onEngineClick} accent={false}>
				<Icon
					size={14}
					stroke={2}
					style={{ color: engineColor, flexShrink: 0 }}
				/>
				<span>{engineLabel}</span>
			</Segment>
			{hasSchema ? (
				<>
					<Sep />
					<Segment onClick={onSchemaClick} accent={false}>
						<code style={codeStyle}>{schemaLabel}</code>
					</Segment>
				</>
			) : null}
			<Sep />
			<Segment accent={lastIsCount}>
				<span>
					{tableCount} table{tableCount > 1 ? "s" : ""}
				</span>
			</Segment>
		</div>
	);
}

const codeStyle: CSSProperties = {
	fontFamily: "var(--mantine-font-family-monospace)",
	fontSize: 11.5,
	color: "inherit",
	background: "transparent",
	padding: 0
};

function Segment({
	onClick,
	accent,
	children
}: {
	onClick?: () => void;
	accent: boolean;
	children: React.ReactNode;
}) {
	const style: CSSProperties = {
		display: "inline-flex",
		alignItems: "center",
		gap: 4,
		color: accent
			? "var(--sqlnest-text-primary)"
			: "var(--sqlnest-text-secondary)",
		fontWeight: accent ? 600 : 400
	};
	if (onClick === undefined) {
		return <span style={style}>{children}</span>;
	}
	return (
		<UnstyledButton onClick={onClick} style={{ ...style, cursor: "pointer" }}>
			{children}
		</UnstyledButton>
	);
}

function Sep() {
	return (
		<IconChevronRight
			size={12}
			stroke={2}
			style={{ color: "var(--sqlnest-text-tertiary)", flexShrink: 0 }}
			aria-hidden="true"
		/>
	);
}
