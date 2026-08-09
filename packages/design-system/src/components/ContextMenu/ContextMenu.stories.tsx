import { Box, Button, Kbd, Text } from "@mantine/core";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { ColorDot } from "../ColorDot/ColorDot";
import { KindBadge } from "../KindBadge/KindBadge";
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
		hint: <Kbd size="xs">get users</Kbd>,
		active: true,
	},
	{
		kind: "action",
		id: "data",
		label: "Voir les 100 premières lignes",
		hint: <Kbd size="xs">↵</Kbd>,
	},
	{
		kind: "action",
		id: "details",
		label: "Détails",
		hint: <Kbd size="xs">I</Kbd>,
	},
	{ kind: "divider" },
	{ kind: "section-label", label: "STRUCTURE" },
	{
		kind: "submenu",
		id: "frame",
		label: "Changer de frame",
		items: [
			{ kind: "action", id: "u", label: "Utilisateurs" },
			{ kind: "action", id: "c", label: "Commerce" },
		],
	},
	{
		kind: "action",
		id: "relations",
		label: "Voir les relations",
		hint: "3",
	},
	{ kind: "divider" },
	{
		kind: "action",
		id: "copy",
		label: "Copier le nom",
		hint: <Kbd size="xs">⌘C</Kbd>,
	},
	{
		kind: "action",
		id: "hide",
		label: "Masquer sur le canvas",
		hint: <Kbd size="xs">⌘H</Kbd>,
	},
];

// Header pour la démo — reproduit le header riche du canvas (dot + nom +
// metadata + KindBadge). Le composant DS accepte n'importe quel ReactNode.
const richHeader = (
	<Box
		style={{
			display: "flex",
			alignItems: "center",
			gap: 8,
			padding: "6px 10px",
		}}
	>
		<ColorDot color="hsl(210, 55%, 55%)" size="md" />
		<Box style={{ flex: 1, minWidth: 0 }}>
			<Text fw={600} size="xs" style={{ lineHeight: 1.3 }}>
				users
			</Text>
			<Text
				size="10px"
				ff="monospace"
				style={{ color: "var(--sqlnest-text-tertiary)", lineHeight: 1.3 }}
			>
				public · 5 champs · 3 FK
			</Text>
		</Box>
		<KindBadge kind="declared" />
	</Box>
);

export const Default: Story = {
	args: {
		open: true,
		position: { x: 24, y: 24 },
		items,
		header: richHeader,
		width: 280,
		onClose: () => {},
	},
};

export const TitleFallback: Story = {
	args: {
		open: true,
		position: { x: 24, y: 24 },
		title: "orders",
		items: [
			{ kind: "action", id: "a", label: "Action simple" },
			{ kind: "action", id: "b", label: "Autre action" },
		],
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
				hint: "get resource_software_link limit 100",
			},
			{
				kind: "action",
				id: "short",
				label: "Court",
				hint: <Kbd size="xs">⌘K</Kbd>,
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
					header={richHeader}
					width={280}
				/>
			</div>
		);
	},
};
