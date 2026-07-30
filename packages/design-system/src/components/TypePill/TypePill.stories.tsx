import type { Meta, StoryObj } from "@storybook/react-vite";
import { Stack } from "@mantine/core";
import { TypePill } from "./TypePill";

const meta = {
	title: "Components/TypePill",
	component: TypePill,
} satisfies Meta<typeof TypePill>;

export default meta;

type Story = StoryObj<typeof meta>;

export const AllTypes: Story = {
	args: { type: "bigint" },
	render: () => (
		<Stack gap={4}>
			<TypePill type="bigint" />
			<TypePill type="string" />
			<TypePill type="string" nullable />
			<TypePill type="bool" />
			<TypePill type="date" nullable />
			<TypePill type="json" nullable />
		</Stack>
	),
};
