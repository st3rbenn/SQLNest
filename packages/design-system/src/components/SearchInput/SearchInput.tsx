import { TextInput, type TextInputProps } from "@mantine/core";

export type SearchInputProps = Omit<TextInputProps, "type" | "leftSection">;

const SearchIcon = () => (
	<svg
		width={14}
		height={14}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth={2}
	>
		<title>Rechercher</title>
		<circle cx={11} cy={11} r={7} />
		<path d="M20 20l-3-3" />
	</svg>
);

/**
 * Champ de recherche minimaliste — TextInput Mantine + loupe à gauche.
 * `styles` alignés sur les tokens DS : input sur surface plus sombre
 * que le drawer parent (contraste léger mais visible).
 */
export function SearchInput(props: SearchInputProps) {
	return (
		<TextInput
			type="search"
			size="sm"
			radius="sm"
			leftSection={<SearchIcon />}
			styles={{
				input: {
					background: "var(--sqlnest-surface-hover)",
					borderColor: "var(--sqlnest-border)",
					color: "var(--sqlnest-text-primary)",
				},
				section: {
					color: "var(--sqlnest-text-tertiary)",
				},
			}}
			{...props}
		/>
	);
}
