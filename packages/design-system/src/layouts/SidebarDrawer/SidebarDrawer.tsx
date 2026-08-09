import { Box, Group, Paper, type PaperProps, Tabs, Text } from "@mantine/core";
import type { CSSProperties, ReactNode } from "react";

export type SidebarTab = {
	value: string;
	label: string;
	count?: number;
};

export type SidebarDrawerVariant = "floating" | "docked";

type BaseProps = {
	header?: ReactNode;
	children: ReactNode;
	footer?: ReactNode;
	width?: number;
	title?: string;
	variant?: SidebarDrawerVariant;
} & Omit<PaperProps, "children" | "title">;

export type SidebarDrawerProps = BaseProps & {
	tabs?: readonly SidebarTab[];
	value?: string;
	onTabChange?: (value: string) => void;
};

const DOCKED_STYLE: CSSProperties = {
	borderTopLeftRadius: 0,
	borderBottomLeftRadius: 0,
	borderLeft: "none",
	// Shadow uniforme via token DS (`--sqlnest-shadow-floating`) —
	// même blur/opacité que les autres containers flottants (HUD,
	// CanvasLeftPanel, SelectionChip). Sidebar tire son shadow vers
	// la droite (offset X positif) plutôt que vers le bas.
	boxShadow: "var(--sqlnest-shadow-floating)",
};

export function SidebarDrawer({
	tabs,
	value,
	onTabChange,
	header,
	title,
	footer,
	variant = "floating",
	children,
	width = 300,
	style,
	...paperProps
}: SidebarDrawerProps) {
	const docked = variant === "docked";
	return (
		<Paper
			data-variant={variant}
			radius={docked ? 0 : "lg"}
			{...(docked ? {} : { shadow: "lg" as const })}
			withBorder
			w={width}
			// bg via prop Mantine — le Paper hérite sinon d'un bg blanc en
			// absence d'override, même sous forceColorScheme dark (le token
			// Mantine white est appliqué par le style-api du composant).
			bg="var(--sqlnest-surface)"
			style={{
				display: "flex",
				flexDirection: "column",
				overflow: "hidden",
				borderColor: "var(--sqlnest-border)",
				...(docked ? DOCKED_STYLE : {}),
				...(style as CSSProperties | undefined),
			}}
			{...paperProps}
		>
			{tabs !== undefined && tabs.length > 0 ? (
				<Tabs
					value={value ?? tabs[0]?.value ?? null}
					onChange={(v) => v && onTabChange?.(v)}
					variant="default"
					keepMounted={false}
				>
					<Tabs.List px={8} pt={8}>
						{tabs.map((tab) => (
							<Tabs.Tab key={tab.value} value={tab.value} flex={1}>
								<Group gap={4} justify="center" wrap="nowrap">
									<Text size="xs" fw={600} span>
										{tab.label}
									</Text>
									{tab.count !== undefined ? (
										<Text size="xs" c="slate.4" span>
											{tab.count}
										</Text>
									) : null}
								</Group>
							</Tabs.Tab>
						))}
					</Tabs.List>
				</Tabs>
			) : title ? (
				<Box
					px="sm"
					py="xs"
					style={{ borderBottom: "1px solid var(--sqlnest-border-subtle)" }}
				>
					<Text
						size="sm"
						fw={700}
						style={{ color: "var(--sqlnest-text-primary)" }}
					>
						{title}
					</Text>
				</Box>
			) : null}

			{header ? (
				<Box
					p="sm"
					style={{ borderBottom: "1px solid var(--sqlnest-border-subtle)" }}
				>
					{header}
				</Box>
			) : null}

			<Box style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>{children}</Box>

			{footer ? (
				<Box
					px="sm"
					py="xs"
					style={{ borderTop: "1px solid var(--sqlnest-border-subtle)" }}
				>
					{footer}
				</Box>
			) : null}
		</Paper>
	);
}
