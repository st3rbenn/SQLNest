import { Group } from "@mantine/core";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { KindBadge } from "./KindBadge";

const meta = {
	title: "Components/KindBadge",
	component: KindBadge,
} satisfies Meta<typeof KindBadge>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Declared: Story = { args: { kind: "declared" } };
export const Inferred: Story = { args: { kind: "inferred" } };
export const PrimaryKey: Story = { args: { kind: "pk" } };

export const AllKinds: Story = {
	args: { kind: "declared" },
	render: () => (
		<Group>
			<KindBadge kind="declared" />
			<KindBadge kind="inferred" />
			<KindBadge kind="pk" />
			<KindBadge kind="declared" label="DÉCL." />
		</Group>
	),
};
