import { Button } from "@mantine/core";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

const meta = {
	title: "Components/ContextMenu",
	component: ContextMenu,
} satisfies Meta<typeof ContextMenu>;

export default meta;

type Story = StoryObj<typeof meta>;

const items: ContextMenuItem[] = [
	{ kind: "action", id: "details", label: "Détails" },
	{ kind: "action", id: "open", label: "Ouvrir dans l'éditeur" },
	{ kind: "action", id: "data", label: "Voir les 100 premières lignes" },
	{
		kind: "submenu",
		id: "frame",
		label: "Ajouter à un frame",
		items: [
			{ kind: "action", id: "u", label: "Utilisateurs" },
			{ kind: "action", id: "c", label: "Commerce" },
		],
	},
	{ kind: "divider" },
	{ kind: "action", id: "copy", label: "Copier le nom" },
	{ kind: "action", id: "hide", label: "Masquer" },
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

// Preuve visuelle du fix layout : un label + hint tous deux longs ne
// doivent PAS wrapper le label — les deux sont tronqués proprement avec
// ellipsis, la row reste sur une ligne.
export const LongLabelAndHint: Story = {
	args: {
		open: true,
		position: { x: 24, y: 24 },
		title: "resource_software_link",
		items: [
			{
				kind: "action",
				id: "long",
				label: "Ouvrir cette table extrêmement longue dans l'éditeur SNQL",
				hint: "get resource_software_link | limit 100",
			},
			{
				kind: "action",
				id: "short",
				label: "Court",
				hint: "⌘K",
			},
		],
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
