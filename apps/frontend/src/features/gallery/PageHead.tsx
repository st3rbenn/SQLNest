import { IconArtboard } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";

/**
 * Header d'une page main — même height que le bloc user de la sidebar
 * (~45px). Alignement horizontal top garanti : la baseline visuelle du
 * titre matche celle du nom user à sa gauche. `actions` (optionnel) est
 * un slot à droite pour un CTA (ex. « Nouveau canvas » sur la gallery).
 */

const headStyle: CSSProperties = {
	minHeight: 45,
	boxSizing: "border-box",
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	padding: "0 32px",
	borderBottom: "1px solid var(--sqlnest-border)",
	flexShrink: 0,
	gap: 16
};

const titleStyle: CSSProperties = {
	fontSize: 13,
	fontWeight: 500,
	color: "var(--sqlnest-text-title)",
	margin: 0
};

export function PageHead({
	title,
	actions
}: {
	readonly title: string;
	readonly actions?: ReactNode;
}): React.ReactNode {
	return (
		<div style={headStyle}>
			<h1 style={titleStyle}>{title}</h1>
			{actions}
		</div>
	);
}

/**
 * CTA « Nouveau canvas » — placé dans le slot `actions` du PageHead.
 * Style « outlined » via `.sqlnest-header-cta` : hover transitionne
 * vers bg surface-hover + border accent-muted.
 */
const ctaStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 7,
	padding: "6px 12px",
	background: "var(--sqlnest-surface)",
	color: "var(--sqlnest-text-primary)",
	border: "1px solid var(--sqlnest-border)",
	borderRadius: 6,
	fontSize: 12,
	fontWeight: 500,
	textDecoration: "none",
	boxSizing: "border-box",
	whiteSpace: "nowrap"
};

export function NewCanvasCta({
	teamSlug
}: {
	readonly teamSlug: string | null;
}): React.ReactNode {
	if (teamSlug) {
		return (
			<Link
				to="/team/$teamSlug/pair"
				params={{ teamSlug }}
				className="sqlnest-header-cta"
				style={ctaStyle}
			>
				<IconArtboard size={14} stroke={2} aria-hidden />
				<span>Nouveau canvas</span>
			</Link>
		);
	}
	return (
		<Link to="/pair" className="sqlnest-header-cta" style={ctaStyle}>
			<IconArtboard size={14} stroke={2} aria-hidden />
			<span>Nouveau canvas</span>
		</Link>
	);
}
