import type { Meta, StoryObj } from "@storybook/react-vite";
import { Group } from "@mantine/core";
import { ToolbarButton } from "./ToolbarButton";

const meta = {
	title: "Components/ToolbarButton",
	component: ToolbarButton,
} satisfies Meta<typeof ToolbarButton>;

export default meta;

type Story = StoryObj<typeof meta>;

const Cursor = () => (
	<svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor">
		<title>cursor</title>
		<path d="M4 2l14 8-6 2-2 6z" />
	</svg>
);

export const Default: Story = {
	args: { label: "Sélection (V)", children: <Cursor /> },
};

export const Active: Story = {
	args: { label: "Sélection (V)", active: true, children: <Cursor /> },
};

export const WithStatusDot: Story = {
	args: {
		label: "Diff schémas (bientôt)",
		statusDot: "warning",
		children: <Cursor />,
	},
};

export const Row: Story = {
	args: { label: "…", children: null },
	render: () => (
		<Group gap={4}>
			<ToolbarButton label="Actif" active>
				<Cursor />
			</ToolbarButton>
			<ToolbarButton label="Neutre">
				<Cursor />
			</ToolbarButton>
			<ToolbarButton label="Bientôt" statusDot="warning">
				<Cursor />
			</ToolbarButton>
		</Group>
	),
};
