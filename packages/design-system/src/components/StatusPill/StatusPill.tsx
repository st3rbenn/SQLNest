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

const PALETTE: Record<StatusPillVariant, Palette> = {
	success: {
		bg: "var(--mantine-color-emerald-0)",
		color: "var(--mantine-color-emerald-7)",
		border: "var(--mantine-color-emerald-2)",
		dot: "var(--mantine-color-emerald-5)",
	},
	info: {
		bg: "var(--mantine-color-brand-0)",
		color: "var(--mantine-color-brand-7)",
		border: "var(--mantine-color-brand-2)",
		dot: "var(--mantine-color-brand-5)",
	},
	warning: {
		bg: "var(--mantine-color-amber-0)",
		color: "var(--mantine-color-amber-7)",
		border: "var(--mantine-color-amber-2)",
		dot: "var(--mantine-color-amber-5)",
	},
	danger: {
		bg: "var(--mantine-color-red-0)",
		color: "var(--mantine-color-red-7)",
		border: "var(--mantine-color-red-2)",
		dot: "var(--mantine-color-red-5)",
	},
	neutral: {
		bg: "var(--mantine-color-slate-0)",
		color: "var(--mantine-color-slate-7)",
		border: "var(--mantine-color-slate-2)",
		dot: "var(--mantine-color-slate-4)",
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
