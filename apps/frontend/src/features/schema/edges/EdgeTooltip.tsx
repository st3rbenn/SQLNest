import { EdgeLabelRenderer } from "@xyflow/react";
import type { CSSProperties } from "react";
import { humanFooter, humanRelation, joinPreview } from "../fkFormat";
import type { Relation } from "../schema-model";

/**
 * Tooltip sombre au midpoint de l'edge — s'affiche au hover pour révéler
 * la relation en langage humain (+ preview SQL discret en pied). Font-family
 * système par défaut, seul le bloc SQL est monospacé. `pointerEvents: none`
 * pour ne pas voler le hover à la ligne d'interaction.
 */
const TOOLTIP_BASE: CSSProperties = {
	position: "absolute",
	background: "var(--sqlnest-surface)",
	color: "var(--sqlnest-text-primary)",
	padding: "10px 14px",
	borderRadius: 8,
	fontSize: 13,
	lineHeight: 1.5,
	fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
	border: "1px solid var(--sqlnest-border)",
	boxShadow: "0 6px 20px rgba(0, 0, 0, 0.5)",
	whiteSpace: "nowrap",
	pointerEvents: "none",
	zIndex: 11,
	minWidth: 220
};

function tooltipStyle(x: number, y: number, revealed: boolean): CSSProperties {
	// Opacity + petit slide vers le haut pour un fade-in soigné (translate
	// combine offset de position + décalage d'entrée). Transition dure 220ms.
	const enterOffset = revealed ? "0px" : "6px";
	return {
		...TOOLTIP_BASE,
		transform: `translate(-50%, calc(-100% - 6px + ${enterOffset})) translate(${x}px, ${y}px)`,
		opacity: revealed ? 1 : 0,
		transition: "opacity 220ms ease-out, transform 220ms ease-out"
	};
}

const TOOLTIP_TABLE: CSSProperties = {
	fontWeight: 700,
	color: "var(--sqlnest-text-primary)",
	background: "rgba(255, 255, 255, 0.08)",
	padding: "1px 6px",
	borderRadius: 4
};

const TOOLTIP_FOOTER: CSSProperties = {
	marginTop: 4,
	fontSize: 11,
	color: "var(--sqlnest-text-secondary)"
};

const TOOLTIP_SQL: CSSProperties = {
	marginTop: 8,
	padding: "6px 8px",
	background: "rgba(255, 255, 255, 0.05)",
	borderRadius: 4,
	fontSize: 10.5,
	color: "var(--sqlnest-text-secondary)",
	fontFamily: "var(--mantine-font-family-monospace)"
};

export interface EdgeTooltipProps {
	readonly relation: Relation;
	readonly labelX: number;
	readonly labelY: number;
	readonly revealed: boolean;
}

export function EdgeTooltip({
	relation,
	labelX,
	labelY,
	revealed
}: EdgeTooltipProps) {
	const s = humanRelation(relation);
	return (
		<EdgeLabelRenderer>
			<div style={tooltipStyle(labelX, labelY, revealed)}>
				<div>
					{s.prefix}
					<span style={TOOLTIP_TABLE}>{s.from}</span>
					{s.middle}
					<span style={TOOLTIP_TABLE}>{s.to}</span>
				</div>
				<div style={TOOLTIP_FOOTER}>{humanFooter(relation)}</div>
				<div style={TOOLTIP_SQL}>{joinPreview(relation.from, relation.to)}</div>
			</div>
		</EdgeLabelRenderer>
	);
}
