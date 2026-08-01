import { Box, Text, UnstyledButton } from "@mantine/core";
import { showNotification } from "@sqlnest/design-system";
import type { Collection } from "../schema-model";
import { SectionTitle } from "./SectionTitle";

interface TableDetailsSuggestionProps {
	readonly table: Collection;
}

/**
 * Section SUGGESTION IA — placeholder cliquable qui affiche une requête
 * heuristique (`get X | count`) et notifie « Bientôt disponible ». À brancher
 * au vrai moteur IA plus tard.
 */
export function TableDetailsSuggestion({ table }: TableDetailsSuggestionProps) {
	return (
		<>
			<SectionTitle>Suggestion IA</SectionTitle>
			<Box px={12} pb={12}>
				<UnstyledButton
					onClick={() =>
						showNotification({
							title: "Insérer la requête suggérée",
							message: "Bientôt disponible.",
							color: "amber",
							autoClose: 2000
						})
					}
					style={{
						display: "block",
						width: "100%",
						padding: 10,
						borderRadius: 8,
						background: "var(--sqlnest-accent-soft)",
						border: "1px solid var(--sqlnest-accent)",
						textAlign: "left",
						cursor: "pointer",
						transition: "background 120ms ease-out"
					}}
				>
					<Text
						size="xs"
						fw={600}
						mb={4}
						style={{ color: "var(--sqlnest-accent)" }}
					>
						+ Requête suggérée
					</Text>
					<Text
						size="xs"
						ff="var(--mantine-font-family-monospace)"
						style={{
							lineHeight: 1.5,
							fontSize: 10.5,
							color: "var(--sqlnest-text-secondary)"
						}}
					>
						{`get ${table.name}${suggestPredicate(table)} | count`}
					</Text>
				</UnstyledButton>
			</Box>
		</>
	);
}

/**
 * Heuristique très simple pour la requête placeholder — utilise le 1er champ
 * bool trouvé comme prédicat. Sera remplacée par la vraie suggestion IA.
 */
function suggestPredicate(table: Collection): string {
	const boolField = table.fields.find((f) => f.type === "bool");
	if (boolField !== undefined) return ` | where ${boolField.name} = true`;
	return "";
}
