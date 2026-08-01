import { Stack, Text, TextInput } from "@mantine/core";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { SidebarDrawer, type SidebarTab } from "./SidebarDrawer";

const meta = {
	title: "Layouts/SidebarDrawer",
	component: SidebarDrawer,
	parameters: { layout: "centered" },
} satisfies Meta<typeof SidebarDrawer>;

export default meta;

type Story = StoryObj<typeof meta>;

const TABS: SidebarTab[] = [
	{ value: "tables", label: "Tables" },
	{ value: "frames", label: "Frames", count: 4 },
	{ value: "diff", label: "Diff" },
];

export const SchemaBrowser: Story = {
	args: {
		tabs: TABS,
		value: "tables",
		children: null,
	},
	render: (args) => {
		const [active, setActive] = useState("tables");
		return (
			<div style={{ height: 480 }}>
				<SidebarDrawer
					{...args}
					value={active}
					onTabChange={setActive}
					header={<TextInput placeholder="Rechercher…" size="sm" />}
				>
					<Stack gap={0} p="sm">
						<Text size="xs" c="dimmed">
							Onglet actif : {active}
						</Text>
						<Text size="sm">users</Text>
						<Text size="sm">sessions</Text>
						<Text size="sm">orders</Text>
						<Text size="sm">products</Text>
					</Stack>
				</SidebarDrawer>
			</div>
		);
	},
};
