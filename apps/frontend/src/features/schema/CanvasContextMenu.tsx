import {
	ContextMenu,
	type ContextMenuItem,
	showNotification
} from "@sqlnest/design-system";
import {
	IconCopy,
	IconEditCircle,
	IconEyeOff,
	IconInfoCircle,
	IconSquareDashed,
	IconSquareOff,
	IconTable
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import type { Frame } from "./frames";

const ICON = { size: 15, stroke: 1.8 } as const;

interface Props {
	readonly open: boolean;
	readonly position: { x: number; y: number };
	readonly tableName: string;
	readonly frames: readonly Frame[];
	readonly frameOfTable?: Frame | null;
	readonly onClose: () => void;
	readonly onHide: (tableName: string) => void;
	readonly onFocus: (tableName: string) => void;
	readonly onAddToFrame?: (frameKey: string) => void;
	readonly onRemoveFromFrame?: () => void;
}

/**
 * Menu contextuel du canvas — actions pour une table.
 *
 * Ordre pensé pour la priorité d'usage :
 *   1. Détails         — découverte : « qu'est-ce que c'est ? »
 *   2. Ouvrir éditeur  — écrire une requête à partir de la table
 *   3. Voir données    — lire les 100 premières lignes direct
 *   ─ divider ─
 *   4. Frame           — regrouper / dégrouper (action directe si dans un
 *                        frame, submenu sinon ; item complètement caché
 *                        si aucun frame n'existe encore)
 *   ─ divider ─
 *   5. Copier          — meta
 *   6. Masquer         — nettoyage visuel canvas
 *
 * Labels : terses, action + éventuellement quantité intégrée. Pas de
 * sub-messages descriptifs (« get resource_software_link », « limit 100 »)
 * — ces hints étaient de la note-de-service pour développeur, pas de
 * l'aide utilisateur.
 */
export function CanvasContextMenu({
	open,
	position,
	tableName,
	frames,
	frameOfTable,
	onClose,
	onHide,
	onFocus,
	onAddToFrame,
	onRemoveFromFrame
}: Props) {
	const navigate = useNavigate();

	const goToEditor = (source: string, autorun: boolean) => {
		void navigate({
			to: "/query",
			search: autorun ? { source, autorun: 1 } : { source }
		});
	};

	const copyName = async () => {
		try {
			await navigator.clipboard.writeText(tableName);
			showNotification({
				title: "Copié",
				message: tableName,
				color: "blue",
				autoClose: 1500
			});
		} catch {
			showNotification({
				title: "Copie impossible",
				message: "Le presse-papiers a refusé l'accès.",
				color: "red",
				autoClose: 2500
			});
		}
	};

	// Frames disponibles = ceux dont la table n'est PAS déjà membre. On
	// n'affiche l'item Frame que si un choix utile est possible : soit la
	// table est dans un frame (→ action « Retirer »), soit d'autres frames
	// existent (→ submenu « Ajouter à »). Sinon on cache — l'utilisateur
	// crée un frame via F/lasso, pas via ce menu.
	const otherFrames = frames.filter(
		(f) => !frameOfTable || f.key !== frameOfTable.key
	);
	const showFrameSection =
		(frameOfTable && onRemoveFromFrame) ||
		(otherFrames.length > 0 && onAddToFrame);

	const frameItem: ContextMenuItem | null = !showFrameSection
		? null
		: frameOfTable && !onAddToFrame
			? {
					kind: "action",
					id: "frame:remove",
					label: `Retirer de « ${frameOfTable.label} »`,
					icon: <IconSquareOff {...ICON} />,
					onClick: () => onRemoveFromFrame?.()
				}
			: {
					kind: "submenu",
					id: "frame",
					label: frameOfTable ? "Changer de frame" : "Ajouter à un frame",
					icon: <IconSquareDashed {...ICON} />,
					items: [
						...otherFrames.map((f) => ({
							kind: "action" as const,
							id: `frame:${f.key}`,
							label: f.label,
							onClick: () => onAddToFrame?.(f.key)
						})),
						...(frameOfTable && onRemoveFromFrame
							? [
									{ kind: "divider" as const },
									{
										kind: "action" as const,
										id: "frame:remove",
										label: `Retirer de « ${frameOfTable.label} »`,
										icon: <IconSquareOff {...ICON} />,
										onClick: () => onRemoveFromFrame()
									}
								]
							: [])
					]
				};

	const items: ContextMenuItem[] = [
		{
			kind: "action",
			id: "details",
			label: "Détails",
			icon: <IconInfoCircle {...ICON} />,
			onClick: () => onFocus(tableName)
		},
		{
			kind: "action",
			id: "open",
			label: "Ouvrir dans l'éditeur",
			icon: <IconEditCircle {...ICON} />,
			onClick: () => goToEditor(`get ${tableName}`, false)
		},
		{
			kind: "action",
			id: "data",
			label: "Voir les 100 premières lignes",
			icon: <IconTable {...ICON} />,
			onClick: () => goToEditor(`get ${tableName} | limit 100`, true)
		},
		...(frameItem
			? [{ kind: "divider" as const }, frameItem]
			: []),
		{ kind: "divider" },
		{
			kind: "action",
			id: "copy",
			label: "Copier le nom",
			icon: <IconCopy {...ICON} />,
			onClick: () => void copyName()
		},
		{
			kind: "action",
			id: "hide",
			label: "Masquer",
			icon: <IconEyeOff {...ICON} />,
			onClick: () => onHide(tableName)
		}
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
