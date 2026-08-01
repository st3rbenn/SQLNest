import { Badge, Group, Text } from "@mantine/core";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AppShell } from "./AppShell";

const meta = {
	title: "Layouts/AppShell",
	component: AppShell,
	parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AppShell>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: {
		header: (
			<Group gap="lg" px="lg" w="100%">
				<Text fw={700}>🦅 SQLNest</Text>
				<Text size="sm" c="brand">
					Schéma
				</Text>
				<Text size="sm" c="dimmed">
					Requête
				</Text>
				<div style={{ flex: 1 }} />
				<Badge color="emerald" variant="light">
					API OK
				</Badge>
			</Group>
		),
		children: (
			<div style={{ padding: 24 }}>
				<Text>Corps de page.</Text>
			</div>
		),
	},
};
