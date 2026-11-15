import { Box, Kbd, Text } from "@mantine/core";
import {
	ColorDot,
	ContextMenu,
	type ContextMenuItem,
	KindBadge,
	showNotification,
	TypePill
} from "@sqlnest/design-system";
import {
	IconAsterisk,
	IconCircleDashed,
	IconColumnInsertRight,
	IconColumnRemove,
	IconCopy,
	IconCursorText,
	IconEraser,
	IconEyeOff,
	IconHash,
	IconInfoCircle,
	IconPencil,
	IconSquareDashed,
	IconSquareOff,
	IconTable,
	IconTerminal2,
	IconTransform
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useCanvasData, useCanvasUI } from "./canvas/CanvasContext";
import { colorFor } from "./colors";
import type { Frame } from "./frames";
import type { SchemaModel } from "./schema-model";

const ICON = { size: 14, stroke: 1.8 } as const;

interface Props {
	readonly open: boolean;
	readonly position: { x: number; y: number };
	readonly tableName: string;
	/** Champ cliqué : ses gestes passent en tête du menu (ADR-039 D2). */
	readonly field?: string;
	readonly schema: SchemaModel;
	/** Label du schéma cible (postgres → `public`, mongo → undefined). Affiché
	 * dans la ligne metadata du header. */
	readonly schemaLabel?: string | undefined;
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
 * Header riche : ColorDot (couleur groupe) + nom en gros + metadata
 * (`{schemaLabel} · N champs · N FK`) + KindBadge (DÉCLARÉ / INFÉRÉ).
 * Rendu via le slot `header` du DS ContextMenu — permet une identité
 * visuelle immédiate de la table sans lire l'item du dessous.
 *
 * Items groupés en sections séparées par des dividers :
 *   0. COLONNE, quand le clic vise un champ — renommer, type, nullabilité,
 *      défaut, supprimer (ADR-039 D2) ; l'en-tête montre alors la colonne.
 *   1. Actions primaires — Ouvrir éditeur (actif, défaut Enter), Voir 100
 *      lignes, Détails.
 *   2. STRUCTURE — ajouter une colonne, frame, voir relations (count).
 *   3. Meta/canvas — copier, masquer.
 *
 * Hints = Kbd shortcuts (`⌘C`, `⌘H`, `I`, `↵`, `get {name}`) — cosmétiques
 * pour l'apprentissage (afficher que ces actions ont des raccourcis). Le
 * wiring des raccourcis globaux (⌘C copier le nom de la table hover, etc.)
 * est une feature séparée à décider — conflicts natifs macOS à gérer.
 */
export function CanvasContextMenu({
	open,
	position,
	tableName,
	field,
	schema,
	schemaLabel,
	frames,
	frameOfTable,
	onClose,
	onHide,
	onFocus,
	onAddToFrame,
	onRemoveFromFrame
}: Props) {
	const navigate = useNavigate();
	const { connectionId } = useCanvasData();
	const { setGesture } = useCanvasUI();
	const collection = schema.collections.find((c) => c.name === tableName);
	const column =
		field !== undefined
			? collection?.fields.find((f) => f.name === field)
			: undefined;

	const goToEditor = (source: string, autorun: boolean) => {
		void navigate({
			to: "/canvas/$connId/query",
			params: { connId: connectionId },
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

	// ─── Header ──────────────────────────────────────────────────────────
	// Metadata : schema (si postgres) · N champs · N FK. `FK` compte les
	// relations DONT la table est source OU cible (les 2 sens comptent pour
	// « avec combien d'autres tables je suis reliée »).
	const fieldCount = collection?.fields.length ?? 0;
	const fkCount = schema.relations.filter(
		(r) => r.from.collection === tableName || r.to.collection === tableName
	).length;
	const kind: "declared" | "inferred" =
		collection?.source === "inferred" ? "inferred" : "declared";
	const color = colorFor(tableName);

	const metaParts = [
		schemaLabel,
		`${fieldCount} champ${fieldCount > 1 ? "s" : ""}`,
		`${fkCount} FK`
	].filter(Boolean);

	const header = (
		<Box
			style={{
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "6px 10px"
			}}
		>
			<ColorDot color={color.border} size="md" />
			<Box style={{ flex: 1, minWidth: 0 }}>
				<Text
					fw={600}
					size="xs"
					style={{
						color: "var(--sqlnest-text-primary)",
						lineHeight: 1.3,
						overflow: "hidden",
						textOverflow: "ellipsis",
						whiteSpace: "nowrap"
					}}
				>
					{tableName}
				</Text>
				<Text
					size="10px"
					ff="monospace"
					style={{
						color: "var(--sqlnest-text-tertiary)",
						lineHeight: 1.3
					}}
				>
					{metaParts.join(" · ")}
				</Text>
			</Box>
			<KindBadge kind={kind} />
		</Box>
	);
	const columnHeader =
		column !== undefined ? (
			<Box
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: 8,
					padding: "5px 10px",
					borderTop: "1px solid var(--sqlnest-border-subtle)"
				}}
			>
				<Text
					size="xs"
					ff="monospace"
					style={{
						color: "var(--sqlnest-text-primary)",
						overflow: "hidden",
						textOverflow: "ellipsis",
						whiteSpace: "nowrap"
					}}
				>
					{column.name}
				</Text>
				<TypePill type={column.type} nullable={column.nullable} />
			</Box>
		) : null;

	// ─── Frame section (STRUCTURE) ───────────────────────────────────────
	// Item Frame caché si aucun frame n'existe et table pas dans un frame
	// (le user crée un frame via F/lasso, pas via ce menu).
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

	// ─── Colonne cliquée ─────────────────────────────────────────────────
	const columnItems: ContextMenuItem[] =
		column === undefined
			? []
			: [
					{ kind: "section-label", label: "COLONNE" },
					{
						kind: "action",
						id: "rename-column",
						label: "Renommer",
						icon: <IconCursorText {...ICON} />,
						onClick: () =>
							setGesture({
								kind: "rename-column",
								table: tableName,
								column: column.name
							})
					},
					{
						kind: "action",
						id: "set-type",
						label: "Changer le type",
						icon: <IconTransform {...ICON} />,
						onClick: () =>
							setGesture({
								kind: "set-type",
								table: tableName,
								column: column.name
							})
					},
					{
						kind: "action",
						id: "set-nullability",
						label: column.nullable ? "Rendre obligatoire" : "Rendre nullable",
						icon: column.nullable ? (
							<IconAsterisk {...ICON} />
						) : (
							<IconCircleDashed {...ICON} />
						),
						onClick: () =>
							setGesture({
								kind: "set-nullability",
								table: tableName,
								column: column.name,
								nullable: !column.nullable
							})
					},
					{
						kind: "action",
						id: "set-default",
						label: column.hasDefault
							? "Changer le défaut"
							: "Ajouter un défaut",
						icon: <IconPencil {...ICON} />,
						onClick: () =>
							setGesture({
								kind: "set-default",
								table: tableName,
								column: column.name
							})
					},
					...(column.hasDefault
						? [
								{
									kind: "action" as const,
									id: "drop-default",
									label: "Retirer le défaut",
									icon: <IconEraser {...ICON} />,
									onClick: () =>
										setGesture({
											kind: "drop-default",
											table: tableName,
											column: column.name
										})
								}
							]
						: []),
					{
						kind: "action",
						id: "drop-column",
						label: "Supprimer la colonne",
						icon: <IconColumnRemove {...ICON} />,
						danger: true,
						onClick: () =>
							setGesture({
								kind: "drop-column",
								table: tableName,
								column: column.name
							})
					},
					{ kind: "divider" }
				];

	// ─── Items ───────────────────────────────────────────────────────────
	const items: ContextMenuItem[] = [
		...columnItems,
		{
			kind: "action",
			id: "open",
			label: "Ouvrir dans l'éditeur",
			icon: <IconTerminal2 {...ICON} />,
			hint: <Kbd size="xs">get {tableName}</Kbd>,
			active: true,
			onClick: () => goToEditor(`get ${tableName}`, false)
		},
		{
			kind: "action",
			id: "data",
			label: "Voir les 100 premières lignes",
			icon: <IconTable {...ICON} />,
			hint: <Kbd size="xs">↵</Kbd>,
			onClick: () => goToEditor(`get ${tableName} limit 100`, true)
		},
		{
			kind: "action",
			id: "details",
			label: "Détails",
			icon: <IconInfoCircle {...ICON} />,
			hint: <Kbd size="xs">I</Kbd>,
			onClick: () => onFocus(tableName)
		},
		{ kind: "divider" },
		{ kind: "section-label", label: "STRUCTURE" },
		{
			kind: "action",
			id: "add-column",
			label: "Ajouter une colonne",
			icon: <IconColumnInsertRight {...ICON} />,
			onClick: () => setGesture({ kind: "add-column", table: tableName })
		},
		...(frameItem ? [frameItem] : []),
		{
			kind: "action",
			id: "relations",
			label: "Voir les relations",
			icon: <IconHash {...ICON} />,
			hint: fkCount > 0 ? String(fkCount) : undefined,
			// Même comportement que Détails pour l'instant — future itération :
			// scroll le drawer TableDetails à la section Relations directement.
			onClick: () => onFocus(tableName)
		},
		{ kind: "divider" },
		{
			kind: "action",
			id: "copy",
			label: "Copier le nom",
			icon: <IconCopy {...ICON} />,
			hint: <Kbd size="xs">⌘C</Kbd>,
			onClick: () => void copyName()
		},
		{
			kind: "action",
			id: "hide",
			label: "Masquer sur le canvas",
			icon: <IconEyeOff {...ICON} />,
			hint: <Kbd size="xs">⌘H</Kbd>,
			onClick: () => onHide(tableName)
		}
	];

	return (
		<ContextMenu
			open={open}
			position={position}
			onClose={onClose}
			items={items}
			header={
				columnHeader !== null ? (
					<>
						{header}
						{columnHeader}
					</>
				) : (
					header
				)
			}
			width={280}
		/>
	);
}
