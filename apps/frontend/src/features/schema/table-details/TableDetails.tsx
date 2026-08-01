import { Box } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { colorFor } from "../colors";
import type { SchemaModel } from "../schema-model";
import { TableDetailsFields } from "./TableDetailsFields";
import { TableDetailsHeader } from "./TableDetailsHeader";
import { TableDetailsRelations } from "./TableDetailsRelations";
import { TableDetailsSuggestion } from "./TableDetailsSuggestion";

interface TableDetailsProps {
	readonly schema: SchemaModel;
	readonly tableName: string;
	readonly frameLabel: string | null;
	readonly onSelect: (id: string) => void;
}

/**
 * Vue « détails de table » — rendue **dans** le drawer gauche à la place de
 * l'arborescence quand une table est focus. Composant présentationnel : pas
 * de wrapper positionné, header, ni footer (fournis par `SidebarDrawer` du
 * parent). Le back button (« ← Schéma ») est géré côté `SchemaCanvas` — il
 * clear le focus, ce qui restaure l'arborescence dans le même drawer.
 *
 * Orchestre 4 sous-blocs colocalisés : header (titre + actions), champs,
 * relations (sortantes + entrantes), et suggestion IA (placeholder).
 */
export function TableDetails({
	schema,
	tableName,
	frameLabel,
	onSelect
}: TableDetailsProps) {
	const table = schema.collections.find((c) => c.name === tableName);
	const navigate = useNavigate();

	if (table === undefined) return null;

	const inferred = table.source === "inferred";
	const color = colorFor(table.name);
	const pk = new Set(table.primaryKey ?? []);
	const outgoing = schema.relations.filter(
		(r) => r.from.collection === tableName
	);
	const incoming = schema.relations.filter(
		(r) => r.to.collection === tableName
	);
	const totalRelations = outgoing.length + incoming.length;

	const goToEditor = () => {
		void navigate({
			to: "/query",
			search: { source: table.name, autorun: 1 }
		});
	};

	return (
		<Box>
			<TableDetailsHeader
				tableName={table.name}
				fieldCount={table.fields.length}
				totalRelations={totalRelations}
				inferred={inferred}
				frameLabel={frameLabel}
				borderColor={color.border}
				onGoToEditor={goToEditor}
			/>
			<TableDetailsFields fields={table.fields} primaryKey={pk} />
			<TableDetailsRelations
				outgoing={outgoing}
				incoming={incoming}
				onSelect={onSelect}
			/>
			<TableDetailsSuggestion table={table} />
		</Box>
	);
}
