import { Text } from "@mantine/core";

/**
 * Titre de section interne au drawer TableDetails — UPPERCASE, dimmed,
 * accepte un préfixe (`→`, `←`) pour marquer sens des relations.
 */
export function SectionTitle({
	children,
	prefix
}: {
	readonly children: React.ReactNode;
	readonly prefix?: string;
}) {
	return (
		<Text
			px={12}
			pt={10}
			pb={4}
			size="xs"
			fw={700}
			// c="dimmed" retombait sur slate-6 (mid-gray) — sur dark ça manque
			// de contraste avec les rows dessous. text-tertiary garde le rôle
			// de titre secondaire sans surinformer.
			style={{
				textTransform: "uppercase",
				letterSpacing: 0.5,
				fontSize: 9.5,
				color: "var(--sqlnest-text-tertiary)"
			}}
		>
			{prefix !== undefined ? `${prefix} ` : ""}
			{children}
		</Text>
	);
}
