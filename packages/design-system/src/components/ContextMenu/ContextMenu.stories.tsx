import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Button } from "@mantine/core";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

const meta = {
	title: "Components/ContextMenu",
	component: ContextMenu,
} satisfies Meta<typeof ContextMenu>;

export default meta;

type Story = StoryObj<typeof meta>;

const items: ContextMenuItem[] = [
	{
		kind: "action",
		id: "open",
		label: "Ouvrir dans l'éditeur",
		hint: "get orders",
		active: true,
	},
	{
		kind: "action",
		id: "data",
		label: "Voir les données",
		hint: "limit 100",
	},
	{
		kind: "submenu",
		id: "frame",
		label: "Ajouter à un frame",
		items: [
			{ kind: "action", id: "u", label: "Utilisateurs" },
			{ kind: "action", id: "c", label: "Commerce" },
			{ kind: "divider" },
			{ kind: "action", id: "new", label: "Nouveau frame…" },
		],
	},
	{ kind: "divider" },
	{ kind: "action", id: "copy", label: "Copier le nom" },
	{ kind: "action", id: "hide", label: "Masquer" },
	{ kind: "action", id: "details", label: "Détails" },
];

export const Default: Story = {
	args: {
		open: true,
		position: { x: 24, y: 24 },
		items,
		title: "orders",
		onClose: () => {},
	},
};

export const TriggeredOnRightClick: Story = {
	args: { open: false, position: { x: 0, y: 0 }, items, onClose: () => {} },
	render: () => {
		const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
		return (
			<div
				onContextMenu={(e) => {
					e.preventDefault();
					setPos({ x: e.clientX, y: e.clientY });
				}}
				style={{
					width: 500,
					height: 320,
					background: "#f8fafc",
					border: "1px dashed #cbd5e1",
					borderRadius: 8,
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
				}}
			>
				<Button onClick={() => setPos({ x: 200, y: 120 })}>
					Ou clique ici (le menu s'ouvre)
				</Button>
				<ContextMenu
					open={pos !== null}
					position={pos ?? { x: 0, y: 0 }}
					onClose={() => setPos(null)}
					items={items}
					title="orders"
				/>
			</div>
		);
	},
};
