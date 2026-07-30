import type { Meta, StoryObj } from "@storybook/react-vite";
import { Group } from "@mantine/core";
import { FrameBadge } from "./FrameBadge";
import { FRAME_HUES } from "../../theme";

const meta = {
	title: "Components/FrameBadge",
	component: FrameBadge,
} satisfies Meta<typeof FrameBadge>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Users: Story = {
	args: { hue: FRAME_HUES.users, label: "Utilisateurs", count: 3 },
};

export const AllHues: Story = {
	args: { hue: 210, label: "…" },
	render: () => (
		<Group>
			<FrameBadge hue={FRAME_HUES.users} label="Utilisateurs" count={3} />
			<FrameBadge hue={FRAME_HUES.commerce} label="Commerce" count={5} />
			<FrameBadge hue={FRAME_HUES.analytics} label="Analytics" count={2} />
			<FrameBadge hue={FRAME_HUES.crossrefs} label="Cross-refs" count={114} />
		</Group>
	),
};
