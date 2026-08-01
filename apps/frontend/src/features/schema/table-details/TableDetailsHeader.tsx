import { ActionIcon, Box, Button, Menu, Text } from "@mantine/core";
import { IconDots, IconMenu2 } from "@tabler/icons-react";
import { ColorDot, KindBadge, showNotification } from "@sqlnest/design-system";

interface TableDetailsHeaderProps {
	readonly tableName: string;
	readonly fieldCount: number;
	readonly totalRelations: number;
	readonly inferred: boolean;
	readonly frameLabel: string | null;
	readonly borderColor: string;
	readonly onGoToEditor: () => void;
}

/**
 * En-tête du drawer TableDetails — titre (dot coloré + nom + kind badge),
 * meta (fields · relations · frame), et rangée d'actions (get + hamburger +
 * kebab). Les actions autres que "get" sont des placeholders `soon()`.
 */
export function TableDetailsHeader({
	tableName,
	fieldCount,
	totalRelations,
	inferred,
	frameLabel,
	borderColor,
	onGoToEditor
}: TableDetailsHeaderProps) {
	const soon = (title: string) =>
		showNotification({
			title,
			message: "Bientôt disponible.",
			color: "amber",
			autoClose: 2000
		});

	return (
		<>
			{/* Titre : dot coloré + name + KindBadge */}
			<Box style={{ padding: "10px 12px 2px" }}>
				<Box
					style={{
						display: "flex",
						alignItems: "center",
						gap: 8,
						minWidth: 0
					}}
				>
					<ColorDot color={borderColor} size="md" />
					<span
						style={{
							fontSize: 15,
							fontWeight: 700,
							color: "var(--mantine-color-slate-9)",
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
							minWidth: 0
						}}
						title={tableName}
					>
						{tableName}
					</span>
					<KindBadge kind={inferred ? "inferred" : "declared"} />
				</Box>
				<Text
					size="xs"
					c="dimmed"
					mt={2}
					style={{ fontSize: 10.5, letterSpacing: 0.1 }}
				>
					{fieldCount} champs · {totalRelations} relations
					{frameLabel !== null ? (
						<>
							{" · frame "}
							<span
								style={{
									color: "var(--mantine-color-slate-7)",
									fontWeight: 600,
									textTransform: "uppercase"
								}}
							>
								{frameLabel}
							</span>
						</>
					) : null}
				</Text>
			</Box>

			{/* Actions : get X + hamburger + kebab */}
			<Box
				style={{
					display: "flex",
					alignItems: "center",
					gap: 6,
					padding: "8px 12px 6px"
				}}
			>
				<Button
					variant="filled"
					color="dark"
					radius="md"
					size="xs"
					onClick={onGoToEditor}
					style={{
						flex: 1,
						minWidth: 0,
						fontFamily: "var(--mantine-font-family-monospace)",
						overflow: "hidden"
					}}
					styles={{
						label: {
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap"
						}
					}}
					title={`get ${tableName}`}
				>
					{`>_ get ${tableName}`}
				</Button>
				<ActionIcon
					variant="default"
					size="md"
					radius="md"
					onClick={() => soon("Vue tabulaire")}
					aria-label="Vue tabulaire"
				>
					<IconMenu2 size={14} />
				</ActionIcon>
				<Menu shadow="md" position="bottom-end" withinPortal>
					<Menu.Target>
						<ActionIcon
							variant="default"
							size="md"
							radius="md"
							aria-label="Plus d'actions"
						>
							<IconDots size={14} />
						</ActionIcon>
					</Menu.Target>
					<Menu.Dropdown>
						<Menu.Item onClick={() => soon("Copier le nom")}>
							Copier le nom
						</Menu.Item>
						<Menu.Item onClick={() => soon("Exporter le schéma")}>
							Exporter le schéma
						</Menu.Item>
						<Menu.Item onClick={() => soon("Masquer la table")} color="red">
							Masquer la table
						</Menu.Item>
					</Menu.Dropdown>
				</Menu>
			</Box>
		</>
	);
}
