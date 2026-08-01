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
			c="dimmed"
			style={{ textTransform: "uppercase", letterSpacing: 0.5, fontSize: 9.5 }}
		>
			{prefix !== undefined ? `${prefix} ` : ""}
			{children}
		</Text>
	);
}
