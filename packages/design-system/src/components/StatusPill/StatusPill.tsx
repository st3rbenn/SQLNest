import { Box, Group, Paper, type PaperProps } from "@mantine/core";
import type { ReactNode } from "react";

export type StatusPillVariant =
	| "success"
	| "info"
	| "warning"
	| "danger"
	| "neutral";

export type StatusPillProps = {
	status: StatusPillVariant;
	withDot?: boolean;
	children: ReactNode;
} & Omit<PaperProps, "children">;

type Palette = { bg: string; color: string; border: string; dot: string };

/**
 * Palette dark-first — bg = version « soft » (10-15 % alpha) du token,
 * text/dot = version pleine. Rendu discret sur `--sqlnest-canvas-bg`
 * (#1E1E1E) tout en gardant la sémantique de couleur intacte.
 */
const PALETTE: Record<StatusPillVariant, Palette> = {
	success: {
		bg: "var(--sqlnest-success-soft)",
		color: "var(--sqlnest-success)",
		border: "var(--sqlnest-success)",
		dot: "var(--sqlnest-success)",
	},
	info: {
		bg: "var(--sqlnest-accent-soft)",
		color: "var(--sqlnest-accent)",
		border: "var(--sqlnest-accent)",
		dot: "var(--sqlnest-accent)",
	},
	warning: {
		bg: "var(--sqlnest-warning-soft)",
		color: "var(--sqlnest-warning)",
		border: "var(--sqlnest-warning)",
		dot: "var(--sqlnest-warning)",
	},
	danger: {
		bg: "var(--sqlnest-danger-soft)",
		color: "var(--sqlnest-danger)",
		border: "var(--sqlnest-danger)",
		dot: "var(--sqlnest-danger)",
	},
	neutral: {
		bg: "var(--sqlnest-surface)",
		color: "var(--sqlnest-text-secondary)",
		border: "var(--sqlnest-border)",
		dot: "var(--sqlnest-text-tertiary)",
	},
};

export function StatusPill({
	status,
	withDot,
	children,
	style,
	...rest
}: StatusPillProps) {
	const palette = PALETTE[status];
	return (
		<Paper
			role="status"
			radius="sm"
			px="sm"
			py={6}
			style={{
				background: palette.bg,
				color: palette.color,
				border: `1px solid ${palette.border}`,
				fontSize: 12,
				fontWeight: 500,
				...(style as Record<string, unknown> | undefined),
			}}
			{...rest}
		>
			<Group gap={6} wrap="nowrap">
				{withDot ? (
					<Box
						data-testid="status-pill-dot"
						style={{
							width: 6,
							height: 6,
							borderRadius: "50%",
							background: palette.dot,
						}}
					/>
				) : null}
				<span>{children}</span>
			</Group>
		</Paper>
	);
}
