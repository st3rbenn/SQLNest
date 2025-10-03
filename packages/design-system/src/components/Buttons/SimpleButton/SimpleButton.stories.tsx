import type { Meta, StoryObj } from "@storybook/react-vite";

import { SimpleButton as Button, type ButtonProps } from "./SimpleButton";

const meta = {
	component: Button,
} satisfies Meta<typeof Button>;

export default meta;

type Story = StoryObj<typeof meta>;

export const SimpleButton: Story = {
	args: {},
	render: (args) => <Button {...args}>I'm a SimpleButton</Button>,
};
