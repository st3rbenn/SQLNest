import { ActionIcon, Box } from "@mantine/core";
import { IconPlus, IconX } from "@tabler/icons-react";
import { useCanvasData, useCanvasUI } from "../canvas/CanvasContext";
import { canApply } from "../editor/editMode";
import type { Collection } from "../schema-model";
import { SectionTitle } from "./SectionTitle";

const ICON = { size: 12, stroke: 2 } as const;

/**
 * Section INDEX du drawer TableDetails : index et contraintes d'unicité de la
 * table, clé primaire exclue. En édition, « + » en ajoute un et la croix d'une
 * ligne le supprime (ADR-039 D2).
 */
export function TableDetailsIndexes({ table }: { readonly table: Collection }) {
	const { editMode } = useCanvasData();
	const { setGesture } = useCanvasUI();
	const editable = canApply(editMode);
	const indexes = table.indexes ?? [];
	if (indexes.length === 0 && !editable) return null;

	return (
		<>
			<Box
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					paddingRight: 8
				}}
			>
				<SectionTitle>Index</SectionTitle>
				{editable ? (
					<ActionIcon
						variant="subtle"
						color="gray"
						size="xs"
						aria-label="Ajouter un index"
						onClick={() => setGesture({ kind: "add-index", table: table.name })}
					>
						<IconPlus {...ICON} />
					</ActionIcon>
				) : null}
			</Box>
			{indexes.map((index) => (
				<Box
					key={index.name}
					title={index.name}
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 8,
						padding: "3px 8px 3px 12px",
						fontSize: "var(--sqlnest-font-size-12)",
						color: "var(--sqlnest-text-secondary)"
					}}
				>
					<span
						style={{
							minWidth: 0,
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap"
						}}
					>
						{index.columns.join(", ")}
					</span>
					<span
						style={{
							display: "flex",
							alignItems: "center",
							gap: 6,
							color: "var(--sqlnest-text-tertiary)",
							fontFamily: "var(--mantine-font-family-monospace)",
							fontSize: "var(--sqlnest-font-size-11)",
							whiteSpace: "nowrap"
						}}
					>
						{index.unique ? "unique" : null}
						{editable ? (
							<ActionIcon
								variant="subtle"
								color="gray"
								size="xs"
								aria-label={`Supprimer l'index ${index.name}`}
								onClick={() =>
									setGesture({
										kind: "drop-index",
										table: table.name,
										name: index.name
									})
								}
							>
								<IconX {...ICON} />
							</ActionIcon>
						) : null}
					</span>
				</Box>
			))}
		</>
	);
}
