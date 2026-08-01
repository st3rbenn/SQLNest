import { ActionIcon, Box, Menu, Text, UnstyledButton } from "@mantine/core";
import {
	IconCheck,
	IconChevronRight,
	IconDots,
	IconX
} from "@tabler/icons-react";
import { ColorDot, showNotification } from "@sqlnest/design-system";
import { useState } from "react";
import { colorFor } from "./colors";
import type { Frame } from "./frames";

interface FrameDetailsProps {
	readonly frame: Frame;
	readonly onSelectTable: (name: string) => void;
	readonly onRename: (label: string) => void;
	readonly onDelete: () => void;
}

/**
 * Vue « détails d'un frame » — rendue dans le drawer gauche à la place de
 * l'arborescence quand `focusFrameKey` est set. Composant présentationnel :
 * pas de wrapper positionné, header, ni footer (fournis par `SidebarDrawer`
 * du parent). Le back button (« ← Schéma ») est géré côté `SchemaCanvas` —
 * il clear `focusFrameKey`, ce qui restaure l'arborescence.
 */
export function FrameDetails({
	frame,
	onSelectTable,
	onRename,
	onDelete
}: FrameDetailsProps) {
	const hueColor = `hsl(${frame.hue}, 55%, 55%)`;

	// Rename inline : titre remplacé par un input auto-focus quand `editing`.
	// Enter/check commit, Escape/cross annule. Un `draft` local évite d'écrire
	// dans le state parent à chaque keystroke.
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(frame.label);
	const startEdit = () => {
		setDraft(frame.label);
		setEditing(true);
	};
	const commitEdit = () => {
		const trimmed = draft.trim();
		if (trimmed !== "" && trimmed !== frame.label) onRename(trimmed);
		setEditing(false);
	};
	const cancelEdit = () => {
		setDraft(frame.label);
		setEditing(false);
	};

	const soon = (title: string) =>
		showNotification({
			title,
			message: "Bientôt disponible.",
			color: "amber",
			autoClose: 2000
		});

	return (
		<Box>
			{/* Titre : carré coloré + nom du frame en uppercase + kebab menu.
			 * En mode rename : input auto-focus + check/cross à droite (Enter
			 * commit, Escape annule). */}
			<Box style={{ padding: "10px 12px 2px" }}>
				<Box
					style={{
						display: "flex",
						alignItems: "center",
						gap: 8,
						minWidth: 0
					}}
				>
					<span
						style={{
							display: "inline-block",
							width: 12,
							height: 12,
							borderRadius: 4,
							background: hueColor,
							flexShrink: 0
						}}
					/>
					{editing ? (
						<>
							<input
								// biome-ignore lint/a11y/noAutofocus: pattern classique inline-edit, focus déclenché par un geste user.
								autoFocus
								value={draft}
								onChange={(e) => setDraft(e.currentTarget.value)}
								onKeyDown={(e) => {
									e.stopPropagation();
									if (e.key === "Enter") {
										e.preventDefault();
										commitEdit();
									} else if (e.key === "Escape") {
										e.preventDefault();
										cancelEdit();
									}
								}}
								onFocus={(e) => e.currentTarget.select()}
								aria-label="Nom du frame"
								style={{
									flex: 1,
									minWidth: 0,
									fontSize: 15,
									fontWeight: 700,
									textTransform: "uppercase",
									letterSpacing: 0.3,
									color: "var(--mantine-color-slate-9)",
									padding: "4px 8px",
									border: `1.5px solid ${hueColor}`,
									borderRadius: 6,
									outline: "none",
									fontFamily: "inherit",
									background: "#fff"
								}}
							/>
							<ActionIcon
								variant="filled"
								color="green"
								size="sm"
								radius="md"
								onClick={commitEdit}
								aria-label="Valider le renommage"
							>
								<IconCheck size={14} />
							</ActionIcon>
							<ActionIcon
								variant="default"
								size="sm"
								radius="md"
								onClick={cancelEdit}
								aria-label="Annuler le renommage"
							>
								<IconX size={14} />
							</ActionIcon>
						</>
					) : (
						<>
							<span
								style={{
									fontSize: 15,
									fontWeight: 700,
									textTransform: "uppercase",
									letterSpacing: 0.3,
									color: "var(--mantine-color-slate-9)",
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap",
									minWidth: 0,
									flex: 1
								}}
								title={frame.label}
							>
								{frame.label}
							</span>
							<Menu shadow="md" position="bottom-end" withinPortal>
								<Menu.Target>
									<ActionIcon
										variant="default"
										size="sm"
										radius="md"
										aria-label="Plus d'actions"
									>
										<IconDots size={14} />
									</ActionIcon>
								</Menu.Target>
								<Menu.Dropdown>
									<Menu.Item onClick={startEdit}>Renommer</Menu.Item>
									<Menu.Item onClick={() => soon("Changer la couleur")}>
										Changer la couleur
									</Menu.Item>
									<Menu.Item onClick={onDelete} color="red">
										Supprimer le frame
									</Menu.Item>
								</Menu.Dropdown>
							</Menu>
						</>
					)}
				</Box>
				<Text
					size="xs"
					c="dimmed"
					mt={2}
					style={{ fontSize: 10.5, letterSpacing: 0.1 }}
				>
					{frame.collections.length} table
					{frame.collections.length > 1 ? "s" : ""}
				</Text>
			</Box>

			{/* Section TABLES */}
			<Text
				px={12}
				pt={12}
				pb={4}
				size="xs"
				fw={700}
				c="dimmed"
				style={{
					textTransform: "uppercase",
					letterSpacing: 0.5,
					fontSize: 9.5
				}}
			>
				Tables
			</Text>
			{frame.collections.length === 0 ? (
				<Text px={12} py={8} size="xs" c="dimmed" fs="italic">
					Frame vide. Glisse une table dedans pour l'ajouter.
				</Text>
			) : (
				frame.collections
					.slice()
					.sort()
					.map((name) => {
						const c = colorFor(name);
						return (
							<UnstyledButton
								key={name}
								onClick={() => onSelectTable(name)}
								title={`Aller à ${name}`}
								style={{
									display: "flex",
									alignItems: "center",
									gap: 8,
									width: "100%",
									padding: "6px 12px",
									fontSize: 12.5,
									color: "var(--mantine-color-slate-8)",
									textAlign: "left",
									background: "transparent",
									transition: "background 100ms ease-out"
								}}
							>
								<ColorDot color={c.border} size="sm" />
								<span
									style={{
										flex: 1,
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap"
									}}
								>
									{name}
								</span>
								<IconChevronRight
									size={12}
									stroke={2}
									style={{
										color: "var(--mantine-color-slate-4)",
										flexShrink: 0
									}}
								/>
							</UnstyledButton>
						);
					})
			)}
		</Box>
	);
}
