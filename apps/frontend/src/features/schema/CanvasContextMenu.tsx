import {
	ContextMenu,
	type ContextMenuItem,
	showNotification,
} from "@sqlnest/design-system";
import { useNavigate } from "@tanstack/react-router";
import type { Frame } from "./frames";

const IconOpen = () => (
	<svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
		<title>Ouvrir</title>
		<path d="M4 4h16v16H4z" />
		<path d="M9 9h6v6H9z" />
	</svg>
);
const IconData = () => (
	<svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
		<title>Données</title>
		<path d="M4 6h16M4 12h16M4 18h16" />
	</svg>
);
const IconFrame = () => (
	<svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
		<title>Frame</title>
		<rect x={4} y={4} width={16} height={16} rx={2} strokeDasharray="3 3" />
	</svg>
);
const IconCopy = () => (
	<svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
		<title>Copier</title>
		<rect x={9} y={9} width={11} height={11} rx={2} />
		<path d="M15 9V5H4v11h4" />
	</svg>
);
const IconHide = () => (
	<svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
		<title>Masquer</title>
		<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12z" />
		<circle cx={12} cy={12} r={3} />
		<path d="M4 4l16 16" />
	</svg>
);
const IconDetails = () => (
	<svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
		<title>Détails</title>
		<circle cx={12} cy={12} r={9} />
		<path d="M12 8v4l3 2" />
	</svg>
);

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
			icon: <IconOpen />,
			hint: `get ${tableName}`,
			active: true,
			onClick: () => goToEditor(`get ${tableName}`, false),
		},
		{
			kind: "action",
			id: "data",
			label: "Voir les données",
			icon: <IconData />,
			hint: "limit 100",
			onClick: () => goToEditor(`get ${tableName} | limit 100`, true),
		},
		{
			kind: "submenu",
			id: "frame",
			label: "Ajouter à un frame",
			icon: <IconFrame />,
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
			icon: <IconCopy />,
			onClick: () => void copyName(),
		},
		{
			kind: "action",
			id: "hide",
			label: "Masquer",
			icon: <IconHide />,
			onClick: () => onHide(tableName),
		},
		{
			kind: "action",
			id: "details",
			label: "Détails",
			icon: <IconDetails />,
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
