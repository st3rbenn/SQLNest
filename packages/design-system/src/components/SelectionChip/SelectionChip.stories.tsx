import type { Meta, StoryObj } from "@storybook/react-vite";
import { SelectionChip } from "./SelectionChip";

const meta = {
	title: "Components/SelectionChip",
	component: SelectionChip,
} satisfies Meta<typeof SelectionChip>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ThreeTables: Story = {
	args: {
		count: 3,
		label: "tables",
		onClear: () => undefined,
		actions: [
			{ id: "frame", label: "Frame", hint: "F", onClick: () => undefined },
			{ id: "hide", label: "Masquer", onClick: () => undefined },
		],
	},
};

export const One: Story = {
	args: {
		count: 1,
		label: "table",
		onClear: () => undefined,
		actions: [{ id: "frame", label: "Frame", hint: "F", onClick: () => undefined }],
	},
};
