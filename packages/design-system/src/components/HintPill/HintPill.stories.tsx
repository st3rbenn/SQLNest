import type { Meta, StoryObj } from "@storybook/react-vite";
import { HintPill } from "./HintPill";

const meta = {
	title: "Components/HintPill",
	component: HintPill,
} satisfies Meta<typeof HintPill>;

export default meta;

type Story = StoryObj<typeof meta>;

export const CmdK: Story = {
	args: { keys: ["⌘K"], children: "Actions rapides" },
};

export const MultipleKeys: Story = {
	args: { keys: ["⌘", "K"], children: "Palette" },
};
