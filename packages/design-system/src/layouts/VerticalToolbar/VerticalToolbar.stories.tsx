import type { Meta, StoryObj } from "@storybook/react-vite";
import { ActionIcon, Tooltip } from "@mantine/core";
import { VerticalToolbar } from "./VerticalToolbar";

const meta = {
	title: "Layouts/VerticalToolbar",
	component: VerticalToolbar,
} satisfies Meta<typeof VerticalToolbar>;

export default meta;

type Story = StoryObj<typeof meta>;

const CursorIcon = () => (
	<svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor">
		<title>Select</title>
		<path d="M4 2l14 8-6 2-2 6z" />
	</svg>
);

const FrameIcon = () => (
	<svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
		<title>Frame</title>
		<rect x={4} y={4} width={16} height={16} rx={2} strokeDasharray="3 3" />
	</svg>
);

export const CanvasToolbar: Story = {
	args: { "aria-label": "Canvas actions", children: null },
	render: (args) => (
		<VerticalToolbar {...args}>
			<Tooltip label="Sélection (V)" position="right">
				<ActionIcon
					variant="light"
					color="brand"
					radius={9}
					size={36}
					aria-label="Sélection"
				>
					<CursorIcon />
				</ActionIcon>
			</Tooltip>
			<Tooltip label="Créer un frame (F)" position="right">
				<ActionIcon
					variant="subtle"
					color="slate"
					radius={9}
					size={36}
					aria-label="Frame"
				>
					<FrameIcon />
				</ActionIcon>
			</Tooltip>
			<VerticalToolbar.Divider />
			<Tooltip label="Exporter" position="right">
				<ActionIcon
					variant="subtle"
					color="slate"
					radius={9}
					size={36}
					aria-label="Exporter"
				>
					<svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
						<title>Export</title>
						<path d="M12 3v12m0 0l-4-4m4 4l4-4M5 19h14" />
					</svg>
				</ActionIcon>
			</Tooltip>
		</VerticalToolbar>
	),
};
