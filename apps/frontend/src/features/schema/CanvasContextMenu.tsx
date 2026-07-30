import {
	ContextMenu,
	type ContextMenuItem,
	showNotification,
} from "@sqlnest/design-system";
import {
	IconCopy,
	IconEditCircle,
	IconEyeOff,
	IconInfoCircle,
	IconSquareDashed,
	IconTable
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import type { Frame } from "./frames";

const ICON = { size: 14, stroke: 1.8 } as const;

interface Props {
	readonly open: boolean;
	readonly position: { x: number; y: number };
	readonly tableName: string;
	readonly frames: readonly Frame[];
	readonly onClose: () => void;
	readonly onHide: (tableName: string) => void;
	readonly onFocus: (tableName: string) => void;
}

/** Menu contextuel du canvas Schéma (tour 1b) — actions pour une table. */
export function CanvasContextMenu({
	open,
	position,
	tableName,
	frames,
	onClose,
	onHide,
	onFocus,
}: Props) {
	const navigate = useNavigate();

	const goToEditor = (source: string, autorun: boolean) => {
		void navigate({
			to: "/query",
			search: autorun ? { source, autorun: 1 } : { source },
		});
	};

	const copyName = async () => {
		try {
			await navigator.clipboard.writeText(tableName);
			showNotification({
				title: "Copié",
				message: tableName,
				color: "blue",
				autoClose: 1500,
			});
		} catch {
			showNotification({
				title: "Copie impossible",
				message: "Le presse-papiers a refusé l'accès.",
				color: "red",
				autoClose: 2500,
			});
		}
	};

	const frameNotAvailable = (frameLabel: string) =>
		showNotification({
			title: `Ajouter à « ${frameLabel} »`,
			message: "Bientôt disponible.",
			color: "amber",
			autoClose: 2000,
		});

	const items: ContextMenuItem[] = [
		{
			kind: "action",
			id: "open",
			label: "Ouvrir dans l'éditeur",
			icon: <IconEditCircle {...ICON} />,
			hint: `get ${tableName}`,
			active: true,
			onClick: () => goToEditor(`get ${tableName}`, false),
		},
		{
			kind: "action",
			id: "data",
			label: "Voir les données",
			icon: <IconTable {...ICON} />,
			hint: "limit 100",
			onClick: () => goToEditor(`get ${tableName} | limit 100`, true),
		},
		{
			kind: "submenu",
			id: "frame",
			label: "Ajouter à un frame",
			icon: <IconSquareDashed {...ICON} />,
			items: [
				...frames.map((f) => ({
					kind: "action" as const,
					id: `frame:${f.key}`,
					label: f.label,
					onClick: () => frameNotAvailable(f.label),
				})),
				...(frames.length > 0 ? [{ kind: "divider" as const }] : []),
				{
					kind: "action",
					id: "frame:new",
					label: "Nouveau frame…",
					onClick: () =>
						showNotification({
							title: "Nouveau frame",
							message: "Bientôt disponible.",
							color: "amber",
							autoClose: 2000,
						}),
				},
			],
		},
		{ kind: "divider" },
		{
			kind: "action",
			id: "copy",
			label: "Copier le nom",
			icon: <IconCopy {...ICON} />,
			onClick: () => void copyName(),
		},
		{
			kind: "action",
			id: "hide",
			label: "Masquer",
			icon: <IconEyeOff {...ICON} />,
			onClick: () => onHide(tableName),
		},
		{
			kind: "action",
			id: "details",
			label: "Détails",
			icon: <IconInfoCircle {...ICON} />,
			onClick: () => onFocus(tableName),
		},
	];

	return (
		<ContextMenu
			open={open}
			position={position}
			onClose={onClose}
			items={items}
			title={tableName}
		/>
	);
}
