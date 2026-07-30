import { Divider, Group, Paper, type PaperProps, Stack } from "@mantine/core";
import type { ReactNode } from "react";

export type ToolbarOrientation = "vertical" | "horizontal";

export type ToolbarProps = {
	children: ReactNode;
	orientation?: ToolbarOrientation;
	"aria-label"?: string;
} & Omit<PaperProps, "children">;

function ToolbarDivider({
	orientation = "vertical"
}: {
	orientation?: ToolbarOrientation;
}) {
	const isV = orientation === "vertical";
	return (
		<Divider
			role="separator"
			orientation={isV ? "horizontal" : "vertical"}
			my={isV ? 4 : 0}
			mx={isV ? "auto" : 4}
			w={isV ? 24 : undefined}
			h={isV ? undefined : 24}
		/>
	);
}

/**
 * Toolbar générique — série d'`ActionIcon`s alignés + séparateurs. Prop
 * `orientation` bascule le layout (colonne vs ligne). Utilisée par
 * `CanvasToolbar` (canvas Schéma) ; réutilisable ailleurs (footer d'éditeur,
 * pane latéral, etc.).
 */
export function Toolbar({
	children,
	orientation = "vertical",
	"aria-label": ariaLabel,
	...paperProps
}: ToolbarProps) {
	const Container = orientation === "vertical" ? Stack : Group;
	return (
		<Paper
			role="toolbar"
			aria-orientation={orientation}
			aria-label={ariaLabel}
			radius="xl"
			shadow="md"
			withBorder
			py={orientation === "vertical" ? 8 : 6}
			px={orientation === "vertical" ? 0 : 8}
			w={orientation === "vertical" ? 52 : undefined}
			h={orientation === "vertical" ? undefined : 52}
			{...paperProps}
		>
			<Container gap={4} align="center" wrap="nowrap">
				{children}
			</Container>
		</Paper>
	);
}

Toolbar.Divider = ToolbarDivider;
