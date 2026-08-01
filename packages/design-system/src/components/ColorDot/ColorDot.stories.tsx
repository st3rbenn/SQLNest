import type { Meta, StoryObj } from "@storybook/react-vite";
import { ColorDot } from "./ColorDot";

const meta = {
	title: "Components/ColorDot",
	component: ColorDot
} satisfies Meta<typeof ColorDot>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
	render: () => (
		<div style={{ display: "flex", alignItems: "center", gap: 16 }}>
			<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
				<ColorDot color="#2563eb" size="sm" />
				<span>sm · 8px rond</span>
			</div>
			<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
				<ColorDot color="#10b981" size="md" />
				<span>md · 10px rond</span>
			</div>
			<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
				<ColorDot color="#f59e0b" size="lg" />
				<span>lg · 12px carré arrondi</span>
			</div>
		</div>
	)
};

export const SmallDot: Story = {
	args: { color: "#2563eb", size: "sm" }
};

export const MediumDot: Story = {
	args: { color: "#10b981", size: "md" }
};

export const LargeSquare: Story = {
	args: { color: "#f59e0b", size: "lg" }
};
