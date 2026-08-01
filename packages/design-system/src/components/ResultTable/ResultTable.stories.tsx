import type { Meta, StoryObj } from "@storybook/react-vite";
import { ResultTable } from "./ResultTable";

const meta = {
	title: "Components/ResultTable",
	component: ResultTable,
} satisfies Meta<typeof ResultTable>;

export default meta;

type Story = StoryObj<typeof meta>;

const columns = ["id", "email", "is_active", "meta"] as const;
const rows = [
	{
		id: 1,
		email: "alice@example.com",
		is_active: true,
		meta: { role: "admin" },
	},
	{ id: 2, email: "bob@example.com", is_active: false, meta: null },
	{ id: 3, email: null, is_active: true, meta: { role: "user", tier: 3 } },
];

export const Default: Story = {
	args: { columns: [...columns], rows },
};

export const Empty: Story = {
	args: { columns: [...columns], rows: [] },
};

export const CustomEmpty: Story = {
	args: {
		columns: [...columns],
		rows: [],
		emptyMessage: "Aucune ligne ne correspond à ce filtre.",
	},
};

export const Scrollable: Story = {
	args: {
		columns: [...columns],
		rows: Array.from({ length: 60 }, (_, i) => ({
			id: i + 1,
			email: `user${i + 1}@example.com`,
			is_active: i % 2 === 0,
			meta: { idx: i },
		})),
		maxHeight: 240,
	},
};

export const BigintPreserved: Story = {
	args: {
		columns: ["id", "amount"],
		rows: [
			{ id: 1, amount: 9007199254740993n },
			{ id: 2, amount: 1234567890123456789n },
		],
	},
};
