import { Divider, Paper, type PaperProps, Stack } from "@mantine/core";
import type { ReactNode } from "react";

export type VerticalToolbarProps = {
	children: ReactNode;
	"aria-label"?: string;
} & Omit<PaperProps, "children">;

function ToolbarDivider() {
	return <Divider role="separator" my={4} w={24} mx="auto" />;
}

export function VerticalToolbar({
	children,
	"aria-label": ariaLabel,
	...paperProps
}: VerticalToolbarProps) {
	return (
		<Paper
			role="toolbar"
			aria-orientation="vertical"
			aria-label={ariaLabel}
			radius="xl"
			shadow="md"
			withBorder
			py={8}
			w={52}
			{...paperProps}
		>
			<Stack gap={4} align="center">
				{children}
			</Stack>
		</Paper>
	);
}

VerticalToolbar.Divider = ToolbarDivider;
