import { Box, type BoxProps } from "@mantine/core";

export type KindBadgeKind = "declared" | "inferred" | "pk";

export type KindBadgeProps = {
	kind: KindBadgeKind;
	label?: string;
} & Omit<BoxProps, "children">;

const DEFAULT_LABELS: Record<KindBadgeKind, string> = {
	declared: "DÉCLARÉ",
	inferred: "INFÉRÉ",
	pk: "PK",
};

/**
 * Palette dark-first — tokens Figma. Fond translucide (soft) pour poser le
 * badge sur n'importe quelle surface (`#2C2C2C` shell d'une table, header
 * teinté, …) sans faire tache. Couleur pleine pour le texte, qui garde le
 * message le plus visible.
 */
const PALETTE: Record<KindBadgeKind, { bg: string; color: string }> = {
	declared: {
		bg: "var(--sqlnest-accent-soft)",
		color: "var(--sqlnest-accent)",
	},
	inferred: {
		bg: "var(--sqlnest-warning-soft)",
		color: "var(--sqlnest-warning)",
	},
	pk: {
		bg: "var(--sqlnest-warning-soft)",
		color: "var(--sqlnest-warning)",
	},
};

export function KindBadge({ kind, label, style, ...rest }: KindBadgeProps) {
	const { bg, color } = PALETTE[kind];
	return (
		<Box
			style={{
				display: "inline-block",
				padding: "1px 5px",
				borderRadius: 4,
				background: bg,
				color,
				fontSize: kind === "pk" ? 9 : 10,
				fontWeight: 700,
				letterSpacing: "0.3px",
				fontFamily: "var(--mantine-font-family)",
				...(style as Record<string, unknown> | undefined),
			}}
			{...rest}
		>
			{label ?? DEFAULT_LABELS[kind]}
		</Box>
	);
}
