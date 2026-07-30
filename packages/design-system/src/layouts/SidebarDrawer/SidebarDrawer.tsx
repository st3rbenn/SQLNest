import { Box, Group, Paper, type PaperProps, Tabs, Text } from "@mantine/core";
import type { ReactNode } from "react";

export type SidebarTab = {
	value: string;
	label: string;
	count?: number;
};

type BaseProps = {
	header?: ReactNode;
	children: ReactNode;
	width?: number;
	title?: string;
} & Omit<PaperProps, "children" | "title">;

export type SidebarDrawerProps = BaseProps & {
	tabs?: readonly SidebarTab[];
	value?: string;
	onTabChange?: (value: string) => void;
};

export function SidebarDrawer({
	tabs,
	value,
	onTabChange,
	header,
	title,
	children,
	width = 300,
	...paperProps
}: SidebarDrawerProps) {
	return (
		<Paper
			radius="lg"
			shadow="lg"
			withBorder
			w={width}
			style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}
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
					style={{ borderBottom: "1px solid var(--mantine-color-slate-1)" }}
				>
					<Text size="sm" fw={700} c="slate.7">
						{title}
					</Text>
				</Box>
			) : null}

			{header ? (
				<Box
					p="sm"
					style={{ borderBottom: "1px solid var(--mantine-color-slate-1)" }}
				>
					{header}
				</Box>
			) : null}

			<Box style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
				{children}
			</Box>
		</Paper>
	);
}
