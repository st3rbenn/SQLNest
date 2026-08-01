import { Group } from "@mantine/core";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { StatusPill } from "./StatusPill";

const meta = {
	title: "Components/StatusPill",
	component: StatusPill,
} satisfies Meta<typeof StatusPill>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Success: Story = {
	args: { status: "success", withDot: true, children: "Live — schéma public" },
};

export const AllVariants: Story = {
	args: { status: "success", children: null },
	render: () => (
		<Group>
			<StatusPill status="success" withDot>
				Live
			</StatusPill>
			<StatusPill status="info" withDot>
				Introspection…
			</StatusPill>
			<StatusPill status="warning" withDot>
				Schéma vide
			</StatusPill>
			<StatusPill status="danger" withDot>
				Base injoignable
			</StatusPill>
			<StatusPill status="neutral">Prêt</StatusPill>
		</Group>
	),
};
