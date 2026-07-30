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

const PALETTE: Record<KindBadgeKind, { bg: string; color: string }> = {
	declared: {
		bg: "var(--mantine-color-brand-1)",
		color: "var(--mantine-color-brand-7)",
	},
	inferred: {
		bg: "var(--mantine-color-amber-1)",
		color: "var(--mantine-color-amber-7)",
	},
	pk: {
		bg: "var(--mantine-color-amber-1)",
		color: "var(--mantine-color-amber-7)",
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
