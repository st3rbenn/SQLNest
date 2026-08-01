import { Text } from "@mantine/core";
import { RowItem } from "@sqlnest/design-system";
import { colorFor } from "../colors";
import type { Relation } from "../schema-model";
import { SectionTitle } from "./SectionTitle";

interface TableDetailsRelationsProps {
	readonly outgoing: readonly Relation[];
	readonly incoming: readonly Relation[];
	readonly onSelect: (id: string) => void;
}

/**
 * Sections RÉFÉRENCES (sortantes) et RÉFÉRENCÉE PAR (entrantes) du drawer.
 * Chaque row est un `RowItem` cliquable qui navigue vers la table pointée.
 * Vide → message italique « Aucune relation connue ».
 */
export function TableDetailsRelations({
	outgoing,
	incoming,
	onSelect
}: TableDetailsRelationsProps) {
	const totalRelations = outgoing.length + incoming.length;

	return (
		<>
			{outgoing.length > 0 ? (
				<>
					<SectionTitle prefix="→">Références</SectionTitle>
					{outgoing.map((r, i) => (
						<RowItem
							// biome-ignore lint/suspicious/noArrayIndexKey: relation identity is (from,to,fields) — index suffices here
							key={`out-${i}`}
							label={`${r.from.fields.join(",")} → ${r.to.collection}.${r.to.fields.join(",")}`}
							color={colorFor(r.to.collection).border}
							onClick={() => onSelect(r.to.collection)}
							title={`Aller à ${r.to.collection}`}
							size="sm"
							monospace
						/>
					))}
				</>
			) : null}

			{incoming.length > 0 ? (
				<>
					<SectionTitle prefix="←">Référencée par</SectionTitle>
					{incoming.map((r, i) => (
						<RowItem
							// biome-ignore lint/suspicious/noArrayIndexKey: relation identity is (from,to,fields) — index suffices here
							key={`in-${i}`}
							label={`${r.from.collection}.${r.from.fields.join(",")} → ${r.to.fields.join(",")}`}
							color={colorFor(r.from.collection).border}
							onClick={() => onSelect(r.from.collection)}
							title={`Aller à ${r.from.collection}`}
							size="sm"
							monospace
						/>
					))}
				</>
			) : null}

			{totalRelations === 0 ? (
				<Text px={12} py={8} size="xs" c="dimmed" fs="italic">
					Aucune relation connue.
				</Text>
			) : null}
		</>
	);
}
