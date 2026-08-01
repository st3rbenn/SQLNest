import { Group, Kbd, Text } from "@mantine/core";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { FloatingPanel } from "./FloatingPanel";

const meta = {
	title: "Layouts/FloatingPanel",
	component: FloatingPanel,
	parameters: {
		layout: "fullscreen",
	},
	decorators: [
		(Story) => (
			<div
				style={{
					position: "relative",
					width: "100%",
					height: 500,
					background: "#fafbfc",
					backgroundImage: "radial-gradient(#e2e8f0 1px, transparent 1px)",
					backgroundSize: "20px 20px",
					border: "1px solid #e2e8f0",
					borderRadius: 8,
				}}
			>
				<Story />
			</div>
		),
	],
} satisfies Meta<typeof FloatingPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const TopLeft: Story = {
	args: {
		position: "top-left",
		children: (
			<Group gap="xs" p="xs">
				<Text size="sm" fw={600}>
					Engine
				</Text>
				<Text size="xs" c="dimmed">
					PostgreSQL
				</Text>
			</Group>
		),
	},
};

export const BottomCenter: Story = {
	args: {
		position: "bottom-center",
		radius: "xl",
		children: (
			<Group gap={8} px="sm" py={6}>
				<Text size="xs" c="dimmed">
					Actions rapides
				</Text>
				<Kbd>⌘K</Kbd>
			</Group>
		),
	},
};

export const AllCorners: Story = {
	render: () => (
		<>
			<FloatingPanel position="top-left">
				<Text size="xs" p="xs">
					top-left
				</Text>
			</FloatingPanel>
			<FloatingPanel position="top-right">
				<Text size="xs" p="xs">
					top-right
				</Text>
			</FloatingPanel>
			<FloatingPanel position="bottom-left">
				<Text size="xs" p="xs">
					bottom-left
				</Text>
			</FloatingPanel>
			<FloatingPanel position="bottom-right">
				<Text size="xs" p="xs">
					bottom-right
				</Text>
			</FloatingPanel>
			<FloatingPanel position="bottom-center" radius="xl">
				<Text size="xs" p="xs">
					bottom-center
				</Text>
			</FloatingPanel>
		</>
	),
};
