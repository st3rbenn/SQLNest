import { ActionIcon, Box, Group, Paper, Text } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import type { ReactNode } from "react";

/**
 * Panneau flottant à droite du canvas : en-tête (icône, titre, fermer), corps
 * qui défile, pied optionnel. Un seul à la fois (liens à inférer, changement
 * de schéma).
 */
export function CanvasSidePanel({
	icon,
	title,
	onClose,
	children,
	footer
}: {
	readonly icon: ReactNode;
	readonly title: string;
	readonly onClose: () => void;
	readonly children: ReactNode;
	readonly footer?: ReactNode;
}) {
	return (
		<Paper
			radius={12}
			shadow="lg"
			withBorder
			bg="var(--sqlnest-elevated)"
			style={{
				position: "absolute",
				top: 64,
				right: 12,
				bottom: 88,
				width: 344,
				zIndex: 7,
				borderColor: "var(--sqlnest-border-subtle)",
				display: "flex",
				flexDirection: "column",
				overflow: "hidden"
			}}
		>
			<Group
				justify="space-between"
				wrap="nowrap"
				px="md"
				py="sm"
				style={{ borderBottom: "1px solid var(--sqlnest-border-subtle)" }}
			>
				<Group gap={8} wrap="nowrap">
					{icon}
					<Text
						size="sm"
						fw={600}
						style={{ color: "var(--sqlnest-text-primary)" }}
					>
						{title}
					</Text>
				</Group>
				<ActionIcon
					size="sm"
					variant="subtle"
					color="gray"
					aria-label="Fermer"
					onClick={onClose}
				>
					<IconX size={15} />
				</ActionIcon>
			</Group>
			<Box
				style={{
					flex: 1,
					minHeight: 0,
					display: "flex",
					flexDirection: "column"
				}}
			>
				{children}
			</Box>
			{footer !== undefined ? (
				<Box
					px="md"
					py="xs"
					style={{ borderTop: "1px solid var(--sqlnest-border-subtle)" }}
				>
					{footer}
				</Box>
			) : null}
		</Paper>
	);
}
