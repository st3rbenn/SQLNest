import type { Meta, StoryObj } from "@storybook/react-vite";
import { RowItem } from "./RowItem";

const meta = {
	title: "Components/RowItem",
	component: RowItem,
	decorators: [
		(Story) => (
			<div style={{ width: 280, border: "1px solid #eee", borderRadius: 6 }}>
				<Story />
			</div>
		),
	],
} satisfies Meta<typeof RowItem>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: { label: "orders", color: "#2563eb" },
};

export const Active: Story = {
	args: { label: "orders", color: "#2563eb", active: true },
};

export const WithoutColor: Story = {
	args: { label: "prefix_root" },
};

export const LongLabel: Story = {
	args: {
		label: "very_long_table_name_that_should_ellipsize_at_some_point",
		color: "#10b981",
	},
};

export const Monospace: Story = {
	args: {
		label: "user_id → users.id",
		color: "#f59e0b",
		size: "sm",
		monospace: true,
	},
};

export const List: Story = {
	render: () => (
		<>
			<RowItem label="orders" color="#2563eb" />
			<RowItem label="users" color="#10b981" active />
			<RowItem label="products" color="#f59e0b" />
			<RowItem label="prefix_group" />
		</>
	),
};
