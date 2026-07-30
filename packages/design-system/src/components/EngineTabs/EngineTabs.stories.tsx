import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { EngineTabs, type EngineValue } from "./EngineTabs";

const meta = {
	title: "Components/EngineTabs",
	component: EngineTabs,
} satisfies Meta<typeof EngineTabs>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: { value: "postgres", onChange: () => {} },
	render: () => {
		const [engine, setEngine] = useState<EngineValue>("postgres");
		return <EngineTabs value={engine} onChange={setEngine} />;
	},
};
