import { Group, Kbd, Paper, type PaperProps, Text } from "@mantine/core";
import type { ReactNode } from "react";

export type HintPillProps = {
	keys: readonly string[];
	children: ReactNode;
} & Omit<PaperProps, "children">;

export function HintPill({ keys, children, style, ...rest }: HintPillProps) {
	return (
		<Paper
			radius="xl"
			shadow="md"
			withBorder
			px="sm"
			py={6}
			bg="var(--sqlnest-surface)"
			style={{
				borderColor: "var(--sqlnest-border)",
				...(style as Record<string, unknown> | undefined),
			}}
			{...rest}
		>
			<Group gap={8} wrap="nowrap">
				<Text size="xs" style={{ color: "var(--sqlnest-text-secondary)" }}>
					{children}
				</Text>
				{keys.map((k) => (
					<Kbd key={k} size="xs">
						{k}
					</Kbd>
				))}
			</Group>
		</Paper>
	);
}
