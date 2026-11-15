import { Box, Text } from "@mantine/core";
import {
	ContextMenu,
	type ContextMenuItem,
	KindBadge
} from "@sqlnest/design-system";
import { IconLink, IconUnlink } from "@tabler/icons-react";
import { useCanvasUI } from "./canvas/CanvasContext";
import type { Relation, SchemaModel } from "./schema-model";

const ICON = { size: 14, stroke: 1.8 } as const;

interface Props {
	readonly position: { x: number; y: number };
	readonly relation: Relation;
	readonly schema: SchemaModel;
	readonly onClose: () => void;
}

/** Relation sur une colonne de chaque côté, la seule forme que les gestes écrivent. */
function singleColumns(
	relation: Relation
): { readonly column: string; readonly targetColumn: string } | undefined {
	const [column, ...moreFrom] = relation.from.fields;
	const [targetColumn, ...moreTo] = relation.to.fields;
	return column !== undefined &&
		targetColumn !== undefined &&
		moreFrom.length === 0 &&
		moreTo.length === 0
		? { column, targetColumn }
		: undefined;
}

/**
 * Menu d'une arête (ADR-039 D2) : supprimer la FK, ou déclarer en base un
 * lien qui n'est qu'inféré.
 */
export function RelationContextMenu({
	position,
	relation,
	schema,
	onClose
}: Props) {
	const { setGesture } = useCanvasUI();
	const columns = singleColumns(relation);
	const table = relation.from.collection;
	const targetTable = relation.to.collection;
	const declared = relation.origin === "foreign-key";
	const ref =
		declared && columns !== undefined
			? schema.refs?.find(
					(r) =>
						r.fromCollection === table &&
						r.fromColumn === columns.column &&
						r.toCollection === targetTable &&
						r.toColumn === columns.targetColumn
				)
			: undefined;

	const items: ContextMenuItem[] = [
		...(ref !== undefined && columns !== undefined
			? [
					{
						kind: "action" as const,
						id: "drop-ref",
						label: "Supprimer la relation",
						icon: <IconUnlink {...ICON} />,
						danger: true,
						onClick: () =>
							setGesture({
								kind: "drop-ref",
								table,
								targetTable,
								...columns,
								name: ref.name
							})
					}
				]
			: []),
		...(!declared && columns !== undefined
			? [
					{
						kind: "action" as const,
						id: "add-ref",
						label: "Déclarer la relation",
						icon: <IconLink {...ICON} />,
						onClick: () =>
							setGesture({ kind: "add-ref", table, targetTable, ...columns })
					}
				]
			: [])
	];

	const header = (
		<Box
			style={{
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "6px 10px"
			}}
		>
			<Text
				size="xs"
				ff="monospace"
				style={{
					flex: 1,
					minWidth: 0,
					color: "var(--sqlnest-text-primary)",
					lineHeight: 1.4,
					overflowWrap: "anywhere"
				}}
			>
				{table}.{relation.from.fields.join(", ")} → {targetTable}.
				{relation.to.fields.join(", ")}
			</Text>
			<KindBadge kind={declared ? "declared" : "inferred"} />
		</Box>
	);

	return (
		<ContextMenu
			open
			position={position}
			onClose={onClose}
			items={items}
			header={header}
			width={280}
		/>
	);
}
