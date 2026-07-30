import type { Meta, StoryObj } from "@storybook/react-vite";
import { SearchInput } from "./SearchInput";

const meta = {
	title: "Components/SearchInput",
	component: SearchInput,
} satisfies Meta<typeof SearchInput>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: { placeholder: "Rechercher parmi 186 tables…" },
};
